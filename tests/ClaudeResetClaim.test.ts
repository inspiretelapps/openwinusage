import { describe, expect, it } from 'vitest'
import { Account, AccountCredential, OAuthTokens } from '@core/models/Account'
import { NetworkError } from '@core/models/ProviderSnapshot'
import { AccountProviderRuntime } from '@core/providers/AccountProviderRuntime'
import { claimClaudeResetGrant } from '@core/providers/claude/AccountProviderRuntime+ClaudeResets'
import { ClaudeResetGrantStatus } from '@core/providers/claude/ClaudeResetGrantStatus'
import { ClaudeUsageClient } from '@core/providers/claude/ClaudeUsageClient'
import { ClaudeUsageMapper } from '@core/providers/claude/ClaudeUsageMapper'
import { HTTPResponse, type HTTPRequest } from '@core/services/HTTPClient'
import { ResetClaimOutcome } from '@core/services/ResetClaimService'
import { OpenUsageISO8601 } from '@core/support/OpenUsageISO8601'
import { bodyText } from '@core/support/ProviderParse'
import { InMemoryCredentialVault, isClaudeResetGrantsCheck, jsonResponse, RoutingHTTPClient, TestSwitch } from './TestSupport'

const orgUUID = '6a9f1c2e-1b4d-4c3a-9e8f-0123456789ab'
const requestID = '11111111-2222-3333-4444-555555555555'
const grantsBlock = `
        {"eligible":true,"at_limit":false,"grants":[{"id":"opus55-launch-promax-20260921","resets_left":1,
        "ends_at":"2026-10-22T16:00:00+00:00","clears":["five_hour","seven_day"],"paused":false,"usable_now":true,
        "use_requires_limit":false}],"next_grant_id":"opus55-launch-promax-20260921"}
        `

const path = (request: HTTPRequest): string => new URL(request.url).pathname
const isClaim = (request: HTTPRequest): boolean => path(request).endsWith('/reset_rate_limits')
const authorization = (request: HTTPRequest): string | undefined => request.headers?.['Authorization']

function makeHTTP(claim: (request: HTTPRequest) => HTTPResponse, grants: string = grantsBlock): RoutingHTTPClient {
  return new RoutingHTTPClient((request) => {
    switch (path(request)) {
      case '/api/oauth/usage':
        return isClaudeResetGrantsCheck(request)
          ? jsonResponse(`{"cedar_ember":${grants}}`)
          : jsonResponse('{"five_hour":{"utilization":100,"resets_at":"2099-01-01T00:00:00.000Z"}}')
      case '/api/oauth/profile':
        return jsonResponse(`{"account":{"uuid":"acct"},"organization":{"uuid":"${orgUUID}","organization_type":"claude_max"}}`)
      case '/v1/oauth/token':
        return jsonResponse('{"access_token":"token-b","refresh_token":"refresh-b","expires_in":3600}')
      case `/api/organizations/${orgUUID}/reset_rate_limits`:
        return claim(request)
      default:
        return new HTTPResponse(404)
    }
  })
}

/** A claim handler for a test in which no claim may be sent: `XCTFail("must not claim")`. */
function mustNotClaim(sent: string[]): (request: HTTPRequest) => HTTPResponse {
  return (request) => {
    sent.push(request.url)
    return new HTTPResponse(500)
  }
}

async function prime(runtime: AccountProviderRuntime): Promise<void> {
  const result = await runtime.refresh()
  if (!result.ok) throw new Error('the priming refresh failed')
  await runtime.refreshHourlyReads(result.snapshot)
}

function makeRuntimeWithVault(http: RoutingHTTPClient): { runtime: AccountProviderRuntime; vault: InMemoryCredentialVault; account: Account } {
  const account = Account.make({ kind: 'claude', label: 'Work' })
  const vault = new InMemoryCredentialVault()
  vault.save(AccountCredential.oauth(OAuthTokens.make('token-a', 'refresh-a')), account.id)
  return { runtime: new AccountProviderRuntime(account, vault, http), vault, account }
}

function makeRuntime(http: RoutingHTTPClient): AccountProviderRuntime {
  return makeRuntimeWithVault(http).runtime
}

function sentRequestID(request: HTTPRequest): string | undefined {
  if (!request.body) throw new Error('the claim has no body')
  const body = JSON.parse(bodyText(request.body)) as Record<string, unknown>
  return typeof body.request_id === 'string' ? body.request_id : undefined
}

/** The number the resets row shows after the last check. */
function resetsShown(runtime: AccountProviderRuntime): number | undefined {
  const status = runtime.claude.session?.resetGrants.check?.status
  if (!status) throw new Error('expected a reset-grants check')
  const row = ClaudeResetGrantStatus.line(status, Date.now())
  if (row.type !== 'values') throw new Error('expected the resets row')
  return row.values[0]?.number
}

describe('ClaudeResetClaimTests', () => {
  it('testClaimRequestMatchesClaudeCode', async () => {
    const http = new RoutingHTTPClient(() => jsonResponse('{}'))
    await new ClaudeUsageClient(http).claimResetGrant('token-a', orgUUID, 'opus55-launch-promax-20260921', requestID)

    const request = http.requests[0]
    expect(request).toBeDefined()
    expect(request.method).toBe('POST')
    expect(request.url).toBe(`https://api.anthropic.com/api/organizations/${orgUUID}/reset_rate_limits`)
    expect(request.timeout).toBe(25)
    expect(request.headers?.['Authorization']).toBe('Bearer token-a')
    expect(request.headers?.['anthropic-beta']).toBe('oauth-2025-04-20')
    expect(request.headers?.['Content-Type']).toBe('application/json')
    expect(request.headers?.['User-Agent']).toBe('claude-cli/2.1.294 (external, cli)')
    if (!request.body) throw new Error('the claim has no body')
    expect(JSON.parse(bodyText(request.body))).toEqual({
      program: 'cedar_ember',
      grant_id: 'opus55-launch-promax-20260921',
      request_id: requestID
    })
  })

  it('testOutcomeTable', () => {
    const outcome = (json: string, status = 200): ResetClaimOutcome => ClaudeUsageMapper.resetClaimOutcome(new HTTPResponse(status, {}, json))
    const cooldown = OpenUsageISO8601.date('2026-10-18T13:00:00Z')
    expect(cooldown).toBeDefined()
    expect(outcome('{"result":"reset","resets_left":0,"cleared":["five_hour","seven_day"]}')).toEqual(ResetClaimOutcome.success)
    expect(outcome('{"result":"already_used"}')).toEqual(ResetClaimOutcome.success)
    expect(outcome('{"result":"not_limited"}')).toEqual(ResetClaimOutcome.nothingToReset)
    expect(outcome('{"result":"ineligible","reason":"tier"}')).toEqual(ResetClaimOutcome.noCredit)
    for (const reason of ['no_grant', 'unknown_grant', 'not_next_grant']) {
      expect(outcome(`{"result":"unavailable","reason":"${reason}"}`), reason).toEqual(ResetClaimOutcome.noCredit)
    }
    expect(outcome('{"result":"reset_unconfirmed"}')).toEqual(ResetClaimOutcome.unconfirmed)
    expect(outcome('{"result":"unavailable","reason":"stamp_indeterminate"}')).toEqual(ResetClaimOutcome.unconfirmed)
    expect(outcome('{"result":"cooldown","cooldown_until":"2026-10-18T13:00:00Z"}')).toStrictEqual(ResetClaimOutcome.unavailableNow(cooldown))
    expect(outcome('{"result":"unavailable","reason":"paused"}')).toStrictEqual(ResetClaimOutcome.unavailableNow(undefined))
    expect(outcome('{"result":"unavailable","reason":"low_priority_active"}')).toStrictEqual(ResetClaimOutcome.unavailableNow(undefined))
    expect(outcome('{"result":"unavailable","reason":"not_authorized"}')).toEqual(ResetClaimOutcome.failed('refused'))
    expect(outcome('{"result":"something_new"}')).toEqual(ResetClaimOutcome.failed('refused'))
    expect(outcome('not json')).toEqual(ResetClaimOutcome.failed('refused'))
    expect(outcome('{"result":"reset"}', 429)).toEqual(ResetClaimOutcome.failed('refused'))
    expect(outcome('{"result":"reset"}', 500)).toEqual(ResetClaimOutcome.failed('refused'))
    expect(outcome('', 401)).toEqual(ResetClaimOutcome.failed('signInExpired'))
    expect(outcome('', 403)).toEqual(ResetClaimOutcome.failed('signInExpired'))
    const scopeRefusal =
      '{"type":"error","error":{"type":"permission_error","message":"OAuth token does not meet scope requirement user:inference"}}'
    expect(outcome(scopeRefusal, 403)).toEqual(ResetClaimOutcome.failed('notPermitted'))
  })

  it('testStatusParseRejectsBlockWithMalformedGrant', () => {
    expect(ClaudeResetGrantStatus.parse({ eligible: true, grants: [{ resets_left: 1 }] })).toBeUndefined()
    expect(ClaudeResetGrantStatus.parse({ eligible: true, grants: [{ id: 'g' }] })).toBeUndefined()
    expect(ClaudeResetGrantStatus.parse({ eligible: true, grants: ['g'] })).toBeUndefined()
    expect(ClaudeResetGrantStatus.parse({ eligible: true, grants: [{ id: 'g', resets_left: 1 }] })).toBeDefined()
  })

  it('testClaimSpendsNextGrantWithTheAccountsLoginAndUpdatesTheRowFromItsAnswer', async () => {
    const http = makeHTTP(() => jsonResponse('{"result":"reset","resets_left":0,"cleared":["five_hour","seven_day"]}'))
    const runtime = makeRuntime(http)
    await prime(runtime)
    const service = runtime.resetClaimService(async () => 'refreshed')
    if (!service) throw new Error('expected a reset claim service')
    expect(service.isClaimable).toBe(true)
    expect(service.confirmDetail).toBe("Refills your session and weekly limits now. This can't be undone.")
    const readsBefore = http.requests.length

    const outcome = await claimClaudeResetGrant(runtime, requestID)

    expect(outcome).toEqual(ResetClaimOutcome.success)
    const sent = http.requests.slice(readsBefore)
    // no grants or profile read
    expect(sent.map(path)).toEqual([`/api/organizations/${orgUUID}/reset_rate_limits`])
    expect(authorization(sent[0])).toBe('Bearer token-a')
    expect(sentRequestID(sent[0])).toBe(requestID)
    expect(runtime.resetClaimService(async () => 'refreshed')?.isClaimable).toBe(false)
    expect(resetsShown(runtime)).toBe(0)
  })

  it('testAClaimAnswerWithACountTooLargeForAnIntSpendsOneReset', async () => {
    const http = makeHTTP(() => jsonResponse('{"result":"reset","resets_left":1e300}'))
    const runtime = makeRuntime(http)
    await prime(runtime)

    const outcome = await claimClaudeResetGrant(runtime, requestID)

    expect(outcome).toEqual(ResetClaimOutcome.success)
    expect(resetsShown(runtime)).toBe(0)
  })

  it('testAClaimWithoutACachedOrganizationReadsTheProfileOnce', async () => {
    const http = makeHTTP(() => jsonResponse('{"result":"reset","resets_left":0}'))
    const runtime = makeRuntime(http)
    await prime(runtime)
    if (!runtime.claude.session) throw new Error('expected a session')
    runtime.claude.session.organizationUUID = undefined

    await claimClaudeResetGrant(runtime, requestID)
    await claimClaudeResetGrant(runtime, 'second-confirm')

    // the slot's read and one at claim time
    expect(http.requests.filter((request) => path(request) === '/api/oauth/profile').length).toBe(2)
  })

  it('testAClaimRefusedWithACutShortTokenRenewsTheSignInOnceAndRetries', async () => {
    const http = makeHTTP((request) =>
      authorization(request) === 'Bearer token-a' ? new HTTPResponse(401) : jsonResponse('{"result":"reset","resets_left":0}')
    )
    const { runtime, vault, account } = makeRuntimeWithVault(http)
    await prime(runtime)

    const outcome = await claimClaudeResetGrant(runtime, requestID)

    expect(outcome).toEqual(ResetClaimOutcome.success)
    const claims = http.requests.filter(isClaim)
    expect(claims.map(authorization)).toEqual(['Bearer token-a', 'Bearer token-b'])
    expect(claims.map(sentRequestID)).toEqual([requestID, requestID])
    expect(http.requests.filter((request) => path(request) === '/v1/oauth/token').length).toBe(1)
    const saved = vault.load(account.id)
    if (saved?.type !== 'oauth') throw new Error('expected saved tokens')
    expect(saved.tokens.accessToken).toBe('token-b')
  })

  it('testScopeRefusedClaimSaysTheSignInCantUseResetsAndKeepsTheCheck', async () => {
    const refusal =
      '{"type":"error","error":{"type":"permission_error","message":"OAuth token does not meet scope requirement user:inference"}}'
    const http = makeHTTP(() => new HTTPResponse(403, {}, refusal))
    const runtime = makeRuntime(http)
    await prime(runtime)

    const outcome = await claimClaudeResetGrant(runtime, requestID)

    expect(outcome).toEqual(ResetClaimOutcome.failed('notPermitted'))
    expect(http.requests.filter(isClaim).length).toBe(1)
    expect(runtime.claude.session?.resetGrants.check?.status).toBeDefined()
    expect(runtime.claude.session?.resetGrants.unsettledClaim).toBeUndefined()
  })

  it('testRemovedCredentialFailsWithoutSendingAClaim', async () => {
    const claimed: string[] = []
    const http = makeHTTP(mustNotClaim(claimed))
    const { runtime, vault, account } = makeRuntimeWithVault(http)
    await prime(runtime)
    vault.delete(account.id)

    const outcome = await claimClaudeResetGrant(runtime, requestID)

    expect(outcome).toEqual(ResetClaimOutcome.failed('signInExpired'))
    expect(claimed, 'must not claim').toEqual([])
  })

  it('testRetryAfterAnUnsettledClaimReusesItsRequestID', async () => {
    const answer = new TestSwitch('server down')
    const http = makeHTTP(() => {
      switch (answer.value) {
        case 'server down':
          return new HTTPResponse(502)
        case 'throttled':
          return new HTTPResponse(429)
        default:
          return jsonResponse('{"result":"already_used"}')
      }
    })
    const runtime = makeRuntime(http)
    await prime(runtime)

    const first = await claimClaudeResetGrant(runtime, 'first-confirm')
    answer.value = 'throttled'
    const refused = await claimClaudeResetGrant(runtime, 'second-confirm')
    answer.value = 'landed'
    const retry = await claimClaudeResetGrant(runtime, 'reopened-popover')

    expect(first).toEqual(ResetClaimOutcome.failed('refused'))
    expect(refused).toEqual(ResetClaimOutcome.failed('refused'))
    expect(retry).toEqual(ResetClaimOutcome.success)
    const claims = http.requests.filter(isClaim)
    expect(claims.map(sentRequestID)).toEqual(['first-confirm', 'first-confirm', 'first-confirm'])
    expect(runtime.claude.session?.resetGrants.unsettledClaim).toBeUndefined()
  })

  it('testLostAnswerReadsAsConnectionAndKeepsItsRequestID', async () => {
    const lost = new TestSwitch(true)
    const http = makeHTTP(() => {
      if (lost.value) throw new NetworkError('The network connection was lost.')
      return jsonResponse('{"result":"already_used"}')
    })
    const runtime = makeRuntime(http)
    await prime(runtime)

    const first = await claimClaudeResetGrant(runtime, 'first-confirm')
    lost.value = false
    const retry = await claimClaudeResetGrant(runtime, 'second-confirm')

    expect(first).toEqual(ResetClaimOutcome.failed('connection'))
    expect(retry).toEqual(ResetClaimOutcome.success)
    const claims = http.requests.filter(isClaim)
    expect(claims.map(sentRequestID)).toEqual(['first-confirm', 'first-confirm'])
  })

  it('testNoClaimWithoutAClaimableGrant', async () => {
    for (const grants of [
      '{"eligible":false,"ineligible_reason":"tier","grants":[{"id":"g","resets_left":1}],"next_grant_id":"g"}',
      '{"eligible":true,"grants":[{"id":"g","resets_left":1}]}'
    ]) {
      const claimed: string[] = []
      const http = makeHTTP(mustNotClaim(claimed), grants)
      const runtime = makeRuntime(http)
      await prime(runtime)

      expect(runtime.resetClaimService(async () => 'refreshed')?.isClaimable, grants).toBe(false)
      const outcome = await claimClaudeResetGrant(runtime, requestID)
      expect(outcome, grants).toEqual(ResetClaimOutcome.noCredit)
      expect(claimed, 'must not claim').toEqual([])
    }
  })

  it('testMalformedRequestIDIsRefusedBeforeSending', async () => {
    const claimed: string[] = []
    const http = makeHTTP(mustNotClaim(claimed))
    const runtime = makeRuntime(http)
    await prime(runtime)

    const outcome = await claimClaudeResetGrant(runtime, 'not a valid id!')
    expect(outcome).toEqual(ResetClaimOutcome.failed('refused'))
    expect(runtime.claude.session?.resetGrants.check).toBeDefined()
    expect(claimed, 'must not claim').toEqual([])
  })

  it('testRefusedClaimKeepsTheCheck', async () => {
    const http = makeHTTP(() => jsonResponse('{"result":"not_limited","reason":null}'))
    const runtime = makeRuntime(http)
    await prime(runtime)

    const outcome = await claimClaudeResetGrant(runtime, requestID)

    expect(outcome).toEqual(ResetClaimOutcome.nothingToReset)
    // a refused claim changed nothing, so the hourly check stands
    expect(runtime.claude.session?.resetGrants.check?.status).toBeDefined()
  })
})
