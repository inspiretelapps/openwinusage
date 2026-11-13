import { describe, expect, it } from 'vitest'
import { Account, AccountCredential } from '@core/models/Account'
import { NetworkError } from '@core/models/ProviderSnapshot'
import { AccountProviderRuntime } from '@core/providers/AccountProviderRuntime'
import { claimZAIReset } from '@core/providers/zai/AccountProviderRuntime+ZAIResets'
import { ZAIReset, ZAIResetsMapper } from '@core/providers/zai/ZAIResets'
import { ZAIUsageClient } from '@core/providers/zai/ZAIUsageClient'
import type { HTTPRequest, HTTPResponse } from '@core/services/HTTPClient'
import { ResetClaimOutcome } from '@core/services/ResetClaimService'
import { bodyText } from '@core/support/ProviderParse'
import { addSeconds, type Instant } from '@core/support/time'
import { InMemoryCredentialVault, iso, jsonResponse, RoutingHTTPClient, unix } from './TestSupport'

/** 2026-11-04 00:00 UTC. */
const now = unix(1_793_750_400)
const quota = `
    {"code":200,"data":{"limits":[
      {"type":"CREDIT_LIMIT","unit":3,"number":5,"percentage":64,"nextResetTime":1793760000000},
      {"type":"CREDIT_LIMIT","unit":6,"number":1,"percentage":38,"nextResetTime":1794100000000}
    ]},"success":true}
    `

/** Session record 11 and Weekly record 21 share an expiry; 13 is spent and 14 has expired. */
const list = `
    {"code":200,"success":true,"data":{
      "fiveHourResets":[
        {"recordId":12,"available":true,"expireTime":"2026-11-10 08:00:00","grantType":"GLOBAL"},
        {"recordId":11,"available":true,"expireTime":"2026-11-06 20:00:00","grantType":"GLOBAL"},
        {"recordId":13,"available":false,"expireTime":"2026-11-07 08:00:00","grantType":"GLOBAL"},
        {"recordId":14,"available":true,"expireTime":"2026-11-03 08:00:00","grantType":"GLOBAL"}
      ],
      "weekResets":[{"recordId":21,"available":true,"expireTime":"2026-11-06 20:00:00","grantType":"GLOBAL"}]
    }}
    `

function utc(text: string): Instant {
  return iso(text)
}

const session11 = ZAIReset.make('FIVE_HOUR', 11, utc('2026-11-06T12:00:00Z'), 'GLOBAL')
const weekly21 = ZAIReset.make('WEEK', 21, utc('2026-11-06T12:00:00Z'), 'GLOBAL')
const session12 = ZAIReset.make('FIVE_HOUR', 12, utc('2026-11-10T00:00:00Z'), 'GLOBAL')

function makeRuntime(http: RoutingHTTPClient): AccountProviderRuntime {
  const account = Account.make({ kind: 'zai', label: 'Personal' })
  const vault = new InMemoryCredentialVault()
  vault.save(AccountCredential.apiKey('key'), account.id)
  return new AccountProviderRuntime(account, vault, http, () => now)
}

function route(request: HTTPRequest): HTTPResponse {
  switch (request.url) {
    case ZAIUsageClient.quotaURL:
      return jsonResponse(quota)
    case ZAIUsageClient.resetListURL:
      return jsonResponse(list)
    case ZAIUsageClient.useResetURL:
      return jsonResponse('{"code":200,"success":true}')
    default:
      return jsonResponse('{}', 404)
  }
}

describe('ZAIResetTests', () => {
  it('testListKeepsAvailableUnexpiredResetsOfBothWindowsEarliestFirstInUTCPlus8', () => {
    const resets = ZAIResetsMapper.resets(list, now)
    expect(resets).toEqual([session11, weekly21, session12])
  })

  it('testListRejectsAnUnreadableRecordOrAFailedAnswer', () => {
    for (const body of [
      '{"success":true,"data":{"fiveHourResets":[{"recordId":1,"available":true,"expireTime":"2026-11-06T20:00:00Z"}]}}',
      '{"success":true,"data":{"weekResets":[{"available":true,"expireTime":"2026-11-06 20:00:00"}]}}',
      '{"success":true,"data":{"weekResets":[{"recordId":1,"available":true,"expireTime":"2026-11-06 20:00:00"}]}}',
      '{"success":true,"data":{"weekResets":[{"recordId":1,"available":true,"expireTime":"2026-11-06 20:00:00","grantType":""}]}}',
      '{"success":false,"msg":"error","data":null}'
    ]) {
      expect(() => ZAIResetsMapper.resets(body, now), body).toThrow()
    }
  })

  // Needs `RateLimitResetsDetail` (Views), which is not ported yet.
  it.todo('testDetailListsEachWindowApartAndKeysEqualExpiriesApart')

  it('testUseRequestNamesTheExactRecordAndWindow', async () => {
    const http = new RoutingHTTPClient(() => jsonResponse('{"success":true}'))
    await new ZAIUsageClient(http).useReset(weekly21, 'request-1', 'key-1')

    const request = http.requests[0]
    expect(request).toBeDefined()
    expect(request.method).toBe('POST')
    expect(request.url).toBe(ZAIUsageClient.useResetURL)
    expect(request.headers?.Authorization).toBe('Bearer key-1')
    expect(request.headers?.['Content-Type']).toBe('application/json')
    if (request.body === undefined) throw new Error('the request has no body')
    const body: unknown = JSON.parse(bodyText(request.body))
    expect(body).toEqual({ targetType: 'PERSONAL', resetType: 'WEEK', recordId: 21, requestId: 'request-1', grantType: 'GLOBAL' })
  })

  it('testOnlySuccessTrueCountsAsSpent', () => {
    expect(ZAIResetsMapper.claimOutcome(jsonResponse('{"success":true}'))).toEqual(ResetClaimOutcome.success)
    expect(ZAIResetsMapper.claimOutcome(jsonResponse('{"success":false,"msg":"no"}'))).toEqual(ResetClaimOutcome.failed('refused'))
    expect(ZAIResetsMapper.claimOutcome(jsonResponse('{"success":true}', 500))).toEqual(ResetClaimOutcome.failed('refused'))
    expect(ZAIResetsMapper.claimOutcome(jsonResponse('{}', 401))).toEqual(ResetClaimOutcome.failed('signInExpired'))
  })

  it('testRefreshAddsTheResetsRowAndTheClaimServiceListsThem', async () => {
    const runtime = makeRuntime(new RoutingHTTPClient(route))
    const result = await runtime.refresh()
    if (!result.ok) throw new Error(result.failure.message)
    const snapshot = result.snapshot

    expect(snapshot.lines.at(-1)).toEqual(ZAIResetsMapper.line([session11, weekly21, session12]))
    const service = runtime.resetClaimService(async () => 'refreshed')
    if (service === undefined) throw new Error('a Z.ai account has a claim service')
    expect(service.windowResets).toEqual([session11, weekly21, session12])
    expect(service.isClaimable, 'the flat timeline stays read-only').toBe(false)
    expect(runtime.widgetDescriptors.map((descriptor) => descriptor.key)).toEqual(['session', 'weekly', 'webSearches', 'rateLimitResets'])
  })

  it('testAFailedResetListLeavesTheMetersWorking', async () => {
    for (const failure of [jsonResponse('{}', 500), jsonResponse('not json')]) {
      const runtime = makeRuntime(new RoutingHTTPClient((request) => (request.url === ZAIUsageClient.resetListURL ? failure : route(request))))
      const result = await runtime.refresh()
      if (!result.ok) throw new Error(result.failure.message)
      expect(result.snapshot.lines.map((line) => line.label)).toEqual(['Session', 'Weekly'])
    }
  })

  // Needs `AccountStore` and `AppContainer`, which are not ported yet.
  it.todo('testClaimSpendsTheConfirmedRecordOnceAndTheRowDropsIt')

  it('testAStaleRecordIsNeverSpentInPlaceOfAnother', async () => {
    const stale = [
      ZAIReset.make('FIVE_HOUR', 99, session11.expiresAt, 'GLOBAL'),
      session12,
      ZAIReset.make('FIVE_HOUR', 11, addSeconds(session11.expiresAt, 60), 'GLOBAL')
    ]
    for (const confirmed of stale) {
      const http = new RoutingHTTPClient(route)
      const claimRuntime = makeRuntime(http)
      const outcome = await claimZAIReset(claimRuntime, confirmed, 'request-1')
      expect(outcome, JSON.stringify(confirmed)).toEqual(ResetClaimOutcome.noCredit)
      expect(
        http.requests.some((request) => request.url === ZAIUsageClient.useResetURL),
        JSON.stringify(confirmed)
      ).toBe(false)
    }
  })

  it('testALostAnswerIsNotRetried', async () => {
    const http = new RoutingHTTPClient((request) => {
      if (request.url === ZAIUsageClient.useResetURL) throw new NetworkError()
      return route(request)
    })
    const outcome = await claimZAIReset(makeRuntime(http), session11, 'request-1')
    expect(outcome).toEqual(ResetClaimOutcome.failed('connection'))
    expect(http.requests.filter((request) => request.url === ZAIUsageClient.useResetURL).length).toBe(1)
  })
})
