import { describe, expect, it } from 'vitest'
import { MetricLine, ProgressFormat } from '@core/models/MetricLine'
import type { Provider } from '@core/models/Provider'
import { ProviderSnapshot } from '@core/models/ProviderSnapshot'
import { WidgetData } from '@core/models/WidgetData'
import { WidgetDescriptor } from '@core/models/WidgetDescriptor'
import { RefreshSetting } from '@core/stores/RefreshSetting'
import type { WidgetDataStore } from '@core/stores/WidgetDataStore'
import { addSeconds, fromUnixSeconds, type Instant } from '@core/support/time'
import { makeDataStore } from './support/layoutSettingsHelpers'
import { StubRuntime, isolatedDefaults } from './TestSupport'

const now = fromUnixSeconds(1_800_000_000)

function snapshot(refreshedAt: Instant): ProviderSnapshot {
  return ProviderSnapshot.make({
    providerID: 'devin',
    displayName: 'Devin',
    plan: 'Team 5x',
    lines: [MetricLine.progress('Weekly quota', 40, 100, ProgressFormat.percent)],
    refreshedAt
  })
}

function devinDescriptor(): { provider: Provider; descriptor: WidgetDescriptor } {
  const provider: Provider = { id: 'devin', kind: 'claude' }
  const descriptor = new WidgetDescriptor(provider, 'weekly', 'Weekly quota', new WidgetData({ title: 'Weekly', kind: 'percent', used: 0, limit: 100 }))
  return { provider, descriptor }
}

function makeStore(): WidgetDataStore {
  const { provider, descriptor } = devinDescriptor()
  const runtime = StubRuntime.snapshot(provider, [descriptor], snapshot(now))
  return makeDataStore([runtime], { defaults: isolatedDefaults(), now: () => now })
}

describe('StalenessLabelTests', () => {
  it('testFreshSnapshotsAndFutureClockSkewHaveNoStalenessLabel', () => {
    for (const offset of [0, -RefreshSetting.interval, -(RefreshSetting.stalenessThreshold - 1), 3_600]) {
      const store = makeStore()
      store.setSnapshot('devin', snapshot(addSeconds(now, offset)))
      expect(store.stalenessHint('devin'), `offset: ${offset}`).toBeUndefined()
    }
  })

  it('testSnapshotExactlyAtThresholdIsStale', () => {
    const store = makeStore()
    store.setSnapshot('devin', snapshot(addSeconds(now, -RefreshSetting.stalenessThreshold)))
    expect(store.stalenessHint('devin')).toBeDefined()
  })

  it('testVeryStaleSnapshotFormatsTooltipInDays', () => {
    const store = makeStore()
    store.setSnapshot('devin', snapshot(addSeconds(now, -3 * 24 * 60 * 60)))
    expect(store.stalenessHint('devin')).toBe('Last updated 3d 0h ago')
  })

  it('testMissingSnapshotHasNoStalenessLabel', () => {
    const store = makeStore()
    expect(store.stalenessHint('devin')).toBeUndefined()
  })

  it('testFailingRefreshKeepsFossilButLabelsItStale', async () => {
    const { provider, descriptor } = devinDescriptor()
    const runtime = StubRuntime.failure(provider, [descriptor], { message: 'Not logged in', kind: { type: 'refused' } })
    const store = makeDataStore([runtime], { defaults: isolatedDefaults(), now: () => now })
    store.setSnapshot('devin', snapshot(addSeconds(now, -3 * 60 * 60)))

    await store.refreshAll()

    expect(runtime.refreshCount).toBe(1)
    expect(store.plan('devin'), 'stale-while-revalidate keeps the last good snapshot').toBe('Team 5x')
    expect(store.errorMessage('devin'), 'the failed refresh still raises the warning').toBeDefined()
    expect(store.stalenessHint('devin'), 'the fossil is now visibly labelled as old').toBe('Last updated 3h ago')
  })
})
