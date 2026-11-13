import { describe, expect, it } from 'vitest'
import { MetricLine, ProgressFormat } from '@core/models/MetricLine'
import type { Provider } from '@core/models/Provider'
import { ProviderSnapshot } from '@core/models/ProviderSnapshot'
import { WidgetData } from '@core/models/WidgetData'
import { WidgetDescriptor } from '@core/models/WidgetDescriptor'
import { ProviderSnapshotCache } from '@core/stores/ProviderSnapshotCache'
import type { WidgetDataStore } from '@core/stores/WidgetDataStore'
import type { MemoryDefaults } from '@core/support/Defaults'
import { addSeconds, fromUnixSeconds, type Instant, type Seconds } from '@core/support/time'
import { makeDataStore } from './support/layoutSettingsHelpers'
import { StubRuntime, isolatedDefaults } from './TestSupport'

const session = (used: number): MetricLine => MetricLine.progress('Session', used, 100, ProgressFormat.percent)

function storeSnapshot(used: number, age: Seconds, suite: MemoryDefaults, now: Instant): void {
  new ProviderSnapshotCache(suite, 'snapshots').save({
    test: ProviderSnapshot.make({ providerID: 'test', displayName: 'Test', lines: [session(used)], refreshedAt: addSeconds(now, -age) })
  })
}

function makeRuntime(used: number): StubRuntime {
  const provider: Provider = { id: 'test', kind: 'codex' }
  const descriptor = new WidgetDescriptor(provider, 'session', 'Session', new WidgetData({ title: 'Session', kind: 'percent', used, limit: 100 }))
  return StubRuntime.snapshot(
    provider,
    [descriptor],
    ProviderSnapshot.make({ providerID: 'test', displayName: 'Test', lines: [session(used)], refreshedAt: fromUnixSeconds(1_800_000_000) })
  )
}

function makeStore(runtime: StubRuntime, suite: MemoryDefaults, now: Instant): WidgetDataStore {
  return makeDataStore([runtime], { defaults: suite, now: () => now })
}

const sessionLine = (store: WidgetDataStore): MetricLine | undefined => {
  const snapshot = store.snapshots['test']
  return snapshot ? ProviderSnapshot.line(snapshot, 'Session') : undefined
}

describe('RefreshSettingTests', () => {
  it('testRelaunchWithinTheIntervalShowsTheSavedSnapshotWithoutRefetching', async () => {
    const now = fromUnixSeconds(1_800_000_000)
    const suite = isolatedDefaults()

    storeSnapshot(20, 240, suite, now)

    const runtime = makeRuntime(80)
    const store = makeStore(runtime, suite, now)
    await store.refreshAll()
    expect(runtime.refreshCount, 'a snapshot under 5 minutes old is fresh at launch').toBe(0)
    expect(sessionLine(store)).toEqual(session(20))
    expect(store.data(runtime.widgetDescriptors[0]).valueText).toBe('80%')
  })

  it('testRelaunchRefetchesASnapshotOlderThanTheInterval', async () => {
    const now = fromUnixSeconds(1_800_000_000)
    const suite = isolatedDefaults()
    storeSnapshot(20, 301, suite, now)

    const runtime = makeRuntime(80)
    const store = makeStore(runtime, suite, now)
    expect(sessionLine(store), 'the saved snapshot paints at launch').toEqual(session(20))
    await store.refreshAll()
    expect(runtime.refreshCount).toBe(1)
    expect(sessionLine(store)).toEqual(session(80))
    expect(store.data(runtime.widgetDescriptors[0]).valueText).toBe('20%')
  })

  it('testASnapshotFromTheFutureIsRefetched', async () => {
    const now = fromUnixSeconds(1_800_000_000)
    const suite = isolatedDefaults()
    storeSnapshot(20, -60, suite, now)

    const runtime = makeRuntime(80)
    await makeStore(runtime, suite, now).refreshAll()
    expect(runtime.refreshCount).toBe(1)
  })
})
