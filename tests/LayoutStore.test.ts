import { describe, expect, it } from 'vitest'
import { Account, ProviderKind } from '@core/models/Account'
import { ProviderCatalog } from '@core/providers/ProviderCatalog'
import { MemoryHubKeyVault } from '@core/services/HubKeyVault'
import { LayoutStore } from '@core/stores/LayoutStore'
import { WidgetRegistry } from '@core/stores/WidgetRegistry'
import type { Defaults } from '@core/support/Defaults'
import { mockRegistry, refusingHTTP } from './support/layoutSettingsHelpers'
import { InMemoryCredentialVault, isolatedDefaults } from './TestSupport'

function makeStore(defaults?: Defaults, registry: WidgetRegistry = mockRegistry()): LayoutStore {
  return new LayoutStore(registry, defaults ?? isolatedDefaults())
}

const ids = (items: { id: string }[]): string[] => items.map((item) => item.id)

describe('LayoutStoreTests', () => {
  it('testUndoWalksBackMultipleSteps', () => {
    const store = makeStore()
    const metricsBefore = ids(store.orderedSupportedMetrics('claude'))
    const providersBefore = ids(store.orderedProviders())
    expect(store.reorderMetric('claude.today', 'claude.session', 'claude')).toBe(true)
    const metricsAfter = ids(store.orderedSupportedMetrics('claude'))
    expect(metricsAfter).not.toEqual(metricsBefore)
    expect(store.reorderProvider('cursor', 'claude')).toBe(true)
    expect(ids(store.orderedProviders())).not.toEqual(providersBefore)

    expect(store.undo()).toBe(true)
    expect(ids(store.orderedProviders())).toEqual(providersBefore)
    expect(ids(store.orderedSupportedMetrics('claude'))).toEqual(metricsAfter)

    expect(store.undo()).toBe(true)
    expect(ids(store.orderedSupportedMetrics('claude'))).toEqual(metricsBefore)

    expect(store.canUndo).toBe(false)
    expect(store.undo()).toBe(false)
  })

  it('testAnAccountChangeThatKeepsEveryCardKeepsUndo', () => {
    const store = makeStore()
    const orderBefore = ids(store.orderedSupportedMetrics('cursor'))
    expect(store.reorderMetric('cursor.today', 'cursor.usage', 'cursor')).toBe(true)

    store.apply(store.registry)

    expect(store.undo(), "renaming an account keeps the layout's undo history").toBe(true)
    expect(ids(store.orderedSupportedMetrics('cursor'))).toEqual(orderBefore)
  })

  it('testUndoStackIsCappedAtMaxDepth', () => {
    const store = makeStore()
    for (let i = 0; i < LayoutStore.maxUndoDepth + 10; i++) {
      expect(store.reorderMetric('claude.weekly', 'claude.session', 'claude')).toBe(true)
    }
    let steps = 0
    while (store.undo()) steps += 1
    expect(steps).toBe(LayoutStore.maxUndoDepth)
  })

  it('testNoOpActionDoesNotRecordUndoStep', () => {
    const store = makeStore()
    store.reorderMetric('claude.weekly', 'claude.weekly', 'claude')

    expect(store.canUndo).toBe(false)
    expect(store.undo()).toBe(false)
  })

  it('testFreshCustomizeOrderFollowsProviderDeclarations', () => {
    const accounts = ProviderKind.allCases.map((kind, index) =>
      Account.make({ kind, label: ProviderKind.displayName(kind), addedAt: index * 1000 })
    )
    const providers = ProviderCatalog.make({
      accounts,
      vault: new InMemoryCredentialVault(),
      hubKeys: new MemoryHubKeyVault(),
      http: refusingHTTP()
    })
    const store = makeStore(undefined, WidgetRegistry.from(providers))

    for (const provider of providers) {
      expect(ids(store.orderedSupportedMetrics(provider.provider.id)), provider.provider.id).toEqual(ids(provider.widgetDescriptors))
    }
  })
})
