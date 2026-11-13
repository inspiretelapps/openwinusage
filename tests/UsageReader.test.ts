import { describe, expect, it } from 'vitest'
import { Account, AccountCredential, ProviderKind } from '@core/models/Account'
import { MetricLine, ProgressFormat } from '@core/models/MetricLine'
import { ProviderSnapshot } from '@core/models/ProviderSnapshot'
import { MemoryHubKeyVault } from '@core/services/HubKeyVault'
import { UsageReader, UsageReaderError, type UsageReadResult } from '@core/services/UsageReader'
import { AccountStore } from '@core/stores/AccountStore'
import { ProviderSnapshotCache } from '@core/stores/ProviderSnapshotCache'
import type { Defaults } from '@core/support/Defaults'
import { addSeconds, type Instant } from '@core/support/time'
import { InMemoryCredentialVault, isolatedDefaults } from './TestSupport'
import { storeForTesting, StoredAccountList } from './support/dataStoreHelpers'

type JSONRecord = Record<string, unknown>

function cache(snapshot: ProviderSnapshot, defaults: Defaults): void {
  const store = new ProviderSnapshotCache(defaults)
  store.save({ ...store.load(), [snapshot.providerID]: snapshot })
}

function weekly(account: Account, used: number, refreshedAt: Instant = Date.now()): ProviderSnapshot {
  return ProviderSnapshot.make({
    providerID: Account.cardID(account),
    displayName: ProviderKind.displayName(account.kind),
    lines: [MetricLine.progress('Weekly', used, 100, ProgressFormat.percent)],
    refreshedAt
  })
}

function root(result: UsageReadResult): JSONRecord {
  return JSON.parse(result.data) as JSONRecord
}

function providers(result: UsageReadResult): Record<string, JSONRecord> {
  const value = root(result).providers
  if (value === undefined || value === null || typeof value !== 'object') throw new Error('no providers')
  return value as Record<string, JSONRecord>
}

function accountStore(defaults: Defaults): AccountStore {
  return new AccountStore({ defaults, vault: new InMemoryCredentialVault(), hubKeys: new MemoryHubKeyVault() })
}

const key = AccountCredential.apiKey('k')

describe('UsageReaderTests', () => {
  it('testPrintsEveryCachedAccountFromTheAppDomain', () => {
    const defaults = isolatedDefaults()
    const store = accountStore(defaults)
    const codex = store.add({ kind: 'codex', label: 'Work', credential: key })
    const claude = store.add({ kind: 'claude', label: 'Claude', credential: key })
    store.add({ kind: 'codex', label: 'Home', credential: key })
    cache(weekly(codex, 20), defaults)
    cache(weekly(claude, 30), defaults)

    const result = UsageReader.read(defaults)
    const entries = providers(result)

    expect(result.hasSnapshots).toBe(true)
    expect(new Set(Object.keys(entries))).toEqual(new Set([Account.cardID(codex), Account.cardID(claude)]))
    const resources = entries[Account.cardID(codex)]?.resources as Record<string, JSONRecord> | undefined
    expect(resources?.weekly?.used).toBe(20)
    expect(entries[Account.cardID(codex)]?.displayName).toBe('ChatGPT · Work')
  })

  it('testProviderKindNamesEveryAccountOfThatKindAndCardIDNamesOne', () => {
    const defaults = isolatedDefaults()
    const store = accountStore(defaults)
    const first = store.add({ kind: 'codex', label: 'Work', credential: key })
    const second = store.add({ kind: 'codex', label: 'Home', credential: key })
    const claude = store.add({ kind: 'claude', label: 'Claude', credential: key })
    for (const account of [first, second, claude]) cache(weekly(account, 10), defaults)

    const ids = (providerID: string): Set<string> => new Set(Object.keys(providers(UsageReader.read(defaults, providerID))))
    expect(ids('codex')).toEqual(new Set([Account.cardID(first), Account.cardID(second)]))
    expect(ids('Codex')).toEqual(new Set([Account.cardID(first), Account.cardID(second)]))
    expect(ids(Account.cardID(second))).toEqual(new Set([Account.cardID(second)]))
    expect(ids('claude')).toEqual(new Set([Account.cardID(claude)]))
  })

  it('testAnAccountIsStaleOnlyOnceTheAppShowsItsValuesAsOld', () => {
    const defaults = isolatedDefaults()
    const store = accountStore(defaults)
    const recent = store.add({ kind: 'claude', label: 'Recent', credential: key })
    const old = store.add({ kind: 'claude', label: 'Old', credential: key })
    const now = Date.now()
    cache(weekly(recent, 10, addSeconds(now, -6 * 60)), defaults)
    cache(weekly(old, 10, addSeconds(now, -11 * 60)), defaults)

    const entries = providers(UsageReader.read(defaults))

    expect(entries[Account.cardID(recent)]?.stale, 'refreshed 6 minutes ago').toBe(false)
    expect(entries[Account.cardID(old)]?.stale, 'refreshed 11 minutes ago').toBe(true)
    const app = storeForTesting([], { defaults, now: () => now })
    app.setSnapshots(new ProviderSnapshotCache(defaults).load())
    expect(app.stalenessHint(Account.cardID(recent))).toBeUndefined()
    expect(app.stalenessHint(Account.cardID(old))).toBeDefined()
  })

  it('testUnknownProviderThrowsEvenWhenNothingIsCached', () => {
    const defaults = isolatedDefaults()
    const store = accountStore(defaults)
    store.add({ kind: 'codex', label: 'Work', credential: key })

    let error: unknown
    try {
      UsageReader.read(defaults, 'cursor')
    } catch (caught) {
      error = caught
    }
    if (!(error instanceof UsageReaderError)) throw new Error(`unexpected error ${String(error)}`)
    expect(error.providerID).toBe('cursor')
    expect(() => UsageReader.read(defaults, 'codex@00000000')).toThrow()
  })

  it('testAnEntryThisBuildCannotReadLeavesTheOtherAccountsReadable', () => {
    const defaults = isolatedDefaults()
    defaults.set(AccountStore.storageKey, StoredAccountList.data)
    cache(weekly(StoredAccountList.claude, 20), defaults)

    const result = UsageReader.read(defaults)

    expect(new Set(Object.keys(providers(result)))).toEqual(new Set([Account.cardID(StoredAccountList.claude)]))
  })

  it('testNothingFetchedYetPrintsTheEmptyEnvelope', () => {
    const defaults = isolatedDefaults()
    const empty = UsageReader.read(defaults)
    expect(empty.hasSnapshots).toBe(false)
    expect(providers(empty)).toEqual({})

    const store = accountStore(defaults)
    store.add({ kind: 'codex', label: 'Work', credential: key })
    const unfetched = UsageReader.read(defaults, 'codex')
    expect(unfetched.hasSnapshots).toBe(false)
    expect(providers(unfetched)).toEqual({})
    expect(root(unfetched).schema).toBe('openusage.limits.v2')
  })
})
