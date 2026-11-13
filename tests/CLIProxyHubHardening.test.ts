import { describe, it, expect } from 'vitest'
import { AppInfo } from '@core/support/AppInfo'
import { CLIProxyHub, HubLink, HubLogin } from '@core/models/CLIProxyHub'
import { NetworkError } from '@core/models/ProviderSnapshot'
import { ProviderCatalog } from '@core/providers/ProviderCatalog'
import { CLIProxyHubClient, CLIProxyHubGate } from '@core/services/CLIProxyHubClient'
import { AccountStore } from '@core/stores/AccountStore'
import { CLIProxyHubSync } from '@core/stores/CLIProxyHubSync'
import { InMemoryHubKeyVault, hubLogin } from './CLIProxyHubSupport'
import { CredentialVaultError, FailingVault, InMemoryCredentialVault, RoutingHTTPClient, isolatedDefaults, jsonResponse } from './TestSupport'

/**
 * What keeps a hub's management key and its mirrored accounts safe from forged preferences, plain http,
 * a short listing, and a failing vault.
 */
const hubURL = 'http://mini.local:8317'

const login = (id: string, provider: string): HubLogin => hubLogin({ id, authIndex: `index-${id}`, provider, label: id })

async function failureMessage(work: Promise<unknown>): Promise<string | undefined> {
  try {
    await work
    return undefined
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
}

describe('CLIProxyHubHardeningTests', () => {
  it('testAKeyGoesOnlyToTheAddressItWasSavedFor', async () => {
    const gate = new CLIProxyHubGate()
    const defaults = isolatedDefaults()
    const vault = new InMemoryCredentialVault()
    const hubKeys = new InMemoryHubKeyVault()
    const hub = CLIProxyHub.make(hubURL)
    const store = new AccountStore({ defaults, vault, hubKeys })
    store.addHub(hub, 'mgmt-key')
    store.mirror([login('a', 'claude')], hub.id)
    const forgedHub = CLIProxyHub.make('https://attacker.example', hub.id, hub.addedAt)
    const account = { ...store.accounts[0], hub: HubLink.make(forgedHub, login('a', 'claude')) }
    defaults.set(AccountStore.hubsStorageKey, [forgedHub])
    defaults.set(AccountStore.storageKey, [account])

    const rewritten = new AccountStore({ defaults, vault, hubKeys })
    const http = new RoutingHTTPClient(() => jsonResponse('{"files":[]}'))
    const sync = new CLIProxyHubSync(rewritten, new CLIProxyHubClient(http, gate), true)
    await sync.syncDue(0)
    const runtimes = ProviderCatalog.make({ accounts: [...rewritten.accounts], vault, hubKeys, http, hubsEnabled: true })
    const result = await runtimes[0].refresh()

    expect(http.requests.length, 'the key never goes to a rewritten address').toBe(0)
    const message =
      'The CLIProxyAPI hub at attacker.example isn’t the address its management key was saved for. Remove the hub and connect it again.'
    expect(sync.status(hub.id)).toEqual({ type: 'failed', message })
    expect(result.ok ? undefined : result.failure.message).toBe(message)
  })

  it('testTheKeyGoesOverHttpOnlyWhenTypedAndOnlyToThisMacOrTheLocalNetwork', async () => {
    const http = new RoutingHTTPClient(() => jsonResponse('{"files":[]}'))
    const store = new AccountStore({ defaults: isolatedDefaults(), vault: new InMemoryCredentialVault(), hubKeys: new InMemoryHubKeyVault() })
    const sync = new CLIProxyHubSync(store, new CLIProxyHubClient(http, new CLIProxyHubGate()), true)

    expect(await failureMessage(sync.connect('http://hub.example.com:8317', 'mgmt-key')), 'plain http to a public name is refused').toBe(
      `Use https for hub.example.com:8317. ${AppInfo.name} uses http only for a hub on this computer, your local network, or Tailscale.`
    )
    expect(http.requests.length).toBe(0)
    expect(store.hubs.length).toBe(0)

    await sync.connect('hub.example.com:8317', 'mgmt-key')
    await sync.connect('http://192.168.1.20:8317', 'mgmt-key')
    expect(http.requests.map((request) => request.url), 'no scheme means https').toEqual([
      'https://hub.example.com:8317/v0/management/auth-files',
      'http://192.168.1.20:8317/v0/management/auth-files'
    ])

    const allowed = [
      'http://127.0.0.1:8317',
      'http://localhost:8317',
      'http://10.0.0.5',
      'http://172.20.1.1',
      'http://169.254.1.1',
      'http://mini.local:8317',
      'http://[::1]:8317',
      'https://hub.example.com'
    ]
    const refused = ['http://hub.example.com', 'http://10.0.0.1.attacker.example', 'http://172.32.0.1', 'http://8.8.8.8', 'ftp://mini.local']
    for (const url of allowed) expect(CLIProxyHub.allowsKey(url), url).toBe(true)
    for (const url of refused) expect(CLIProxyHub.allowsKey(url), url).toBe(false)
  })

  it('testTailscaleHostsGetTheKeyOverHttp', () => {
    const allowed = [
      'http://mini.tail2a0317.ts.net:8317',
      'http://MINI.TAIL2A0317.TS.NET',
      'http://100.64.0.0',
      'http://100.100.20.5:8317',
      'http://100.127.255.255',
      'http://[fd7a:115c:a1e0::1]:8317',
      'http://[fd7a:115c:a1e0:ab12::5]'
    ]
    const refused = [
      'http://100.63.255.255',
      'http://100.128.0.0',
      'http://ts.net',
      'http://evilts.net',
      'http://mini.ts.net.attacker.example',
      'http://[2001:db8::1]:8317',
      'http://100.64.0.1.attacker.example'
    ]
    for (const url of allowed) expect(CLIProxyHub.allowsKey(url), url).toBe(true)
    for (const url of refused) expect(CLIProxyHub.allowsKey(url), url).toBe(false)
  })

  it('testAnHttpsHubThatAnswersOnlyOverHttpSaysToUseHttp', async () => {
    const http = new RoutingHTTPClient((request) => {
      const url = new URL(request.url)
      if (url.protocol !== 'http:') throw new NetworkError('An SSL error has occurred and a secure connection to the server cannot be made.')
      return jsonResponse('CLIProxyAPI Server', url.hostname === '10.0.0.9' ? 400 : 200)
    })
    const store = new AccountStore({ defaults: isolatedDefaults(), vault: new InMemoryCredentialVault(), hubKeys: new InMemoryHubKeyVault() })
    const sync = new CLIProxyHubSync(store, new CLIProxyHubClient(http, new CLIProxyHubGate()), true)

    const cases: [string, string][] = [
      ['https://10.0.0.9:8317', 'Can’t reach the CLIProxyAPI hub at 10.0.0.9:8317.'],
      ['mini.tail2a0317.ts.net:8317', 'This hub doesn’t use https. Try http://mini.tail2a0317.ts.net:8317.'],
      ['https://192.168.1.20:8317', 'This hub doesn’t use https. Try http://192.168.1.20:8317.'],
      ['https://hub.example.com:8317', 'Can’t reach the CLIProxyAPI hub at hub.example.com:8317.']
    ]
    for (const [input, message] of cases) {
      expect(await failureMessage(sync.connect(input, 'mgmt-key')), input).toBe(message)
    }

    const checks = http.requests.filter((request) => request.url.startsWith('http://'))
    expect(checks.map((request) => request.url), 'a public host gets no http request').toEqual([
      'http://10.0.0.9:8317',
      'http://mini.tail2a0317.ts.net:8317',
      'http://192.168.1.20:8317'
    ])
    expect(checks.every((request) => Object.keys(request.headers ?? {}).length === 0), 'the http check carries no key').toBe(true)
    expect(store.hubs.length).toBe(0)
  })

  it('testAListingThatLacksLoginsKeepsTheirAccountsUntilTheNextListingAgrees', () => {
    const store = new AccountStore({ defaults: isolatedDefaults(), vault: new InMemoryCredentialVault(), hubKeys: new InMemoryHubKeyVault() })
    const hub = CLIProxyHub.make(hubURL)
    store.addHub(hub, 'mgmt-key')
    store.mirror([login('a', 'claude'), login('b', 'codex')], hub.id)
    const mirrored = structuredClone(store.accounts)

    store.mirror(HubLogin.listing('{"files":[]}'), hub.id)
    expect(store.accounts, 'one empty listing, as from a hub mid-restart, erases nothing').toEqual(mirrored)
    store.mirror([login('a', 'claude'), login('b', 'codex')], hub.id)
    const uncallable = '{"files":[{"id":"a","provider":"claude"},{"id":"b","auth_index":"index-b","provider":"codex"}]}'
    store.mirror(HubLogin.listing(uncallable), hub.id)
    expect(store.accounts, 'a login listed without an auth index keeps its account').toEqual(mirrored)

    store.mirror([login('a', 'claude')], hub.id)
    expect(store.accounts, 'a login missing from one listing stays').toEqual(mirrored)
    store.mirror([login('a', 'claude')], hub.id)
    expect(store.accounts.map((account) => account.id), 'a login two listings in a row lack is removed').toEqual([mirrored[0].id])
  })

  it('testAFailedKeychainWriteLeavesTheHubUnreadSoTheNextSyncRetries', async () => {
    const vault = new FailingVault()
    vault.saveError.value = new CredentialVaultError()
    const store = new AccountStore({ defaults: isolatedDefaults(), vault, hubKeys: new InMemoryHubKeyVault() })
    const listing = '{"files":[{"id":"a","auth_index":"index-a","provider":"claude","account_type":"oauth"}]}'
    const http = new RoutingHTTPClient(() => jsonResponse(listing))
    const sync = new CLIProxyHubSync(store, new CLIProxyHubClient(http, new CLIProxyHubGate()), true)

    await sync.connect('http://mini.local:8317', 'mgmt-key')
    const hub = store.hubs[0]
    expect(hub).toBeDefined()
    expect(store.accounts.length).toBe(0)
    expect(sync.status(hub.id)).toEqual({
      type: 'failed',
      message: `${AppInfo.name} couldn’t save this hub’s logins. It tries again when Accounts opens.`
    })

    vault.saveError.value = undefined
    await sync.syncDue()
    expect(http.requests.length, 'the hub is read again at the next sync, not an hour later').toBe(2)
    expect(store.accounts.map((account) => account.hub?.loginID)).toEqual(['a'])
    expect(sync.status(hub.id)).toEqual({ type: 'synced', unsupported: 0 })
  })

  it('testAFailedRemovalIsTriedAgainAtTheNextRead', () => {
    const vault = new FailingVault()
    const store = new AccountStore({ defaults: isolatedDefaults(), vault, hubKeys: new InMemoryHubKeyVault() })
    const hub = CLIProxyHub.make(hubURL)
    store.addHub(hub, 'mgmt-key')
    store.mirror([login('a', 'claude')], hub.id)
    store.mirror([], hub.id)

    vault.deleteError.value = new CredentialVaultError()
    expect(() => store.mirror([], hub.id)).toThrow()
    expect(store.accounts.length).toBe(1)
    vault.deleteError.value = undefined
    store.mirror([], hub.id)

    expect(store.accounts.length, 'the login two listings lacked is removed once the vault lets it go').toBe(0)
  })
})
