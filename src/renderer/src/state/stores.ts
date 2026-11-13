import { Account } from '@core/models/Account'
import type { CLIProxyHub } from '@core/models/CLIProxyHub'
import { Provider } from '@core/models/Provider'
import { widgetDescriptors } from '@core/providers/AccountProviderRuntime+Descriptors'
import { AccountStore } from '@core/stores/AccountStore'
import { LayoutStore } from '@core/stores/LayoutStore'
import { ProviderSnapshotCache } from '@core/stores/ProviderSnapshotCache'
import { WidgetDataView } from '@core/stores/WidgetDataStore'
import { WidgetRegistry } from '@core/stores/WidgetRegistry'
import { MemoryDefaults, setStandardDefaults } from '@core/support/Defaults'
import type { AppState } from '@shared/ipc'

/**
 * The panel's read-only copy of the app's stores, rebuilt from each state the app sends. The classes
 * are the app's own, so every figure the panel shows is computed by the same code.
 *
 * Read from these freely. Never call their mutating methods: changes go through `api` (see `bridge.ts`),
 * and the app answers with a new state.
 */
export interface Stores {
  state: AppState
  /** Every preference, for reading a setting: `defaultsBool(stores.defaults, key)`. */
  defaults: MemoryDefaults
  accounts: Account[]
  hubs: CLIProxyHub[]
  registry: WidgetRegistry
  /** Order, hidden and pinned metrics: `layout.displayGroups`, `layout.isMetricPinned(id)`. */
  layout: LayoutStore
  /** Readings and display settings: `data.data(descriptor)`, `data.families(groups)`, `data.priorityBoard(...)`. */
  data: WidgetDataView
  account(providerID: string): Account | undefined
}

export function buildStores(state: AppState): Stores {
  const defaults = new MemoryDefaults(state.defaults)
  // Formatters and settings that read `standardDefaults()` (the time format, for one) follow the app's.
  setStandardDefaults(defaults)
  const accounts = AccountStore.load(defaults).accounts
  const hubs = AccountStore.loadHubs(defaults)
  const registry = new WidgetRegistry(accounts.map(Provider.forAccount), accounts.flatMap(widgetDescriptors))
  // The layout is read through a scratch copy, so reading it can never write to the mirrored preferences.
  const layout = new LayoutStore(registry, new MemoryDefaults(state.defaults))
  const data = new WidgetDataView(registry, defaults)
  const ids = new Set(registry.providers.map((provider) => provider.id))
  data.hydrate({
    snapshots: Object.fromEntries(Object.entries(new ProviderSnapshotCache(defaults).load()).filter(([id]) => ids.has(id))),
    backoffs: state.backoffs,
    refreshingProviderIDs: state.refreshingProviderIDs,
    lastRefreshAt: state.lastRefreshAt,
    burningFastWindows: state.burningFastWindows
  })
  const byCardID = new Map(accounts.map((account) => [Account.cardID(account), account]))
  return { state, defaults, accounts, hubs, registry, layout, data, account: (providerID) => byCardID.get(providerID) }
}
