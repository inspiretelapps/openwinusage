import { describe, expect, it } from 'vitest'
import { Account, AccountCredential, OAuthTokens, type ProviderKind } from '@core/models/Account'
import { NetworkError, ProviderSnapshot, type RefreshFailure, type RefreshFailureKind } from '@core/models/ProviderSnapshot'
import { AccountProviderRuntime } from '@core/providers/AccountProviderRuntime'
import { ProviderError } from '@core/providers/ProviderError'
import { cursorTokens, refreshCursorTokens } from '@core/providers/cursor/AccountProviderRuntime+CursorAuth'
import { CursorUsageClient } from '@core/providers/cursor/CursorUsageClient'
import { AntigravityLogin, ClaudeLogin, CodexLogin } from '@core/services/BrowserProviderLogins'
import { GrokLogin } from '@core/services/DeviceProviderLogins'
import { HTTPResponse } from '@core/services/HTTPClient'
import { bodyText, urlFormEncoded } from '@core/support/ProviderParse'
import { DISTANT_PAST, addSeconds, type Instant, type Seconds } from '@core/support/time'
import { FailingVault, HeldResponse, InMemoryCredentialVault, RoutingHTTPClient, TestSwitch, jsonResponse } from './TestSupport'
import { tick } from './support/accountHelpers'

const quotaURL = 'https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary'
const quotaBody = '{"groups":[{"displayName":"Gemini Models","buckets":[{"bucketId":"gemini-5h","remainingFraction":0.8}]}]}'

async function snapshotOf(runtime: AccountProviderRuntime): Promise<ProviderSnapshot> {
  const result = await runtime.refresh()
  if (!result.ok) throw new Error(result.failure.message)
  return result.snapshot
}

async function failureOf(runtime: AccountProviderRuntime): Promise<RefreshFailure | undefined> {
  const result = await runtime.refresh()
  return result.ok ? undefined : result.failure
}

function oauthOf(credential: AccountCredential | undefined): OAuthTokens | undefined {
  return credential?.type === 'oauth' ? credential.tokens : undefined
}

const pathOf = (url: string): string => new URL(url).pathname

describe('OAuthRefreshPersistenceTests', () => {
  it('testAntigravityRefreshPersistsTheNewAccessTokenAndUsesIt', async () => {
    const account = Account.make({ kind: 'antigravity', label: 'Google' })
    const vault = new InMemoryCredentialVault()
    vault.save(AccountCredential.oauth(OAuthTokens.make('old-access', 'google-refresh', DISTANT_PAST)), account.id)
    const http = new RoutingHTTPClient((request) => {
      switch (request.url) {
        case 'https://oauth2.googleapis.com/token':
          return new HTTPResponse(200, {}, '{"access_token":"new-access","expires_in":3600}')
        case quotaURL:
          return new HTTPResponse(200, {}, quotaBody)
        default:
          return new HTTPResponse(404)
      }
    })
    const runtime = new AccountProviderRuntime(account, vault, http)

    await snapshotOf(runtime)

    const tokenRequest = http.requests.find((request) => new URL(request.url).hostname === 'oauth2.googleapis.com')
    expect(tokenRequest).toBeDefined()
    expect(bodyText(tokenRequest?.body ?? new Uint8Array())).toBe(
      `client_id=${urlFormEncoded(AntigravityLogin.clientID)}&client_secret=${urlFormEncoded(AntigravityLogin.clientSecret)}` +
        '&refresh_token=google-refresh&grant_type=refresh_token'
    )
    const quotaRequests = http.requests.filter((request) => pathOf(request.url).endsWith('retrieveUserQuotaSummary'))
    expect(quotaRequests.length).toBeGreaterThan(0)
    expect(quotaRequests.every((request) => request.headers?.Authorization === 'Bearer new-access')).toBe(true)
    const saved = oauthOf(vault.load(account.id))
    if (!saved) throw new Error('Expected the refreshed OAuth credential in the vault')
    expect(saved.accessToken).toBe('new-access')
    expect(saved.refreshToken).toBe('google-refresh')
    // The provider's own expiry; the refresh margin applies when it is read.
    expect(Math.abs((saved.expiresAt ?? 0) - Date.now() - 3600_000)).toBeLessThanOrEqual(5_000)
  })

  it('testOutageWhileRenewingEarlyKeepsTheStillValidToken', async () => {
    const now = Date.now()
    const account = Account.make({ kind: 'antigravity', label: 'Google' })
    const vault = new InMemoryCredentialVault()
    const stored = AccountCredential.oauth(OAuthTokens.make('old-access', 'google-refresh', addSeconds(now, 120)))
    vault.save(stored, account.id)
    const http = new RoutingHTTPClient((request) => {
      switch (request.url) {
        case 'https://oauth2.googleapis.com/token':
          return new HTTPResponse(503)
        case quotaURL:
          return new HTTPResponse(200, {}, quotaBody)
        default:
          return new HTTPResponse(404)
      }
    })
    const runtime = new AccountProviderRuntime(account, vault, http, () => now)

    await snapshotOf(runtime)

    expect(http.requests.filter((request) => request.url === AntigravityLogin.tokenURL).length).toBe(1)
    const quotaRequests = http.requests.filter((request) => pathOf(request.url).endsWith('retrieveUserQuotaSummary'))
    expect(quotaRequests.length).toBeGreaterThan(0)
    expect(quotaRequests.every((request) => request.headers?.Authorization === 'Bearer old-access')).toBe(true)
    expect(vault.load(account.id)).toEqual(stored)
  })

  it('testAFailedRenewalKeepsTheStoredSignInAndReadsAsItsCause', async () => {
    const cases: { answer: () => HTTPResponse; message: (kind: ProviderKind) => string | undefined; kind?: RefreshFailureKind }[] = [
      { answer: () => jsonResponse('{"error":"invalid_grant"}', 400), message: (kind) => ProviderError.signInExpired(kind).message },
      { answer: () => jsonResponse('{"error":"invalid_grant"}', 401), message: (kind) => ProviderError.signInExpired(kind).message },
      { answer: () => jsonResponse('{"error":"invalid_grant"}', 403), message: (kind) => ProviderError.signInExpired(kind).message },
      {
        answer: () => jsonResponse('{"error":"invalid_request"}', 400),
        message: () => ProviderError.requestFailed(400).message,
        kind: { type: 'refused' }
      },
      {
        answer: () => jsonResponse('<html>Service Unavailable</html>', 503),
        message: () => ProviderError.requestFailed(503).message,
        kind: { type: 'refused' }
      },
      {
        answer: () => new HTTPResponse(429, { 'retry-after': '120' }),
        message: () => ProviderError.rateLimited(120).message,
        kind: { type: 'rateLimited', retryAfter: 120 }
      },
      {
        answer: () => {
          throw new NetworkError()
        },
        message: () => undefined,
        kind: { type: 'unreachable' }
      },
      { answer: () => jsonResponse('{"token_type":"Bearer"}'), message: () => ProviderError.invalidResponse.message }
    ]
    const renewals: [ProviderKind, string][] = [
      ['claude', ClaudeLogin.tokenURL],
      ['codex', CodexLogin.tokenURL],
      ['cursor', CursorUsageClient.refreshURL],
      ['antigravity', AntigravityLogin.tokenURL],
      ['grok', GrokLogin.tokenURL]
    ]
    for (const [index, { answer, message, kind: failureKind }] of cases.entries()) {
      for (const [kind, tokenURL] of renewals) {
        const name = `case ${index} ${kind}`
        const account = Account.make({ kind, label: 'Personal' })
        const vault = new InMemoryCredentialVault()
        const stored = AccountCredential.oauth(OAuthTokens.make('old-access', 'old-refresh', DISTANT_PAST))
        vault.save(stored, account.id)
        const http = new RoutingHTTPClient(() => answer())

        const failure = await failureOf(new AccountProviderRuntime(account, vault, http))

        expect(http.requests.map((request) => request.url), name).toEqual([tokenURL])
        expect(vault.load(account.id), name).toEqual(stored)
        const expected = message(kind)
        if (expected !== undefined) expect(failure?.message, name).toBe(expected)
        if (failureKind) expect(failure?.kind, name).toEqual(failureKind)
      }
    }
  })

  it('testConcurrentRenewalsForOneAccountSendItsRefreshTokenOnce', async () => {
    const account = Account.make({ kind: 'claude', label: 'Claude' })
    const vault = new InMemoryCredentialVault()
    const expired = AccountCredential.oauth(OAuthTokens.make('old-access', 'old-refresh', DISTANT_PAST))
    vault.save(expired, account.id)
    const renewal = new HeldResponse()
    const http = new RoutingHTTPClient(async () => {
      await renewal.hold()
      return jsonResponse('{"access_token":"new-access","refresh_token":"rotated-refresh","expires_in":3600}')
    })
    const runtime = new AccountProviderRuntime(account, vault, http)

    const first = runtime.freshTokens(expired, ClaudeLogin.refresh)
    await renewal.waitUntilHeld()
    const second = runtime.freshTokens(expired, ClaudeLogin.refresh)
    await tick()
    renewal.release()

    const tokens = await Promise.all([first, second])
    expect(tokens.map((token) => token.accessToken)).toEqual(['new-access', 'new-access'])
    expect(http.requests.map((request) => request.url), 'the second caller waits for the first renewal').toEqual([ClaudeLogin.tokenURL])
  })

  it('testALate401AfterAnotherRenewalRetriesWithTheStoredTokens', async () => {
    const account = Account.make({ kind: 'claude', label: 'Claude' })
    const vault = new InMemoryCredentialVault()
    const old = AccountCredential.oauth(OAuthTokens.make('old-access', 'old-refresh'))
    vault.save(old, account.id)
    const http = new RoutingHTTPClient(() => jsonResponse('{"access_token":"new-access","refresh_token":"rotated-refresh","expires_in":3600}'))
    const runtime = new AccountProviderRuntime(account, vault, http)
    const read = async (tokens: OAuthTokens): Promise<HTTPResponse> => jsonResponse('{}', tokens.accessToken === 'old-access' ? 401 : 200)

    await runtime.authorizedRead(old, ClaudeLogin.refresh, read)
    const late = await runtime.authorizedRead(old, ClaudeLogin.refresh, read)

    expect(late.response.statusCode).toBe(200)
    expect(late.tokens.accessToken).toBe('new-access')
    expect(http.requests.map((request) => request.url), 'the old refresh token is sent once').toEqual([ClaudeLogin.tokenURL])
  })

  it('testClaudeIdentityWriteBackKeepsATokenRenewedDuringTheProfileRead', async () => {
    const account = Account.make({ kind: 'claude', label: 'Claude' })
    const vault = new InMemoryCredentialVault()
    vault.save(AccountCredential.oauth(OAuthTokens.make('old-access', 'old-refresh')), account.id)
    const profile = new HeldResponse()
    const http = new RoutingHTTPClient(async (request) => {
      if (pathOf(request.url) !== '/api/oauth/profile') return new HTTPResponse(404)
      await profile.hold()
      return jsonResponse('{"account":{"uuid":"acct"},"organization":{"uuid":"org"}}')
    })
    const runtime = new AccountProviderRuntime(account, vault, http)
    const renewed = OAuthTokens.make('new-access', 'rotated-refresh')

    const hourly = runtime.refreshHourlyReads(ProviderSnapshot.make({ providerID: Account.cardID(account), displayName: 'Claude', lines: [] }))
    await profile.waitUntilHeld()
    vault.save(AccountCredential.oauth(renewed), account.id)
    profile.release()
    await hourly

    const identified: OAuthTokens = { ...renewed, extras: { ...renewed.extras, [OAuthTokens.identityKey]: 'acct/org' } }
    expect(vault.load(account.id)).toEqual(AccountCredential.oauth(identified))
  })

  it('testARenewalTheKeychainRefusesIsUsedAndSavedOnTheNextLoad', async () => {
    const renewals: [ProviderKind, (runtime: AccountProviderRuntime, tokens: OAuthTokens) => Promise<OAuthTokens>][] = [
      ['claude', (runtime, tokens) => runtime.freshTokens(AccountCredential.oauth(tokens), ClaudeLogin.refresh)],
      ['cursor', (runtime, tokens) => refreshCursorTokens(runtime, tokens)]
    ]
    for (const [kind, renew] of renewals) {
      const account = Account.make({ kind, label: 'Personal' })
      const vault = new FailingVault()
      const old = OAuthTokens.make('old-access', 'old-refresh', DISTANT_PAST)
      vault.save(AccountCredential.oauth(old), account.id)
      const http = new RoutingHTTPClient(() => jsonResponse('{"access_token":"new-access","refresh_token":"rotated-refresh","expires_in":3600}'))
      const runtime = new AccountProviderRuntime(account, vault, http)

      // Upstream refuses with the Keychain's `errSecInteractionNotAllowed`; any vault error stands in here.
      vault.updateError.value = new Error('The secure storage is locked.')
      const renewed = await renew(runtime, old)
      vault.updateError.value = undefined
      const next = await runtime.loadCredential()

      expect(renewed.accessToken, kind).toBe('new-access')
      expect(next, `${kind}: the next pass uses the renewed sign-in, not the spent refresh token`).toEqual(AccountCredential.oauth(renewed))
      expect(vault.load(account.id), `${kind}: and saves it once the Keychain takes it`).toEqual(AccountCredential.oauth(renewed))
    }
  })

  it('testAnEarlyRenewalTheProviderRateLimitsWaitsOutItsRetryAfter', async () => {
    const renewals: [ProviderKind, Seconds, (runtime: AccountProviderRuntime, tokens: OAuthTokens) => Promise<OAuthTokens>][] = [
      ['claude', 120, (runtime, tokens) => runtime.freshTokens(AccountCredential.oauth(tokens), ClaudeLogin.refresh)],
      ['cursor', 86_400, (runtime, tokens) => cursorTokens(runtime, AccountCredential.oauth(tokens))]
    ]
    for (const [kind, expiresIn, renew] of renewals) {
      const start = Date.now()
      const clock = new TestSwitch<Instant>(start)
      const account = Account.make({ kind, label: 'Personal' })
      const vault = new InMemoryCredentialVault()
      const current = OAuthTokens.make('old-access', 'old-refresh', addSeconds(start, expiresIn))
      vault.save(AccountCredential.oauth(current), account.id)
      const http = new RoutingHTTPClient(() => new HTTPResponse(429, { 'retry-after': '60' }))
      const runtime = new AccountProviderRuntime(account, vault, http, () => clock.value)

      await renew(runtime, current)
      await renew(runtime, current)
      expect(http.requests.length, `${kind}: no early renewal inside the Retry-After`).toBe(1)
      clock.value = addSeconds(start, 61)
      const tokens = await renew(runtime, current)

      expect(tokens, kind).toEqual(current)
      expect(http.requests.length, `${kind}: asked again once the Retry-After passed`).toBe(2)
    }
  })
})
