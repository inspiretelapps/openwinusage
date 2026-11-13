import { describe, expect, it } from 'vitest'
import { LayoutPersistence } from '@core/stores/LayoutPersistence'
import { LayoutStore } from '@core/stores/LayoutStore'
import { MockData } from './MockData'
import { mockRegistry } from './support/layoutSettingsHelpers'
import { isolatedDefaults } from './TestSupport'

const ids = (items: { id: string }[]): string[] => items.map((item) => item.id)

describe('LayoutPersistenceTests', () => {
  it('testALayoutWithStarsAndHiddenMetricsKeepsItsHiddenMetrics', () => {
    const defaults = isolatedDefaults()
    const saved = {
      hiddenMetricIDs: ['claude.weekly', 'claude.extra'],
      pinnedMetricIDs: ['claude.session', 'codex.session'],
      providerOrder: ['codex', 'claude', 'cursor'],
      metricOrderByProvider: { claude: ['claude.today', 'claude.session'] },
      seededProviderIDs: ['claude', 'codex', 'cursor']
    }
    defaults.set(LayoutPersistence.key, saved)

    const store = new LayoutStore(mockRegistry(), defaults)

    expect(ids(store.orderedProviders()), 'the provider order survives').toEqual(['codex', 'claude', 'cursor'])
    expect(ids(store.orderedSupportedMetrics('claude')).slice(0, 2), 'the metric order survives').toEqual(['claude.today', 'claude.session'])
    const visible = new Set(ids(store.visibleDescriptors))
    expect(new Set(ids(MockData.descriptors).filter((id) => !visible.has(id))), 'a metric saved as hidden stays hidden').toEqual(
      new Set(['claude.weekly', 'claude.extra'])
    )
  })

  it('testALayoutSavedWithoutHiddenMetricsStillLoads', () => {
    const defaults = isolatedDefaults()
    const saved = {
      providerOrder: ['codex', 'claude', 'cursor'],
      metricOrderByProvider: { claude: ['claude.today', 'claude.session'] },
      seededProviderIDs: ['claude', 'codex', 'cursor']
    }
    defaults.set(LayoutPersistence.key, saved)

    const store = new LayoutStore(mockRegistry(), defaults)

    expect(ids(store.orderedProviders())).toEqual(['codex', 'claude', 'cursor'])
    expect(ids(store.orderedSupportedMetrics('claude')).slice(0, 2)).toEqual(['claude.today', 'claude.session'])
    expect(new Set(ids(store.visibleDescriptors))).toEqual(new Set(ids(MockData.descriptors)))
  })
})
