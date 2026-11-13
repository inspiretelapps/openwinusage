import type { Account } from '@core/models/Account'
import type { Provider } from '@core/models/Provider'
import type { ProviderSnapshot, RefreshResult } from '@core/models/ProviderSnapshot'
import type { WidgetDescriptor } from '@core/models/WidgetDescriptor'
import type { ProviderRuntime } from '@core/providers/ProviderRuntime'
import { ProviderSnapshotCache } from '@core/stores/ProviderSnapshotCache'
import { WidgetDataStore } from '@core/stores/WidgetDataStore'
import { WidgetRegistry } from '@core/stores/WidgetRegistry'
import type { Defaults } from '@core/support/Defaults'
import type { Clock, Seconds } from '@core/support/time'

/** `WidgetDataStore.forTesting(_:registry:cache:defaults:now:providerRefreshTimeout:)` */
export function storeForTesting(
  runtimes: ProviderRuntime[],
  options: {
    defaults: Defaults
    registry?: WidgetRegistry
    cache?: ProviderSnapshotCache
    now?: Clock
    providerRefreshTimeout?: Seconds
  }
): WidgetDataStore {
  return new WidgetDataStore({
    registry: options.registry ?? WidgetRegistry.from(runtimes),
    providers: runtimes,
    cache: options.cache ?? new ProviderSnapshotCache(options.defaults, 'snapshots'),
    defaults: options.defaults,
    now: options.now ?? Date.now,
    providerRefreshTimeout: options.providerRefreshTimeout ?? WidgetDataStore.defaultProviderRefreshTimeout
  })
}

/** `try result.get()` */
export function get(result: RefreshResult): ProviderSnapshot {
  if (!result.ok) throw new Error(result.failure.message)
  return result.snapshot
}

/** Lets pending promise callbacks run, like `Task.yield()`. */
export function yieldTask(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve))
}

/** Waits for `condition`, yielding between checks; fails after `timeoutMs`. */
export async function waitUntil(condition: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('the condition was not met in time')
    await new Promise((resolve) => setTimeout(resolve, 1))
  }
}

/** A runtime whose refresh waits until the test calls `complete()`. */
export class SuspendedProviderRuntime implements ProviderRuntime {
  readonly widgetDescriptors: WidgetDescriptor[] = []
  didStart = false
  private resume: ((result: RefreshResult) => void) | undefined

  constructor(
    readonly provider: Provider,
    private readonly snapshot: ProviderSnapshot
  ) {}

  refresh(): Promise<RefreshResult> {
    this.didStart = true
    return new Promise((resolve) => {
      this.resume = resolve
    })
  }

  complete(): void {
    this.resume?.({ ok: true, snapshot: this.snapshot })
    this.resume = undefined
  }

  forgetHourlyReads(): void {}
  restore(): void {}
  async refreshHourlyReads(): Promise<ProviderSnapshot | undefined> {
    return undefined
  }
}

/**
 * A stored account list with a Claude account and an entry of a kind this build does not have, with a
 * field this build does not know, as a build with another provider would save it.
 */
export const StoredAccountList = {
  claude: {
    id: '8ad3b217-0000-4000-8000-000000000000',
    kind: 'claude',
    label: 'Work',
    addedAt: 0
  } as Account,
  futureEntry: { id: 'F00DF00D-0000-4000-8000-000000000000', kind: 'future-provider', label: 'Future', seats: [{ id: 1 }], addedAt: 1 },
  get data(): unknown[] {
    return [{ id: '8AD3B217-0000-4000-8000-000000000000', kind: 'claude', label: 'Work', addedAt: 0 }, StoredAccountList.futureEntry]
  }
}
