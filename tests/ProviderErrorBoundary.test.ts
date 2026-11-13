import { describe, it, expect } from 'vitest'
import { Account, AccountCredential, OAuthTokens, ProviderKind } from '@core/models/Account'
import { NetworkError, type RefreshResult } from '@core/models/ProviderSnapshot'
import { AccountProviderRuntime } from '@core/providers/AccountProviderRuntime'
import { ProviderError } from '@core/providers/ProviderError'
import { OpenRouterUsageClient } from '@core/providers/openrouter/OpenRouterUsageClient'
import type { HTTPRequest, HTTPResponse } from '@core/services/HTTPClient'
import { OpenRouterFixtures } from './OpenRouterFixtures'
import { InMemoryCredentialVault, RoutingHTTPClient, jsonResponse } from './TestSupport'

const openCodeUsage =
  '{"usage":{"rolling":{"percent":12,"resetsAt":"2026-07-12T13:30:00Z"},"weekly":{"percent":8,"resetsAt":"2026-07-13T00:00:00Z"},"monthly":{"percent":40,"resetsAt":"2026-08-04T11:18:32Z"}}}'
const ollamaBalance =
  '{"included":{"balance_usd":72.5,"allowance_usd":100,"period":{"from":"2026-09-15T09:30:00Z","until":"2026-10-15T09:30:00Z"}},"purchased":{"balance_usd":25}}'

const keyedKinds: [ProviderKind, AccountCredential][] = [
  ['copilot', AccountCredential.oauth(OAuthTokens.make('token'))],
  ['devin', AccountCredential.oauth(OAuthTokens.make('key'))],
  ['ollama', AccountCredential.apiKey('key')],
  ['opencode', AccountCredential.apiKey('key')],
  ['openrouter', AccountCredential.apiKey('key')],
  ['zai', AccountCredential.apiKey('key')]
]

function refresh(
  kind: ProviderKind,
  handler: (request: HTTPRequest) => HTTPResponse | Promise<HTTPResponse>,
  credential: AccountCredential = AccountCredential.apiKey('key')
): Promise<RefreshResult> {
  const account = Account.make({ kind, label: 'Work' })
  const vault = new InMemoryCredentialVault()
  vault.save(credential, account.id)
  return new AccountProviderRuntime(account, vault, new RoutingHTTPClient(handler)).refresh()
}

const message = (result: RefreshResult): string | undefined => (result.ok ? undefined : result.failure.message)

function snapshot(result: RefreshResult) {
  if (!result.ok) throw new Error(result.failure.message)
  return result.snapshot
}

describe('ProviderErrorBoundaryTests', () => {
  it('testAnUnauthorizedResponseIsARefusedCredentialWhateverTheBodySays', async () => {
    for (const [kind, credential] of keyedKinds) {
      const result = await refresh(kind, () => jsonResponse(openCodeUsage, 401), credential)
      const expected =
        credential.type === 'oauth'
          ? `${ProviderKind.displayName(kind)} sign-in expired. Sign in again to keep reading usage.`
          : `${ProviderKind.displayName(kind)} rejected the API key. Replace it on the account's page.`
      expect(message(result), kind).toBe(expected)
    }
  })

  it('testAMissingKeychainItemSaysHowToFixThatAccount', async () => {
    const accounts: [Account, string][] = [
      [Account.make({ kind: 'claude', label: 'Work' }), 'Claude sign-in expired. Sign in again to keep reading usage.'],
      [Account.make({ kind: 'openrouter', label: 'Work' }), "OpenRouter rejected the API key. Replace it on the account's page."],
      [Account.make({ kind: 'copilot', label: 'acme', organization: 'acme' }), "GitHub rejected the token. Replace it on the account's page."]
    ]
    for (const [account, expected] of accounts) {
      const runtime = new AccountProviderRuntime(account, new InMemoryCredentialVault(), new RoutingHTTPClient(() => jsonResponse('')))
      expect(message(await runtime.refresh())).toBe(expected)
    }
  })

  it('testAServerErrorNamesItsStatus', async () => {
    for (const [kind, credential] of keyedKinds) {
      const result = await refresh(kind, () => jsonResponse('<html>down</html>', 503), credential)
      expect(message(result), kind).toBe(ProviderError.requestFailed(503).message)
    }
  })

  it('testATransportErrorKeepsItsOwnMessage', async () => {
    const offline = new NetworkError('The Internet connection appears to be offline.')
    for (const [kind, credential] of keyedKinds) {
      const result = await refresh(
        kind,
        () => {
          throw offline
        },
        credential
      )
      expect(message(result), kind).toBe(offline.message)
    }
  })

  it('testAFailedPlanLookupCostsThePlanNotTheMeters', async () => {
    const ollama = snapshot(
      await refresh('ollama', (request) => (request.url.endsWith('/api/balance') ? jsonResponse(ollamaBalance) : jsonResponse('{"Plan":"pro"}', 500)))
    )
    expect(ollama.plan).toBeUndefined()
    expect(ollama.lines.map((line) => line.label)).toEqual(['Monthly', 'Purchased Credits'])

    const zai = snapshot(
      await refresh('zai', (request) =>
        request.url.includes('quota') ? jsonResponse('{"data":{"limits":[]}}') : jsonResponse('{"data":{"plan":"GLM Coding Pro"}}', 401)
      )
    )
    expect(zai.plan).toBeUndefined()
  })

  it('testOpenCodeWithoutAGoSubscriptionSaysSo', async () => {
    const result = await refresh('opencode', () =>
      jsonResponse('{"type":"error","error":{"type":"EntitlementError","message":"no subscription"}}', 403)
    )
    expect(message(result)).toBe('No OpenCode Go subscription on this account.')
  })

  it('testOpenRouterShowsTheFailureOfAnyRead', async () => {
    const creditsDown = await refresh('openrouter', (request) =>
      request.url === OpenRouterUsageClient.creditsURL ? jsonResponse('', 503) : OpenRouterFixtures.managementAccount(request)
    )
    expect(message(creditsDown)).toBe(ProviderError.requestFailed(503).message)

    const secondPageDown = await refresh('openrouter', (request) =>
      OpenRouterFixtures.offset(request) === '100' ? jsonResponse('', 503) : OpenRouterFixtures.managementAccount(request)
    )
    expect(message(secondPageDown)).toBe(ProviderError.requestFailed(503).message)

    const unreadable = await refresh('openrouter', () => jsonResponse('{"ok":true}'))
    expect(message(unreadable)).toBe(ProviderError.invalidResponse.message)
  })
})
