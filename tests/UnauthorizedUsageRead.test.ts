import { describe, expect, it } from 'vitest'
import { Account, AccountCredential, OAuthTokens, type ProviderKind } from '@core/models/Account'
import type { RefreshResult } from '@core/models/ProviderSnapshot'
import { AccountProviderRuntime } from '@core/providers/AccountProviderRuntime'
import { ProviderError } from '@core/providers/ProviderError'
import { ClaudeUsageClient } from '@core/providers/claude/ClaudeUsageClient'
import { CodexUsageClient } from '@core/providers/codex/CodexUsageClient'
import { GrokUsageClient } from '@core/providers/grok/GrokUsageClient'
import { ClaudeLogin, CodexLogin } from '@core/services/BrowserProviderLogins'
import { GrokLogin } from '@core/services/DeviceProviderLogins'
import { HTTPResponse } from '@core/services/HTTPClient'
import { addSeconds, type Instant } from '@core/support/time'
import { InMemoryCredentialVault, RoutingHTTPClient, jsonResponse } from './TestSupport'

interface OAuthProvider {
  kind: ProviderKind
  tokenURL: string
  usageURL: string
  usage: string
}

const providers: OAuthProvider[] = [
  {
    kind: 'claude',
    tokenURL: ClaudeLogin.tokenURL,
    usageURL: ClaudeUsageClient.usageURL,
    usage: '{"five_hour":{"utilization":42,"resets_at":"2099-01-01T00:00:00.000Z"}}'
  },
  { kind: 'codex', tokenURL: CodexLogin.tokenURL, usageURL: CodexUsageClient.usageURL, usage: '{"rate_limit":{}}' },
  {
    kind: 'grok',
    tokenURL: GrokLogin.tokenURL,
    usageURL: GrokUsageClient.creditsConfigURL,
    usage:
      '{"config":{"currentPeriod":{"type":"USAGE_PERIOD_TYPE_WEEKLY","start":"2026-06-30T21:36:52+00:00","end":"2026-07-07T21:36:52+00:00"},"creditUsagePercent":40}}'
  }
]

async function refresh(
  provider: OAuthProvider,
  expiresAt: Instant | undefined,
  usage: (attempt: number) => HTTPResponse
): Promise<{ result: RefreshResult; http: RoutingHTTPClient; saved: OAuthTokens | undefined }> {
  const account = Account.make({ kind: provider.kind, label: 'Personal' })
  const vault = new InMemoryCredentialVault()
  vault.save(AccountCredential.oauth(OAuthTokens.make('old-access', 'old-refresh', expiresAt)), account.id)
  let attempts = 0
  const http = new RoutingHTTPClient((request) => {
    switch (request.url) {
      case provider.tokenURL:
        return jsonResponse('{"access_token":"new-access","refresh_token":"rotated-refresh","expires_in":3600}')
      case provider.usageURL:
        attempts += 1
        return usage(attempts)
      default:
        return new HTTPResponse(404)
    }
  })
  const result = await new AccountProviderRuntime(account, vault, http).refresh()
  const stored = vault.load(account.id)
  return { result, http, saved: stored?.type === 'oauth' ? stored.tokens : undefined }
}

const failureMessage = (result: RefreshResult): string | undefined => (result.ok ? undefined : result.failure.message)

/**
 * A usage read the provider answers with 401 renews the sign-in once through the account's own refresh
 * token and is retried with the new access token; a second 401 is the expired sign-in, and no other
 * answer renews.
 */
describe('UnauthorizedUsageReadTests', () => {
  it('testA401RenewsTheSignInOnceAndRetriesTheReadWithTheNewToken', async () => {
    for (const provider of providers) {
      for (const expiresAt of [undefined, addSeconds(Date.now(), 3600)]) {
        const name = `${provider.kind} expiring ${expiresAt === undefined ? 'at an unknown time' : 'in an hour'}`
        const { result, http, saved } = await refresh(provider, expiresAt, (attempt) =>
          attempt === 1 ? new HTTPResponse(401) : jsonResponse(provider.usage)
        )
        expect(failureMessage(result), name).toBeUndefined()
        expect(http.requests.filter((request) => request.url === provider.tokenURL).length, name).toBe(1)
        expect(
          http.requests.filter((request) => request.url === provider.usageURL).map((request) => request.headers?.Authorization),
          name
        ).toEqual(['Bearer old-access', 'Bearer new-access'])
        expect(saved?.accessToken, name).toBe('new-access')
        expect(saved?.refreshToken, name).toBe('rotated-refresh')
      }
    }
  })

  it('testASecondUnauthorizedAnswerIsTheExpiredSignIn', async () => {
    for (const provider of providers) {
      const { result, http, saved } = await refresh(provider, undefined, () => new HTTPResponse(401))
      expect(failureMessage(result), provider.kind).toBe(ProviderError.signInExpired(provider.kind).message)
      expect(
        http.requests.filter((request) => request.url === provider.tokenURL).length,
        `${provider.kind}: renewed once, never in a loop`
      ).toBe(1)
      expect(http.requests.filter((request) => request.url === provider.usageURL).length, provider.kind).toBe(2)
      expect(saved?.accessToken, `${provider.kind}: the grant the provider gave is kept`).toBe('new-access')
    }
  })

  it('testOnlyA401RenewsTheSignIn', async () => {
    for (const provider of providers) {
      for (const status of [403, 429, 500]) {
        const name = `${provider.kind} ${status}`
        const { result, http, saved } = await refresh(provider, undefined, () => new HTTPResponse(status))
        expect(result.ok, name).toBe(false)
        expect(http.requests.filter((request) => request.url === provider.tokenURL).length, name).toBe(0)
        expect(http.requests.filter((request) => request.url === provider.usageURL).length, name).toBe(1)
        expect(saved?.accessToken, name).toBe('old-access')
      }
    }
  })
})
