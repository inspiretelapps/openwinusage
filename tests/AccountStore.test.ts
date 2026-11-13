import { describe, expect, it } from 'vitest'
import { Account, AccountCredential } from '@core/models/Account'
import { CLIProxyHub } from '@core/models/CLIProxyHub'
import { Provider } from '@core/models/Provider'
import { AccountStore } from '@core/stores/AccountStore'
import { InMemoryHubKeyVault, hubLogin } from './CLIProxyHubSupport'
import { InMemoryCredentialVault, isolatedDefaults, unix } from './TestSupport'
import { StoredAccountList, makeAccountStore } from './support/accountHelpers'

describe('AccountStoreTests', () => {
  it('testAnAddedOrRenamedAccountAlwaysHasANameTheDashboardShows', () => {
    const store = makeAccountStore()
    const blank = store.add({ kind: 'openrouter', label: '  ', credential: AccountCredential.apiKey('first') })
    const bare = store.add({ kind: 'zai', label: 'z.ai', credential: AccountCredential.apiKey('second') })

    expect(store.accounts.map((account) => account.label)).toEqual(['OpenRouter Account', 'Z.ai Account'])

    store.rename(blank.id, 'Work')
    store.rename(bare.id, '')
    expect(store.accounts.map((account) => account.label)).toEqual(['Work', 'Z.ai Account'])
    store.rename(blank.id, 'OpenRouter')
    expect(store.accounts.map((account) => account.label)).toEqual(['OpenRouter Account', 'Z.ai Account'])
    expect(
      store.accounts.map((account) => Provider.labelBesideName({ id: Account.cardID(account), kind: account.kind, accountLabel: account.label }))
    ).toEqual(['OpenRouter Account', 'Z.ai Account'])
  })

  it('testAStoredAccountWithoutANameTheDashboardShowsIsNamedOnLoad', () => {
    const defaults = isolatedDefaults()
    const stored = [
      Account.make({ kind: 'openrouter', label: '', addedAt: unix(1) }),
      Account.make({ kind: 'openrouter', label: 'OpenRouter', addedAt: unix(2) }),
      Account.make({ kind: 'claude', label: 'Work', addedAt: unix(3) })
    ]
    defaults.set(AccountStore.storageKey, JSON.parse(JSON.stringify(stored)))

    const store = makeAccountStore({ defaults })

    expect(store.accounts.map((account) => account.id)).toEqual(stored.map((account) => account.id))
    expect(store.accounts.map((account) => account.label)).toEqual(['OpenRouter Account', 'OpenRouter Account', 'Work'])
    const saved = AccountStore.load(defaults).accounts
    expect(saved.map((account) => account.label), 'the names are saved').toEqual(['OpenRouter Account', 'OpenRouter Account', 'Work'])
  })

  it('testANewAccountNeverTakesTheCardIDOfOneAlreadyAdded', () => {
    const ids = [
      '1A2B3C4D-0000-4000-8000-000000000001',
      '1A2B3C4D-0000-4000-8000-000000000002',
      '5E6F7A8B-0000-4000-8000-000000000003',
      '1A2B3C4D-0000-4000-8000-000000000004',
      '9C0D1E2F-0000-4000-8000-000000000005'
    ]
    const store = makeAccountStore({
      vault: new InMemoryCredentialVault(),
      hubKeys: new InMemoryHubKeyVault(),
      makeID: () => {
        const next = ids.shift()
        if (next === undefined) throw new Error('ran out of ids')
        return next
      }
    })
    const hub = CLIProxyHub.make('http://mini.local:8317')
    store.addHub(hub, 'mgmt-key')

    store.add({ kind: 'claude', label: 'Work', credential: AccountCredential.apiKey('work') })
    store.add({ kind: 'claude', label: 'Home', credential: AccountCredential.apiKey('home') })
    store.mirror([hubLogin({ id: 'a', authIndex: 'index-a', provider: 'claude', label: 'Hub', isOAuth: true, isDisabled: false })], hub.id)

    expect(
      store.accounts.map((account) => Account.cardID(account)),
      'an id whose first 8 hex digits an added account of the kind already has is drawn again'
    ).toEqual(['claude@1a2b3c4d', 'claude@5e6f7a8b', 'claude@9c0d1e2f'])
  })

  it('testAnEntryThisBuildCannotReadStaysStoredThroughAddRenameAndRemove', () => {
    const defaults = isolatedDefaults()
    defaults.set(AccountStore.storageKey, StoredAccountList.data)
    const store = makeAccountStore({ defaults })
    const futureEntry = JSON.parse(StoredAccountList.futureEntry) as unknown
    const storedList = (): unknown[] => {
      const list = defaults.get(AccountStore.storageKey)
      if (!Array.isArray(list)) throw new Error('no stored list')
      // Read as a fresh JSON value, as upstream decodes the saved data.
      return JSON.parse(JSON.stringify(list)) as unknown[]
    }

    expect(store.accounts).toEqual([StoredAccountList.claude])
    const added = store.add({ kind: 'codex', label: 'Home', credential: AccountCredential.apiKey('key') })
    expect(storedList(), 'kept through an add').toContainEqual(futureEntry)
    store.rename(StoredAccountList.claude.id, 'Renamed')
    expect(storedList(), 'kept through a rename').toContainEqual(futureEntry)
    store.remove(added.id)
    expect(storedList(), 'kept through a remove').toContainEqual(futureEntry)

    expect(storedList().length, 'the renamed account and the kept entry').toBe(2)
    expect(makeAccountStore({ defaults }).accounts.map((account) => account.label)).toEqual(['Renamed'])
  })
})
