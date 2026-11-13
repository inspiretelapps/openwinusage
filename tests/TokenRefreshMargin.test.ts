import { describe, expect, it } from 'vitest'
import { Account, AccountCredential, OAuthTokens } from '@core/models/Account'
import { AccountProviderRuntime } from '@core/providers/AccountProviderRuntime'
import { HTTPResponse, type HTTPRequest } from '@core/services/HTTPClient'
import { addSeconds, type Seconds } from '@core/support/time'
import { InMemoryCredentialVault, RoutingHTTPClient, unix } from './TestSupport'

describe('TokenRefreshMarginTests', () => {
  const now = unix(1_800_000_000)

  const path = (request: HTTPRequest): string => new URL(request.url).pathname

  async function refreshClaude(seconds: Seconds): Promise<{ http: RoutingHTTPClient; saved: OAuthTokens }> {
    const account = Account.make({ kind: 'claude', label: 'Claude' })
    const vault = new InMemoryCredentialVault()
    vault.save(AccountCredential.oauth(OAuthTokens.make('old-access', 'refresh', addSeconds(now, seconds))), account.id)
    const http = new RoutingHTTPClient((request) => {
      switch (path(request)) {
        case '/v1/oauth/token':
          return new HTTPResponse(200, {}, '{"access_token":"new-access","expires_in":28800}')
        case '/api/oauth/usage':
          return new HTTPResponse(200, {}, '{"five_hour":{"utilization":12}}')
        default:
          return new HTTPResponse(404)
      }
    })
    const result = await new AccountProviderRuntime(account, vault, http, () => now).refresh()
    if (!result.ok) throw new Error(result.failure.message)
    const saved = vault.load(account.id)
    if (saved?.type !== 'oauth') throw new Error('no credential')
    return { http, saved: saved.tokens }
  }

  it('testClaudeTokenExpiringWithinTheMarginIsRefreshedBeforeTheUsageRead', async () => {
    const { http, saved } = await refreshClaude(2 * 60)
    expect(http.requests[0]?.url).toBe('https://platform.claude.com/v1/oauth/token')
    const usage = http.requests.find((request) => path(request) === '/api/oauth/usage')
    expect(usage).toBeDefined()
    expect(usage?.headers?.['Authorization']).toBe('Bearer new-access')
    // the provider's own expiry is stored
    expect(saved.expiresAt).toBe(addSeconds(now, 28_800))
  })
})
