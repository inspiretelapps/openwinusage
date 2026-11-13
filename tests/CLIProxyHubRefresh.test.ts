import { describe, expect, it } from 'vitest'
import { CLIProxyHub, HubLogin } from '@core/models/CLIProxyHub'
import { ClaudeUsageClient } from '@core/providers/claude/ClaudeUsageClient'
import { CLIProxyHubClient, CLIProxyHubGate } from '@core/services/CLIProxyHubClient'
import { CLIProxyHubSync } from '@core/stores/CLIProxyHubSync'
import { asObject, bodyText } from '@core/support/ProviderParse'
import { InMemoryHubKeyVault } from './CLIProxyHubSupport'
import { HeldResponse, InMemoryCredentialVault, RoutingHTTPClient, TestSwitch, isolatedDefaults, jsonResponse } from './TestSupport'
import { containerForTesting, makeAccountStore } from './support/accountHelpers'

const hubURL = 'http://mini.local:8317'

/**
 * Entries of `GET /v0/management/auth-files` as CLIProxyAPI v8.0.63 answered it on Nov 10: two files
 * that aren't logins, an enabled Muse login, and disabled Kimi and Cursor logins. The emails are
 * replaced and the counters, timestamps, and file paths left out.
 */
const unsupportedEntries = `
{"auth_index":"3edc842ac8e034cf","disabled":false,"id":"local-models/catalog.json","label":"","name":"local-models/catalog.json","provider":"unknown","runtime_only":false,"source":"file","status":"active","status_message":"","type":"unknown","unavailable":false},
{"auth_index":"4ca51a96a2f1c5d6","disabled":false,"id":"backups/update-8.0.63.RLlo/catalog.json","label":"","name":"backups/update-8.0.63.RLlo/catalog.json","provider":"unknown","runtime_only":false,"source":"file","status":"active","status_message":"","type":"unknown","unavailable":false},
{"account":"muse@example.com","account_type":"oauth","auth_index":"e90ea27f261750d3","disabled":false,"email":"muse@example.com","id":"meta-muse_example.com-0bcedfbaf471c6a0.json","label":"muse@example.com","name":"meta-muse_example.com-0bcedfbaf471c6a0.json","provider":"meta","runtime_only":false,"source":"file","status":"active","status_message":"","type":"meta","unavailable":false},
{"account":"off@example.com","account_type":"oauth","auth_index":"3038d2832263d804","disabled":true,"email":"off@example.com","id":"kimi-off@example.com.json","label":"off@example.com","name":"kimi-off@example.com.json","provider":"kimi","runtime_only":false,"source":"file","status":"disabled","status_message":"","type":"kimi","unavailable":false},
{"account_type":"oauth","auth_index":"9582d66673ee55f8","disabled":true,"id":"cursor-cbb1d1ac0ce52e35","label":"Cursor","name":"cursor.json","provider":"cursor","quota_provider":"cursor","runtime_only":false,"source":"file","status":"disabled","status_message":"","supports_quota":true,"type":"cursor","unavailable":false}
`

function claude(disabled: boolean): string {
  return `{"account":"alice@example.com","account_type":"oauth","auth_index":"b799da203df01af5","disabled":${disabled},"email":"alice@example.com","id":"claude-alice@example.com.json","label":"alice@example.com","name":"claude-alice@example.com.json","provider":"claude","status":"active","type":"claude"}`
}

function listing(...entries: string[]): string {
  return '{"files":[' + entries.join(',') + ']}'
}

function storeWithMirroredClaude(): { store: ReturnType<typeof makeAccountStore>; hub: CLIProxyHub } {
  const store = makeAccountStore({ vault: new InMemoryCredentialVault(), hubKeys: new InMemoryHubKeyVault() })
  const hub = CLIProxyHub.make(hubURL)
  store.addHub(hub, 'mgmt-key')
  store.mirror(HubLogin.listing(listing(claude(false))), hub.id)
  return { store, hub }
}

/**
 * Refresh re-reads every hub before it reads usage and ignores a second press while it runs, and the
 * hub row counts only enabled logins the app can't mirror.
 */
describe('CLIProxyHubRefreshTests', () => {
  it('testRefreshDropsALoginTurnedOffOnTheHubBeforeReadingUsage', async () => {
    const disabled = new TestSwitch(false)
    const http = new RoutingHTTPClient(() => jsonResponse(listing(claude(disabled.value))))
    const { store, hub } = storeWithMirroredClaude()
    expect(store.accountsOnHub(hub.id).length).toBe(1)
    const container = containerForTesting(store, isolatedDefaults(), http)
    await container.hubs.syncDue(0)

    disabled.value = true
    const before = http.requests.length
    await container.refreshNow()

    expect(store.accountsOnHub(hub.id).length, 'the login turned off on the hub is gone after Refresh').toBe(0)
    const paths = http.requests.slice(before).map((request) => new URL(request.url).pathname)
    expect(paths, "Refresh read the hub's list and sent no usage read for the gone login").toEqual(['/v0/management/auth-files'])
  })

  it('testARefreshPressedWhileOneRunsSendsNoSecondUsageRead', async () => {
    // Upstream holds the listing for 200 ms and checks after 50 ms; here the listing is held until released.
    const listingRead = new HeldResponse()
    const http = new RoutingHTTPClient(async (request) => {
      if (new URL(request.url).pathname === '/v0/management/auth-files') await listingRead.hold()
      return jsonResponse(listing(claude(false)))
    })
    const { store } = storeWithMirroredClaude()
    const container = containerForTesting(store, isolatedDefaults(), http)

    const first = container.refreshNow()
    await listingRead.waitUntilHeld()
    expect(container.isRefreshingNow, 'the footer shows Updating… while the hub is read').toBe(true)
    await container.refreshNow()
    listingRead.release()
    await first

    const usageReads = http.requests.filter((request) => {
      let call: unknown
      try {
        call = JSON.parse(bodyText(request.body ?? new Uint8Array()))
      } catch {
        call = undefined
      }
      return asObject(call)?.url === ClaudeUsageClient.usageURL
    })
    expect(usageReads.length, 'the second press joined nothing and read nothing').toBe(1)
    expect(container.isRefreshingNow).toBe(false)
  })

  it('testTheHubCountsOnlyEnabledLoginsOpenUsageCantMirror', async () => {
    const http = new RoutingHTTPClient(() => jsonResponse(listing(claude(false), unsupportedEntries)))
    const store = makeAccountStore({ vault: new InMemoryCredentialVault(), hubKeys: new InMemoryHubKeyVault() })
    const sync = new CLIProxyHubSync(store, new CLIProxyHubClient(http, new CLIProxyHubGate()), true)

    await sync.connect('http://mini.local:8317', 'mgmt-key')

    const hub = store.hubs[0]
    expect(hub).toBeDefined()
    expect(store.accountsOnHub(hub.id).map((account) => account.kind)).toEqual(['claude'])
    expect(sync.status(hub.id), "only the enabled Muse login counts; disabled logins and the hub's own files don't").toEqual({
      type: 'synced',
      unsupported: 1
    })
  })
})
