import { describe, expect, it } from 'vitest'
import { Account, AccountCredential, ProviderKind } from '@core/models/Account'
import { DashboardFamily } from '@core/models/DashboardFamilies'
import { MemoryHubKeyVault } from '@core/services/HubKeyVault'
import type { AccountStore } from '@core/stores/AccountStore'
import { LayoutStore } from '@core/stores/LayoutStore'
import type { Defaults } from '@core/support/Defaults'
import { makeAccountStore, registryFor } from './support/layoutSettingsHelpers'
import { InMemoryCredentialVault, isolatedDefaults } from './TestSupport'

/** The accounts screen and the dashboard over one account store and layout, as the app wires them. */
class OrderingApp {
  private readonly vault = new InMemoryCredentialVault()
  private readonly hubKeys = new MemoryHubKeyVault()
  accounts: AccountStore
  layout: LayoutStore

  constructor(private readonly defaults: Defaults) {
    this.accounts = makeAccountStore(defaults, this.vault, this.hubKeys)
    this.layout = new LayoutStore(registryFor(this.accounts), defaults)
  }

  add(kind: ProviderKind): Account {
    const account = this.accounts.add({ kind, label: ProviderKind.displayName(kind), credential: AccountCredential.apiKey('key') })
    this.layout.apply(registryFor(this.accounts))
    return account
  }

  remove(account: Account): void {
    this.accounts.remove(account.id)
    this.layout.apply(registryFor(this.accounts))
  }

  relaunch(): void {
    this.accounts = makeAccountStore(this.defaults, this.vault, this.hubKeys)
    this.layout = new LayoutStore(registryFor(this.accounts), this.defaults)
  }

  get accountsScreen(): string[] {
    return this.layout.orderedProviders().map((provider) => provider.id)
  }

  get accountsScreenFamilies(): string[] {
    const families: string[] = []
    for (const id of this.layout.orderedProviders().map((provider) => provider.kind)) if (!families.includes(id)) families.push(id)
    return families
  }

  get dashboard(): Record<string, string[]>[] {
    return DashboardFamily.make(this.layout.displayGroups, (descriptor) => ({ descriptor, data: descriptor.sample })).map((family) => ({
      [family.id]: family.accounts.map((account) => account.provider.id)
    }))
  }

  get dashboardFamilies(): string[] {
    return this.dashboard.flatMap((entry) => Object.keys(entry))
  }
}

function makeApp(): OrderingApp {
  return new OrderingApp(isolatedDefaults())
}

const card = (account: Account): string => Account.cardID(account)

describe('ProviderOrderTests', () => {
  it('testNewProvidersGoToTheBottomInTheOrderTheyWereAdded', () => {
    const app = makeApp()
    app.add('claude')
    app.add('codex')

    app.add('grok')
    app.add('cursor')
    app.add('antigravity')

    const expected = ['claude', 'codex', 'grok', 'cursor', 'antigravity']
    expect(app.accountsScreenFamilies).toEqual(expected)
    expect(app.dashboardFamilies).toEqual(expected)
  })

  it('testNewAccountGoesToTheBottomOfItsProvider', () => {
    const app = makeApp()
    const firstClaude = app.add('claude')
    const codex = app.add('codex')
    const grok = app.add('grok')
    expect(app.layout.reorderFamily('grok', 'codex')).toBe(true)

    const secondClaude = app.add('claude')

    expect(app.accountsScreen).toEqual([card(firstClaude), card(secondClaude), card(grok), card(codex)])
    expect(app.dashboard).toEqual([
      { claude: [card(firstClaude), card(secondClaude)] },
      { grok: [card(grok)] },
      { codex: [card(codex)] }
    ])
  })

  it('testASecondAccountJoinsItsProviderWithoutADrag', () => {
    const app = makeApp()
    const firstClaude = app.add('claude')
    const codex = app.add('codex')
    const secondClaude = app.add('claude')

    const accounts = [card(firstClaude), card(secondClaude), card(codex)]
    const dashboard = [{ claude: [card(firstClaude), card(secondClaude)] }, { codex: [card(codex)] }]
    expect(app.accountsScreen).toEqual(accounts)
    expect(app.dashboard).toEqual(dashboard)

    app.relaunch()

    expect(app.accountsScreen).toEqual(accounts)
    expect(app.dashboard).toEqual(dashboard)
  })

  it('testAnAccountKeepsItsPlaceWhenItsProvidersFirstAccountIsRemoved', () => {
    const app = makeApp()
    const firstClaude = app.add('claude')
    const codex = app.add('codex')
    const secondClaude = app.add('claude')

    app.remove(firstClaude)

    expect(app.accountsScreen).toEqual([card(secondClaude), card(codex)])
    expect(app.dashboard).toEqual([{ claude: [card(secondClaude)] }, { codex: [card(codex)] }])
  })

  it('testAccountsStayGroupedByProviderWhenDragged', () => {
    const app = makeApp()
    const firstClaude = app.add('claude')
    const codex = app.add('codex')
    const secondClaude = app.add('claude')

    expect(app.layout.reorderProvider(card(codex), card(secondClaude))).toBe(false)
    expect(app.accountsScreen).toEqual([card(firstClaude), card(secondClaude), card(codex)])

    expect(app.layout.reorderProvider(card(secondClaude), card(firstClaude))).toBe(true)
    expect(app.accountsScreen).toEqual([card(secondClaude), card(firstClaude), card(codex)])
    expect(app.dashboard).toEqual([{ claude: [card(secondClaude), card(firstClaude)] }, { codex: [card(codex)] }])
  })

  it('testProviderRemovedAndAddedBackGoesToTheBottom', () => {
    const app = makeApp()
    const claude = app.add('claude')
    app.add('codex')
    app.add('grok')

    app.remove(claude)
    app.add('claude')

    expect(app.accountsScreenFamilies).toEqual(['codex', 'grok', 'claude'])
    expect(app.dashboardFamilies).toEqual(['codex', 'grok', 'claude'])
  })

  it('testSavedOrderAndNewProvidersSurviveRelaunch', () => {
    const app = makeApp()
    app.add('claude')
    app.add('codex')
    expect(app.layout.reorderFamily('codex', 'claude')).toBe(true)
    app.add('grok')
    app.add('cursor')

    app.relaunch()

    const expected = ['codex', 'claude', 'grok', 'cursor']
    expect(app.accountsScreenFamilies).toEqual(expected)
    expect(app.dashboardFamilies).toEqual(expected)
  })
})
