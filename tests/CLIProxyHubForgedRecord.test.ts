import { describe, it, expect } from 'vitest'
import { AppContainer } from '@core/app/AppContainer'
import { Account, AccountCredential, OAuthTokens } from '@core/models/Account'
import { CLIProxyHub, HubLink } from '@core/models/CLIProxyHub'
import { CLIProxyHubClient } from '@core/services/CLIProxyHubClient'
import { AccountStore } from '@core/stores/AccountStore'
import { InMemoryHubKeyVault, hubLogin } from './CLIProxyHubSupport'
import { InMemoryCredentialVault, RoutingHTTPClient, isolatedDefaults, jsonResponse } from './TestSupport'

/**
 * With hubs on, a forged hub record that reuses a direct account's id, and a forged hub link, send
 * nothing from the real container: the account's key is never read as the hub's management key.
 */
describe('CLIProxyHubForgedRecordTests', () => {
  it('testAForgedHubAndHubLinkSendNothingFromTheContainer', async () => {
    expect(CLIProxyHub.isEnabled).toBe(true)
    const defaults = isolatedDefaults()
    const vault = new InMemoryCredentialVault()
    const direct = Account.make({ kind: 'openrouter', label: 'Direct' })
    const forgedHub = CLIProxyHub.make('https://attacker.example', direct.id)
    const forgedLogin = hubLogin({ id: 'forged', authIndex: 'forged', provider: 'claude', label: 'forged' })
    const linked = Account.make({ kind: 'claude', label: 'Linked', hub: HubLink.make(forgedHub, forgedLogin) })
    vault.save(AccountCredential.apiKey('sk-or-direct-secret'), direct.id)
    vault.save(AccountCredential.oauth(OAuthTokens.make(CLIProxyHubClient.tokenPlaceholder)), linked.id)
    defaults.set(AccountStore.storageKey, [direct, linked])
    defaults.set(AccountStore.hubsStorageKey, [forgedHub])
    const http = new RoutingHTTPClient(() => jsonResponse('{}'))
    const accounts = new AccountStore({ defaults, vault, hubKeys: new InMemoryHubKeyVault() })
    const container = new AppContainer({ accounts, defaults, http })
    const hostOf = (url: string): string => new URL(url).hostname

    try {
      container.startRefreshing()
      for (let attempt = 0; attempt < 400 && !http.requests.some((request) => hostOf(request.url) === 'openrouter.ai'); attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 5))
      }
      await container.hubs.syncDue(0)
      await container.dataStore.refreshAll(true)

      expect(http.requests.some((request) => hostOf(request.url) === 'openrouter.ai'), 'the direct account still refreshes').toBe(true)
      expect(new Set(http.requests.map((request) => hostOf(request.url))), 'nothing goes to a hub or through a tunnel').toEqual(
        new Set(['openrouter.ai'])
      )
      expect(container.hubs.status(forgedHub.id)).toEqual({
        type: 'failed',
        message: 'The management key for the CLIProxyAPI hub at attacker.example is missing. Replace it in Accounts.'
      })
      accounts.removeHub(forgedHub.id)
      expect(vault.load(direct.id), "removing the hub leaves the account's sign-in").toEqual(AccountCredential.apiKey('sk-or-direct-secret'))
      expect(accounts.accounts.map((account) => account.id)).toEqual([direct.id])
    } finally {
      container.dispose()
    }
  })
})
