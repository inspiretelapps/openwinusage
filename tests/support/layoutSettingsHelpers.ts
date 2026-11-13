import type { ProviderSnapshot } from '@core/models/ProviderSnapshot'
import { ProviderCatalog } from '@core/providers/ProviderCatalog'
import type { ProviderRuntime } from '@core/providers/ProviderRuntime'
import { HTTPResponse } from '@core/services/HTTPClient'
import { MemoryHubKeyVault } from '@core/services/HubKeyVault'
import { AccountStore } from '@core/stores/AccountStore'
import { ProviderSnapshotCache } from '@core/stores/ProviderSnapshotCache'
import { WidgetDataStore } from '@core/stores/WidgetDataStore'
import { WidgetRegistry } from '@core/stores/WidgetRegistry'
import type { Defaults } from '@core/support/Defaults'
import type { Clock, Seconds } from '@core/support/time'
import { MockData } from '../MockData'
import { InMemoryCredentialVault, RoutingHTTPClient } from '../TestSupport'

/** `WidgetRegistry.mock`: MockData's three accounts and their metrics. */
export function mockRegistry(): WidgetRegistry {
  return new WidgetRegistry(MockData.providers, MockData.descriptors)
}

/** `WidgetDataStore.forTesting(_:registry:cache:defaults:now:providerRefreshTimeout:)` */
export function makeDataStore(
  runtimes: ProviderRuntime[],
  options: {
    registry?: WidgetRegistry
    cache?: ProviderSnapshotCache
    defaults: Defaults
    now?: Clock
    providerRefreshTimeout?: Seconds
  }
): WidgetDataStore {
  return new WidgetDataStore({
    registry: options.registry ?? WidgetRegistry.from(runtimes),
    providers: runtimes,
    cache: options.cache ?? new ProviderSnapshotCache(options.defaults, 'snapshots'),
    defaults: options.defaults,
    now: options.now,
    providerRefreshTimeout: options.providerRefreshTimeout
  })
}

/** Swift's `store.snapshots[id] = snapshot`. */
export function setSnapshot(store: WidgetDataStore, providerID: string, snapshot: ProviderSnapshot): void {
  store.setSnapshot(providerID, snapshot)
}

/** An HTTP client that answers every request with 401, so no test reaches a provider. */
export function refusingHTTP(): RoutingHTTPClient {
  return new RoutingHTTPClient(() => new HTTPResponse(401, {}, ''))
}

/** `AccountStore(defaults:vault:)` */
export function makeAccountStore(defaults: Defaults, vault = new InMemoryCredentialVault(), hubKeys = new MemoryHubKeyVault()): AccountStore {
  return new AccountStore({ defaults, vault, hubKeys })
}

/** `WidgetRegistry.from(ProviderCatalog.make(accounts: accounts.accounts, vault: accounts.credentialVault))` */
export function registryFor(accounts: AccountStore): WidgetRegistry {
  return WidgetRegistry.from(
    ProviderCatalog.make({
      accounts: [...accounts.accounts],
      vault: accounts.credentialVault,
      hubKeys: accounts.hubKeys,
      http: refusingHTTP()
    })
  )
}

/** Polls `condition` until it holds, failing after `timeoutMs`. */
export async function waitUntil(condition: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('waitUntil timed out')
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}
