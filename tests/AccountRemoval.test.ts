import { describe, expect, it } from 'vitest'
import { Account, AccountCredential, OAuthTokens } from '@core/models/Account'
import { HTTPResponse } from '@core/services/HTTPClient'
import { ProviderSnapshotCache } from '@core/stores/ProviderSnapshotCache'
import { DISTANT_PAST } from '@core/support/time'
import { FailingVault, HeldResponse, InMemoryCredentialVault, RoutingHTTPClient, isolatedDefaults } from './TestSupport'
import { containerForTesting, makeAccountStore } from './support/accountHelpers'

describe('AccountRemovalTests', () => {
  it('testRemovingAnAccountDiscardsItsInFlightTokenRefresh', async () => {
    const defaults = isolatedDefaults()
    const vault = new InMemoryCredentialVault()
    const accounts = makeAccountStore({ defaults, vault })
    const account = accounts.add({
      kind: 'claude',
      label: 'Personal',
      credential: AccountCredential.oauth(OAuthTokens.make('old-access', 'old-refresh', DISTANT_PAST))
    })
    const cardID = Account.cardID(account)
    const network = new HeldResponse()
    const http = new RoutingHTTPClient(async () => {
      await network.hold()
      return new HTTPResponse(200, {}, '{"access_token":"new-access","refresh_token":"rotated-refresh","expires_in":3600}')
    })
    const container = containerForTesting(accounts, defaults, http)
    const dataStore = container.dataStore

    const refresh = dataStore.refresh(cardID, true)
    await network.waitUntilHeld()
    expect([...dataStore.refreshingProviderIDs]).toEqual([cardID])
    expect(http.requests.map((request) => request.url)).toEqual(['https://platform.claude.com/v1/oauth/token'])

    accounts.remove(account.id)

    expect(dataStore.refreshingProviderIDs.size, 'removal cancels the refresh before remove returns').toBe(0)
    network.release()
    const outcome = await refresh

    expect(outcome).toBe('skipped')
    expect(vault.load(account.id), 'the late token response must not recreate the credential').toBeUndefined()
    expect(dataStore.snapshots[cardID]).toBeUndefined()
    expect(dataStore.errorMessage(cardID)).toBeUndefined()
    expect(dataStore.refreshingProviderIDs.size).toBe(0)
    expect(new ProviderSnapshotCache(defaults).load()[cardID]).toBeUndefined()
    expect(accounts.accounts.length).toBe(0)
    expect(container.layout.displayGroups.length).toBe(0)
  })

  it('testAFailedRemovalKeepsTheAccountAndExplainsTheKeychainError', () => {
    // Upstream checks the Keychain's own wording for `errSecInteractionNotAllowed`. There is no Keychain
    // here: the port checks that the account stays and the vault's error is what the store reports.
    const vault = new FailingVault()
    const vaultError = new Error("The app couldn't use its secure storage for this account.")
    vault.deleteError.value = vaultError
    const accounts = makeAccountStore({ vault })
    const account = accounts.add({ kind: 'ollama', label: 'Ollama', credential: AccountCredential.apiKey('key') })

    accounts.remove(account.id)

    expect(accounts.accounts.map((candidate) => candidate.id)).toEqual([account.id])
    expect(accounts.lastError).toBe(vaultError.message)
  })
})
