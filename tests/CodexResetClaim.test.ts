import { describe, expect, it } from 'vitest'
import { Account, AccountCredential, OAuthTokens } from '@core/models/Account'
import { NetworkError, ProviderSnapshot, type RefreshResult } from '@core/models/ProviderSnapshot'
import { AccountProviderRuntime } from '@core/providers/AccountProviderRuntime'
import { claimCodexResetCredit } from '@core/providers/codex/AccountProviderRuntime+CodexResets'
import { CodexUsageClient } from '@core/providers/codex/CodexUsageClient'
import { CodexUsageMapper } from '@core/providers/codex/CodexUsageMapper'
import { CodexLogin } from '@core/services/BrowserProviderLogins'
import { HTTPResponse, type HTTPRequest } from '@core/services/HTTPClient'
import { ResetClaimOutcome } from '@core/services/ResetClaimService'
import { OpenUsageISO8601 } from '@core/support/OpenUsageISO8601'
import { bodyText, ProviderParse, type JSONObject } from '@core/support/ProviderParse'
import { addSeconds, toUnixSeconds, type Instant } from '@core/support/time'
import { InMemoryCredentialVault, RoutingHTTPClient, TestSwitch, unix } from './TestSupport'

const expiry = unix(1_800_000_000)

function listBody(expiringAt: Instant = expiry, status = 'available'): string {
  return `
        {"credits": [
            {"id": "RateLimitResetCredit_other", "status": "available",
             "expires_at": "${OpenUsageISO8601.string(addSeconds(expiringAt, 999_999))}"},
            {"id": "RateLimitResetCredit_target", "status": "${status}",
             "expires_at": "${OpenUsageISO8601.string(expiringAt)}"}
        ], "available_count": 2}
        `
}

function consumeBody(code: string): string {
  return `{"code": "${code}", "windows_reset": 2}`
}

const defaultCredential = AccountCredential.oauth(OAuthTokens.make('token-123', undefined, undefined, { chatgpt_account_id: 'acct-456' }))

/** Pass `null` for an account with no stored sign-in. */
function makeRuntime(http: RoutingHTTPClient, credential: AccountCredential | null = defaultCredential): AccountProviderRuntime {
  const account = Account.make({ kind: 'codex', label: 'Work' })
  const vault = new InMemoryCredentialVault()
  if (credential) vault.save(credential, account.id)
  return new AccountProviderRuntime(account, vault, http)
}

/** `unexpected` collects the requests no test expects: `XCTFail("unexpected request: …")`. */
function makeHTTP(unexpected: string[], listStatus = 200, consumeStatus = 200, consumeAnswer: string = consumeBody('reset')): RoutingHTTPClient {
  return new RoutingHTTPClient((request) => {
    switch (request.url) {
      case CodexUsageClient.resetCreditsURL:
        return new HTTPResponse(listStatus, {}, listBody())
      case CodexUsageClient.consumeResetCreditURL:
        return new HTTPResponse(consumeStatus, {}, consumeAnswer)
      default:
        unexpected.push(request.url)
        return new HTTPResponse(500)
    }
  })
}

function jsonObject(text: string): JSONObject {
  const body = ProviderParse.jsonObject(text)
  if (!body) throw new Error('the fixture is not a JSON object')
  return body
}

function payload(request: HTTPRequest | undefined): Record<string, string> {
  if (!request?.body) throw new Error('the request has no body')
  return JSON.parse(bodyText(request.body)) as Record<string, string>
}

/** `try result.get()` */
function get(result: RefreshResult): ProviderSnapshot {
  if (!result.ok) throw new Error(result.failure.message)
  return result.snapshot
}

const urls = (http: RoutingHTTPClient): string[] => http.requests.map((request) => request.url)

describe('CodexResetClaimTests', () => {
  it('testConsumeOutcomeDecodesAllProtocolCodes', () => {
    const outcome = (code: string, status = 200): ResetClaimOutcome =>
      CodexUsageMapper.resetClaimOutcome(new HTTPResponse(status, {}, consumeBody(code)))
    expect(outcome('reset')).toEqual(ResetClaimOutcome.success)
    // The idempotency key already spent this credit on a lost-response retry, so it's still a success.
    expect(outcome('already_redeemed')).toEqual(ResetClaimOutcome.success)
    expect(outcome('nothing_to_reset')).toEqual(ResetClaimOutcome.nothingToReset)
    expect(outcome('no_credit')).toEqual(ResetClaimOutcome.noCredit)
    expect(outcome('something_new')).toEqual(ResetClaimOutcome.failed('refused'))
    expect(outcome('reset', 500)).toEqual(ResetClaimOutcome.failed('refused'))
    expect(outcome('reset', 401)).toEqual(ResetClaimOutcome.failed('signInExpired'))
    expect(CodexUsageMapper.resetClaimOutcome(new HTTPResponse(200, {}, 'not json'))).toEqual(ResetClaimOutcome.failed('refused'))
  })

  it('testCreditMatchingByExpiry', () => {
    const body = jsonObject(listBody())
    expect(CodexUsageMapper.resetCreditID(body, expiry)).toBe('RateLimitResetCredit_target')
    expect(CodexUsageMapper.resetCreditID(body, addSeconds(expiry, 0.5))).toBe('RateLimitResetCredit_target')
    expect(CodexUsageMapper.resetCreditID(body, addSeconds(expiry, 3600))).toBeUndefined()
  })

  it('testCreditMatchingSkipsNonAvailableStatusButKeepsMissingStatus', () => {
    const redeemed = jsonObject(listBody(expiry, 'redeemed'))
    expect(CodexUsageMapper.resetCreditID(redeemed, expiry)).toBeUndefined()

    const noStatus = jsonObject(`{"credits": [{"id": "RateLimitResetCredit_bare", "expires_at": ${toUnixSeconds(expiry)}}]}`)
    expect(CodexUsageMapper.resetCreditID(noStatus, expiry)).toBe('RateLimitResetCredit_bare')
  })

  it('testClaimMatchesCreditAndConsumesItWithTheAccountsLogin', async () => {
    const unexpected: string[] = []
    const http = makeHTTP(unexpected)
    const runtime = makeRuntime(http)

    const outcome = await claimCodexResetCredit(runtime, expiry, 'redeem-1')

    expect(outcome).toEqual(ResetClaimOutcome.success)
    expect(urls(http)).toEqual([CodexUsageClient.resetCreditsURL, CodexUsageClient.consumeResetCreditURL])
    expect(http.requests.map((request) => request.headers?.['Authorization'])).toEqual(['Bearer token-123', 'Bearer token-123'])
    expect(http.requests.map((request) => request.headers?.['ChatGPT-Account-Id'])).toEqual(['acct-456', 'acct-456'])
    expect(http.requests.at(-1)?.method).toBe('POST')
    expect(http.requests.at(-1)?.headers?.['Content-Type']).toBe('application/json')
    const sent = payload(http.requests.at(-1))
    // the freshly matched id, by expiry
    expect(sent.credit_id).toBe('RateLimitResetCredit_target')
    // the caller's idempotency key, verbatim
    expect(sent.redeem_request_id).toBe('redeem-1')
    expect(unexpected).toEqual([])
  })

  it('testAClaimRefusedWithACutShortTokenRenewsTheSignInOnceAndRetries', async () => {
    const http = new RoutingHTTPClient((request) => {
      if (request.url === CodexLogin.tokenURL) return new HTTPResponse(200, {}, '{"access_token":"token-new","refresh_token":"refresh-new"}')
      if (request.headers?.['Authorization'] === 'Bearer token-123') return new HTTPResponse(401)
      if (request.url === CodexUsageClient.resetCreditsURL) return new HTTPResponse(200, {}, listBody())
      return new HTTPResponse(200, {}, consumeBody('reset'))
    })
    const runtime = makeRuntime(
      http,
      AccountCredential.oauth(OAuthTokens.make('token-123', 'refresh-123', undefined, { chatgpt_account_id: 'acct-456' }))
    )

    const outcome = await claimCodexResetCredit(runtime, expiry, 'redeem-1')

    expect(outcome).toEqual(ResetClaimOutcome.success)
    expect(urls(http)).toEqual([
      CodexUsageClient.resetCreditsURL,
      CodexLogin.tokenURL,
      CodexUsageClient.resetCreditsURL,
      CodexUsageClient.consumeResetCreditURL
    ])
    expect(http.requests.at(-1)?.headers?.['Authorization']).toBe('Bearer token-new')
  })

  it('testClaimFailuresCollapseToFriendlyOutcomes', async () => {
    const unexpected: string[] = []
    const noRequests = new RoutingHTTPClient((request) => {
      // no request should be sent without a credential
      unexpected.push(request.url)
      return new HTTPResponse(500)
    })
    const cases: { name: string; runtime: AccountProviderRuntime; expected: ResetClaimOutcome }[] = [
      { name: 'list down', runtime: makeRuntime(makeHTTP(unexpected, 503)), expected: ResetClaimOutcome.failed('refused') },
      { name: 'list rejected', runtime: makeRuntime(makeHTTP(unexpected, 401)), expected: ResetClaimOutcome.failed('signInExpired') },
      { name: 'consume down', runtime: makeRuntime(makeHTTP(unexpected, 200, 500, 'gateway error')), expected: ResetClaimOutcome.failed('refused') },
      { name: 'signed out', runtime: makeRuntime(noRequests, null), expected: ResetClaimOutcome.failed('signInExpired') }
    ]

    for (const entry of cases) {
      const outcome = await claimCodexResetCredit(entry.runtime, expiry, 'redeem-1')
      expect(outcome, entry.name).toEqual(entry.expected)
    }
    expect(unexpected).toEqual([])
  })

  it('testLostConsumeAnswerIsRetriedWithTheSameKeyAndCredit', async () => {
    const consumed = new TestSwitch(false)
    const unexpected: string[] = []
    const http = new RoutingHTTPClient((request) => {
      switch (request.url) {
        case CodexUsageClient.resetCreditsURL:
          return new HTTPResponse(200, {}, consumed.value ? '{"credits": [], "available_count": 0}' : listBody())
        case CodexUsageClient.consumeResetCreditURL:
          if (!consumed.value) {
            consumed.value = true
            throw new NetworkError('The network connection was lost.')
          }
          return new HTTPResponse(200, {}, consumeBody('already_redeemed'))
        default:
          unexpected.push(request.url)
          return new HTTPResponse(500)
      }
    })
    const runtime = makeRuntime(http)

    const first = await claimCodexResetCredit(runtime, expiry, 'redeem-1')
    const retry = await claimCodexResetCredit(runtime, expiry, 'redeem-1')

    expect(first).toEqual(ResetClaimOutcome.failed('connection'))
    // already_redeemed proves the original claim landed
    expect(retry).toEqual(ResetClaimOutcome.success)
    // the replay skips matching
    expect(urls(http).filter((url) => url === CodexUsageClient.resetCreditsURL).length).toBe(1)
    const sent = payload(http.requests.at(-1))
    // the originally matched credit id
    expect(sent.credit_id).toBe('RateLimitResetCredit_target')
    expect(sent.redeem_request_id).toBe('redeem-1')
    expect(unexpected).toEqual([])
  })

  it('testRefreshReadsEachCreditsExpiryWithTheAccountsLogin', async () => {
    const http = new RoutingHTTPClient((request) => {
      switch (request.url) {
        case CodexUsageClient.usageURL:
          return new HTTPResponse(200, {}, '{"rate_limit_reset_credits":{"available_count":2}}')
        case CodexUsageClient.resetCreditsURL:
          return new HTTPResponse(200, {}, listBody())
        default:
          return new HTTPResponse(404)
      }
    })
    const runtime = makeRuntime(http)

    const snapshot = get(await runtime.refresh())

    const row = ProviderSnapshot.line(snapshot, 'Rate Limit Resets')
    if (row?.type !== 'values') throw new Error('expected the Rate Limit Resets row')
    expect(row.values).toEqual([{ number: 2, kind: 'count', label: 'available' }])
    expect(row.expiriesAt).toEqual([expiry, addSeconds(expiry, 999_999)])
    const creditsRequest = http.requests.find((request) => request.url === CodexUsageClient.resetCreditsURL)
    expect(creditsRequest).toBeDefined()
    expect(creditsRequest?.headers?.['Authorization']).toBe('Bearer token-123')
    expect(creditsRequest?.headers?.['ChatGPT-Account-Id']).toBe('acct-456')
  })

  it('testAClaimThatFindsNoCreditMakesItsRefreshReadTheListAgain', async () => {
    const spent = new TestSwitch(false)
    const http = new RoutingHTTPClient((request) => {
      switch (request.url) {
        case CodexUsageClient.usageURL:
          return new HTTPResponse(200, {}, `{"rate_limit_reset_credits":{"available_count":${spent.value ? 0 : 1}}}`)
        case CodexUsageClient.resetCreditsURL:
          return new HTTPResponse(200, {}, spent.value ? '{"credits": [], "available_count": 0}' : listBody())
        default:
          return new HTTPResponse(404)
      }
    })
    const runtime = makeRuntime(http)
    get(await runtime.refresh())
    spent.value = true

    const outcome = await claimCodexResetCredit(runtime, expiry, 'redeem-1')
    const snapshot = get(await runtime.refresh())

    expect(outcome).toEqual(ResetClaimOutcome.noCredit)
    // no consume POST is ever sent
    expect(urls(http).includes(CodexUsageClient.consumeResetCreditURL)).toBe(false)
    // the pass, the claim, and the claim's refresh
    expect(urls(http).filter((url) => url === CodexUsageClient.resetCreditsURL).length).toBe(3)
    const row = ProviderSnapshot.line(snapshot, 'Rate Limit Resets')
    if (row?.type !== 'values') throw new Error('expected the Rate Limit Resets row')
    expect(row.values).toEqual([{ number: 0, kind: 'count', label: 'available' }])
    expect(row.expiriesAt).toEqual([])
  })

  it('testRefreshFallsBackToTheUsageCountWhenTheCreditListFails', async () => {
    const http = new RoutingHTTPClient((request) => {
      switch (request.url) {
        case CodexUsageClient.usageURL:
          return new HTTPResponse(200, {}, '{"rate_limit_reset_credits":{"available_count":1}}')
        case CodexUsageClient.resetCreditsURL:
          throw new NetworkError('The request timed out.')
        default:
          return new HTTPResponse(404)
      }
    })
    const runtime = makeRuntime(http)

    const snapshot = get(await runtime.refresh())

    const row = ProviderSnapshot.line(snapshot, 'Rate Limit Resets')
    if (row?.type !== 'values') throw new Error('expected the Rate Limit Resets row')
    expect(row.values).toEqual([{ number: 1, kind: 'count', label: 'available' }])
    expect(row.expiriesAt).toEqual([])
  })
})
