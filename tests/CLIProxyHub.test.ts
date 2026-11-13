import { describe, it, expect } from 'vitest'
import { AddAccountChoice } from '@core/app/AddAccountFlow'
import { AccountCredential, OAuthTokens, ProviderKind } from '@core/models/Account'
import { CLIProxyHub, HubLogin } from '@core/models/CLIProxyHub'
import { AccountStore } from '@core/stores/AccountStore'
import type { MemoryDefaults } from '@core/support/Defaults'
import { InMemoryHubKeyVault, hubLogin, recordedListing } from './CLIProxyHubSupport'
import { InMemoryCredentialVault, isolatedDefaults } from './TestSupport'

/**
 * A CLIProxyAPI hub's login list mirrored as accounts: what is read from the listing, and how the
 * mirror follows the hub.
 */
let defaults: MemoryDefaults

function makeHub(): { store: AccountStore; vault: InMemoryCredentialVault; hub: CLIProxyHub } {
  const vault = new InMemoryCredentialVault()
  defaults = isolatedDefaults()
  const store = new AccountStore({ defaults, vault, hubKeys: new InMemoryHubKeyVault() })
  const hub = CLIProxyHub.make('http://mini.local:8317')
  store.addHub(hub, 'mgmt-key')
  return { store, vault, hub }
}

function login(id: string, provider: string, index?: string, disabled = false): HubLogin {
  return hubLogin({
    id,
    authIndex: index ?? `index-${id}`,
    provider,
    label: id,
    isDisabled: disabled,
    chatGPTAccountID: provider === 'codex' ? `acct-${id}` : undefined
  })
}

const oauth = (accessToken: string, extras: Record<string, string> = {}): AccountCredential =>
  AccountCredential.oauth(OAuthTokens.make(accessToken, undefined, undefined, extras))

describe('CLIProxyHubTests', () => {
  it('testEveryHubProviderWithARuntimeIsMirroredAndCursorIsNot', () => {
    const providers = ['antigravity', 'devin', 'xai', 'cursor', 'gemini']
    const body =
      '{"files":[' +
      providers.map((provider) => `{"id":"${provider}","auth_index":"${provider}-index","provider":"${provider}","account_type":"oauth"}`).join(',') +
      ']}'
    const logins = HubLogin.listing(body)
    expect(logins.map(HubLogin.kind), "Cursor's hub login holds an API key, not a session").toEqual([
      'antigravity',
      'devin',
      'grok',
      undefined,
      undefined
    ])
  })

  it('testAnAPIKeyEntryOrAnUncallableEntryIsNotMirrored', () => {
    const body =
      '{"files":[{"id":"a","auth_index":"1","provider":"claude","account_type":"api_key"},{"id":"b","provider":"codex"},{"id":"c","auth_index":"3","provider":"codex"}]}'
    const logins = HubLogin.listing(body)
    expect(logins.map(HubLogin.kind)).toEqual([undefined, 'codex', 'codex'])
    expect(logins[1].authIndex).toBeUndefined()
    const { store, hub } = makeHub()
    store.mirror(logins, hub.id)
    expect(store.accounts.map((account) => account.hub?.loginID), "an entry without an auth index can't be called").toEqual(['c'])
    expect(() => HubLogin.listing('<html>')).toThrow()
  })

  it('testAddAccountOffersTheHubLast', () => {
    expect(AddAccountChoice.all).toEqual([
      ...ProviderKind.allCases.map((kind) => ({ type: 'provider', kind })),
      { type: 'cliproxyHub' }
    ])
  })

  it('testTheHubAddressIsCleanedFromWhatTheUserPastes', () => {
    const cases: [string, string | undefined][] = [
      ['127.0.0.1:8317', 'https://127.0.0.1:8317'],
      ['hub.example.com', 'https://hub.example.com'],
      [' http://mini.local:8317/ ', 'http://mini.local:8317'],
      ['http://192.168.1.20:8317/management.html#/usage', 'http://192.168.1.20:8317'],
      ['https://hub.example.com/v0/management?x=1', 'https://hub.example.com'],
      ['https://hub.example.com/cpa/v1', 'https://hub.example.com/cpa'],
      ['ftp://hub', undefined],
      ['', undefined]
    ]
    for (const [input, expected] of cases) {
      expect(CLIProxyHub.baseURL(input), input).toBe(expected)
    }
    expect(CLIProxyHub.hostOf('http://mini.local:8317')).toBe('mini.local:8317')
  })

  it('testConnectingMirrorsEverySupportedLoginAsAnOrdinaryAccount', () => {
    const { store, vault, hub } = makeHub()
    store.mirror(HubLogin.listing(recordedListing), hub.id)

    expect(store.accounts.map((account) => account.kind)).toEqual(['claude', 'claude', 'claude', 'codex'])
    expect(
      store.accounts.map((account) => account.label),
      'hub order is kept, a login disabled on the hub gets no account, and one without an email gets the default name'
    ).toEqual(['alice@example.com', 'Claude Account', 'notoken@example.com', 'codex-user@example.com'])
    expect(store.accounts[0]?.hub?.authIndex).toBe('b799da203df01af5')
    expect(store.accounts.every((account) => account.hub?.hubID === hub.id && account.hub?.hubURL === hub.url)).toBe(true)
    const codex = store.accounts.find((account) => account.kind === 'codex')!
    expect(vault.load(codex.id), 'the hub\'s token never reaches this computer, and nothing is there to refresh').toEqual(
      oauth('$TOKEN$', { chatgpt_account_id: 'acct-dummy-0001' })
    )
    expect(store.hubKeys.load(hub.id)).toEqual({ key: 'mgmt-key', url: hub.url })
    expect(vault.load(hub.id), "the management key isn't kept with the accounts' sign-ins").toBeUndefined()
  })

  it('testMirroringTheSameListingTwiceChangesNothing', () => {
    const { store, vault, hub } = makeHub()
    const logins = HubLogin.listing(recordedListing)
    store.mirror(logins, hub.id)
    const accounts = structuredClone(store.accounts)
    const credentials = accounts.map((account) => vault.load(account.id))
    let changes = 0
    store.didChange = () => (changes += 1)

    store.mirror(logins, hub.id)
    store.mirror(logins, hub.id)

    expect(changes).toBe(0)
    expect(store.accounts).toEqual(accounts)
    expect(store.accounts.map((account) => vault.load(account.id))).toEqual(credentials)
  })

  it('testTheMirrorFollowsLoginsAddedRemovedRenamedAndDisabledOnTheHub', () => {
    const { store, vault, hub } = makeHub()
    store.add({ kind: 'claude', label: 'Direct', credential: oauth('direct') })
    store.mirror([login('a', 'claude'), login('b', 'codex'), login('c', 'claude')], hub.id)
    const a = store.accounts.find((account) => account.hub?.loginID === 'a')!
    const b = store.accounts.find((account) => account.hub?.loginID === 'b')!
    const c = store.accounts.find((account) => account.hub?.loginID === 'c')!
    store.rename(c.id, 'Renamed Here')

    const next = [login('b', 'codex', 'moved'), login('c', 'claude', undefined, true), login('d', 'claude')]
    store.mirror(next, hub.id)
    expect(store.accounts.map((account) => account.label), 'a disabled login disappears and a new one is added last').toEqual([
      'Direct',
      'a',
      'b',
      'd'
    ])
    store.mirror(next, hub.id)

    expect(store.accounts.map((account) => account.label), 'a login two listings lack disappears').toEqual(['Direct', 'b', 'd'])
    expect(store.accounts.find((account) => account.id === b.id)?.hub?.authIndex, 'a renamed hub file is relinked, not re-added').toBe('moved')
    expect([a, c].map((account) => vault.load(account.id)), "the gone and disabled logins' credentials are deleted").toEqual([undefined, undefined])

    store.mirror([login('b', 'codex', 'moved'), login('c', 'claude'), login('d', 'claude')], hub.id)
    expect(store.accounts.map((account) => account.label), 'a login enabled again comes back as a new account, last').toEqual([
      'Direct',
      'b',
      'd',
      'c'
    ])
    expect(store.accounts.at(-1)?.id).not.toBe(c.id)
  })

  it('testRemovingTheHubRemovesItsAccountsAndKeyOnly', () => {
    const { store, vault, hub } = makeHub()
    const direct = store.add({ kind: 'codex', label: 'Direct', credential: oauth('direct') })
    store.mirror([login('a', 'claude'), login('b', 'codex')], hub.id)
    const mirrored = store.accountsOnHub(hub.id)
    expect(mirrored.length).toBe(2)

    store.removeHub(hub.id)

    expect(store.accounts.map((account) => account.id)).toEqual([direct.id])
    expect(store.hubs.length).toBe(0)
    expect([...mirrored, direct].map((account) => vault.load(account.id))).toEqual([undefined, undefined, oauth('direct')])
    expect(store.hubKeys.load(hub.id)).toBeUndefined()
    expect(new AccountStore({ defaults, vault, hubKeys: new InMemoryHubKeyVault() }).hubs.length, 'the removal is saved').toBe(0)
  })

  it('testAHubAndItsAccountsSurviveARelaunch', () => {
    const { store, vault, hub } = makeHub()
    store.mirror([login('a', 'claude')], hub.id)

    const relaunched = new AccountStore({ defaults, vault, hubKeys: new InMemoryHubKeyVault() })

    expect(relaunched.hubs).toEqual([hub])
    expect(relaunched.accounts.map((account) => account.hub)).toEqual(store.accounts.map((account) => account.hub))
  })

  it('testALoginOnAHubIsNeverADuplicateOfADirectSignIn', () => {
    const { store, vault, hub } = makeHub()
    store.mirror([login('a', 'claude')], hub.id)
    const mirrored = store.accounts[0]
    vault.update(oauth('$TOKEN$', { [OAuthTokens.identityKey]: 'acct/org' }), mirrored.id)

    const direct = oauth('real', { [OAuthTokens.identityKey]: 'acct/org' })
    expect(() => store.checkForDuplicate(direct, 'claude', undefined), 'the same login signed in directly shows twice').not.toThrow()
  })
})
