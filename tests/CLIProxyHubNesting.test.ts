import { describe, it, expect } from 'vitest'
import { NetworkError } from '@core/models/ProviderSnapshot'
import { CLIProxyHubClient, CLIProxyHubGate } from '@core/services/CLIProxyHubClient'
import { AccountStore } from '@core/stores/AccountStore'
import { CLIProxyHubSync } from '@core/stores/CLIProxyHubSync'
import { InMemoryHubKeyVault } from './CLIProxyHubSupport'
import { InMemoryCredentialVault, RoutingHTTPClient, isolatedDefaults, jsonResponse } from './TestSupport'

/**
 * A CLIProxyAPI hub in Accounts is one row that opens its own page, its accounts are listed only there,
 * and any number of hubs live side by side.
 */
function listing(prefix: string, providers: string[]): string {
  const files = providers.map(
    (provider, index) =>
      `{"id":"${prefix}-${index}","auth_index":"${prefix}-idx-${index}","provider":"${provider}","account_type":"oauth","email":"${prefix}${index}@example.com"}`
  )
  return '{"files":[' + files.join(',') + ']}'
}

/** Serves each hub's login list by host, and refuses every call to a host in `down`. */
function hubs(listings: Record<string, string>, down: Set<string> = new Set()): RoutingHTTPClient {
  return new RoutingHTTPClient((request) => {
    const host = new URL(request.url).hostname
    if (down.has(host)) throw new NetworkError('Could not connect to the server.')
    return jsonResponse(listings[host] ?? '{"files":[]}')
  })
}

describe('CLIProxyHubNestingTests', () => {
  it('testTwoHubsConnectSyncAndRemoveIndependently', async () => {
    const store = new AccountStore({ defaults: isolatedDefaults(), vault: new InMemoryCredentialVault(), hubKeys: new InMemoryHubKeyVault() })
    const http = hubs({
      'mac-mini.local': listing('mini', ['claude', 'codex', 'cursor']),
      'hub.example.com': listing('office', ['claude', 'devin'])
    })
    const sync = new CLIProxyHubSync(store, new CLIProxyHubClient(http, new CLIProxyHubGate()))

    await sync.connect('http://mac-mini.local:8317', 'key-a')
    await sync.connect('https://hub.example.com', 'key-b')

    expect(store.hubs.length).toBe(2)
    const [mini, office] = store.hubs
    expect(store.accountsOnHub(mini.id).map((account) => account.kind)).toEqual(['claude', 'codex'])
    expect(store.accountsOnHub(office.id).map((account) => account.kind)).toEqual(['claude', 'devin'])
    expect(sync.status(mini.id)).toEqual({ type: 'synced', unsupported: 1 })
    expect(sync.status(office.id)).toEqual({ type: 'synced', unsupported: 0 })
    expect(store.hubKeys.load(mini.id)?.key).toBe('key-a')
    expect(store.hubKeys.load(office.id)?.key).toBe('key-b')

    await sync.syncDue(0)
    expect(store.accounts.length, 'reading both hubs again changes nothing').toBe(4)

    sync.remove(mini.id)
    expect(store.hubs.map((hub) => hub.id)).toEqual([office.id])
    expect(store.accounts.map((account) => account.kind), "only the removed hub's accounts go").toEqual(['claude', 'devin'])
    expect(store.hubKeys.load(mini.id)).toBeUndefined()
    expect(store.hubKeys.load(office.id)?.key).toBe('key-b')
  })

  // `PopoverState` is the panel's view state (`src/renderer`), outside `src/core`.
  it.skip('testBackGoesFromAHubAccountToItsHubThenToTheAccountsList', () => {})

  // Renders the SwiftUI dashboard and reads it back with Vision OCR: no port.
  it.skip('testAccountsShowsEachHubAsARowAndItsAccountsOnlyOnItsPage', () => {})
})
