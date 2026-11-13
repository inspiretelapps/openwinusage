import { describe, expect, it } from 'vitest'
import { Account } from '@core/models/Account'
import { ProviderSnapshot } from '@core/models/ProviderSnapshot'
import { AccountProviderRuntime } from '@core/providers/AccountProviderRuntime'
import { widgetDescriptors } from '@core/providers/AccountProviderRuntime+Descriptors'
import { ProviderError } from '@core/providers/ProviderError'
import { CodexUsageMapper } from '@core/providers/codex/CodexUsageMapper'
import { CodexLogin } from '@core/services/BrowserProviderLogins'
import { HTTPResponse } from '@core/services/HTTPClient'
import { ProviderSnapshotCache } from '@core/stores/ProviderSnapshotCache'
import { WidgetDataStore } from '@core/stores/WidgetDataStore'
import { WidgetRegistry } from '@core/stores/WidgetRegistry'
import { MetricPeriod } from '@core/support/MetricPeriod'
import { bodyText } from '@core/support/ProviderParse'
import { isolatedDefaults, jsonResponse, RoutingHTTPClient, StubRuntime, unix } from './TestSupport'

describe('CodexUsageClientAndMapperTests', () => {
  it('testRefreshEncodesReservedCharactersInRequestBody', async () => {
    const http = new RoutingHTTPClient(() => jsonResponse('{"access_token":"new-token"}'))

    await CodexLogin.refresh('refresh token&=+/?%', http, Date.now())

    const request = http.requests[0]
    expect(request).toBeDefined()
    expect(request.url).toBe(CodexLogin.tokenURL)
    expect(request.method).toBe('POST')
    if (!request.body) throw new Error('the renewal has no body')
    expect(bodyText(request.body)).toBe(
      `grant_type=refresh_token&client_id=${CodexLogin.clientID}` + '&refresh_token=refresh%20token%26%3D%2B%2F%3F%25'
    )
  })

  it('testRefreshRejectsAnExpiredSession', async () => {
    const http = new RoutingHTTPClient(() => jsonResponse('{"error":{"code":"refresh_token_expired"}}', 400))

    let thrown: unknown
    try {
      await CodexLogin.refresh('refresh', http, Date.now())
    } catch (error) {
      thrown = error
    }
    expect(thrown, 'expected refreshToken to throw').toBeDefined()
    expect(ProviderError.signInExpired('codex').equals(thrown), `expected ProviderError.signInExpired(codex), got ${String(thrown)}`).toBe(true)
  })

  it('testExtraUsageCreditsHideWhileCreditsAreOffAndShowAtZeroWhileOn', () => {
    const account = Account.make({ kind: 'codex', label: 'ChatGPT' })
    const provider = AccountProviderRuntime.provider(account)
    const descriptor = widgetDescriptors(account).find((candidate) => candidate.key === 'credits')
    if (!descriptor) throw new Error('no credits descriptor')
    const cases: [string, number | undefined][] = [
      ['{ "has_credits": false, "balance": "0" }', undefined],
      ['{ "has_credits": false }', undefined],
      ['{ "has_credits": true, "balance": "0" }', 0],
      ['{ "balance": 0 }', 0],
      ['{ "has_credits": true, "balance": "1" }', 1]
    ]
    for (const [credits, balance] of cases) {
      const response = new HTTPResponse(200, {}, `{ "credits": ${credits} }`)
      const usage = CodexUsageMapper.mapUsageResponse(response)
      const snapshot = ProviderSnapshot.forProvider(provider, usage.plan, usage.lines)
      const defaults = isolatedDefaults()
      const cache = new ProviderSnapshotCache(defaults, 'snapshots')
      cache.save({ [provider.id]: snapshot })
      const runtime = StubRuntime.snapshot(provider, [descriptor], snapshot)
      const store = new WidgetDataStore({ registry: WidgetRegistry.from([runtime]), providers: [runtime], cache, defaults })
      const accounts = store.accounts([{ provider, metrics: [descriptor] }])

      expect(descriptor.balance(store.data(descriptor))?.number, credits).toBe(balance)
      expect(accounts[0]?.lines.map((line) => line.descriptor.key), credits).toEqual(balance === undefined ? [] : ['credits'])
    }
  })

  it('testInvalidDedicatedResponsesFallBackToUsageBodyCount', () => {
    const usage = new HTTPResponse(200, {}, '{ "rate_limit_reset_credits": { "available_count": 3 } }')
    const cases: { name: string; response: HTTPResponse | undefined }[] = [
      { name: 'missing', response: undefined },
      { name: 'null count', response: new HTTPResponse(200, {}, '{"available_count":null}') },
      { name: 'server failure', response: new HTTPResponse(500, {}, '<html>oops</html>') }
    ]

    for (const entry of cases) {
      const mapped = CodexUsageMapper.mapUsageResponse(usage, entry.response, unix(1_800_000_000))
      const first = mapped.lines[0]
      if (first?.type !== 'values') throw new Error(`expected reset credits when dedicated response is ${entry.name}`)
      expect(first.values, entry.name).toEqual([{ number: 3, kind: 'count', label: 'available' }])
      expect(first.expiriesAt, entry.name).toEqual([])
    }
  })

  it('testOmitsRateLimitResetsWhenCountMalformed', () => {
    const body = '{ "rate_limit_reset_credits": { "available_count": null } }'
    const mapped = CodexUsageMapper.mapUsageResponse(new HTTPResponse(200, {}, body), undefined, unix(1_800_000_000))

    expect(mapped.lines.find((line) => line.label === 'Rate Limit Resets')).toBeUndefined()
  })

  it('testDropsWindowLengthCountAndCreditsTooLargeForAnInt', () => {
    const body = `
        {"rate_limit":{"primary_window":{"used_percent":42,"limit_window_seconds":1e300}},
         "rate_limit_reset_credits":{"available_count":1e300},"credits":{"balance":1e300}}
        `
    const mapped = CodexUsageMapper.mapUsageResponse(new HTTPResponse(200, {}, body))

    expect(mapped.lines.map((line) => line.label)).toEqual(['Session'])
    const first = mapped.lines[0]
    if (first?.type !== 'progress') throw new Error('expected Session meter')
    expect(first.periodDurationMs).toBe(MetricPeriod.sessionMs)
  })
})
