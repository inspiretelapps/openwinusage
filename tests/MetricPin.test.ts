import { describe, expect, it } from 'vitest'
import { AppContainer } from '@core/app/AppContainer'
import { Account, AccountCredential } from '@core/models/Account'
import { DashboardLine } from '@core/models/DashboardFamilies'
import { MetricLine } from '@core/models/MetricLine'
import { PriorityItem, type PinnedMetric } from '@core/models/PriorityBoard'
import { ProviderSnapshot } from '@core/models/ProviderSnapshot'
import { LayoutPersistence } from '@core/stores/LayoutPersistence'
import { LayoutStore } from '@core/stores/LayoutStore'
import { MockData } from './MockData'
import { makeAccountStore, makeDataStore, mockRegistry, refusingHTTP, waitUntil } from './support/layoutSettingsHelpers'
import { isolatedDefaults } from './TestSupport'

const pinIDs = (pins: PinnedMetric[]): string[] => pins.map((pin) => DashboardLine.id(pin.line))
const itemIDs = (items: PriorityItem[]): string[] => items.map(PriorityItem.id)

describe('MetricPinTests', () => {
  it('testAPinIsSavedPerAccountAndMetricAndSurvivesARestart', () => {
    const defaults = isolatedDefaults()
    const oldStars = {
      pinnedMetricIDs: ['claude.session'],
      providerOrder: ['claude', 'codex', 'cursor'],
      metricOrderByProvider: {},
      seededProviderIDs: ['claude', 'codex', 'cursor']
    }
    defaults.set(LayoutPersistence.key, oldStars)
    const store = new LayoutStore(mockRegistry(), defaults)
    expect(store.isMetricPinned('claude.session'), 'a menu-bar star from an older build is not a pin').toBe(false)

    expect(store.setMetricPinned('claude.weekly', true)).toBe(true)

    const relaunched = new LayoutStore(mockRegistry(), defaults)
    expect(relaunched.isMetricPinned('claude.weekly')).toBe(true)
    expect(relaunched.isMetricPinned('codex.weekly'), 'a pin belongs to one account').toBe(false)
    expect(relaunched.isMetricPinned('claude.session'), 'and to one metric').toBe(false)

    expect(relaunched.setMetricPinned('claude.weekly', false)).toBe(true)
    expect(new LayoutStore(mockRegistry(), defaults).isMetricPinned('claude.weekly')).toBe(false)
  })

  it('testAHiddenMetricCannotBePinnedAndHidingUnpinsIt', () => {
    const defaults = isolatedDefaults()
    const store = new LayoutStore(mockRegistry(), defaults)
    expect(store.setMetricPinned('claude.weekly', true)).toBe(true)

    expect(store.setMetricShown('claude.weekly', false)).toBe(true)
    expect(store.isMetricPinned('claude.weekly')).toBe(false)
    expect(store.setMetricPinned('claude.weekly', true)).toBe(false)
    expect(new LayoutStore(mockRegistry(), defaults).isMetricPinned('claude.weekly')).toBe(false)

    expect(store.setMetricShown('claude.weekly', true)).toBe(true)
    expect(store.isMetricPinned('claude.weekly'), 'showing it again does not bring the pin back').toBe(false)
  })

  it('testPinnedMetricsLeadPriorityInDashboardOrderAndAreListedOnlyThere', () => {
    const defaults = isolatedDefaults()
    const layout = new LayoutStore(mockRegistry(), defaults)
    const data = makeDataStore([], { registry: mockRegistry(), defaults })
    const lines: Record<string, MetricLine[]> = {
      claude: [MetricLine.percent('Session', 40), MetricLine.percent('Weekly', 50)],
      codex: [MetricLine.percent('Session', 100), MetricLine.percent('Weekly', 50)],
      cursor: [MetricLine.percent('Usage', 98)]
    }
    for (const provider of MockData.providers) {
      data.setSnapshot(provider.id, ProviderSnapshot.forProvider(provider, undefined, lines[provider.id] ?? []))
    }
    expect(layout.reorderProvider('codex', 'claude')).toBe(true)
    expect(layout.reorderMetric('claude.weekly', 'claude.session', 'claude')).toBe(true)
    for (const id of ['claude.session', 'claude.weekly', 'codex.weekly']) {
      expect(layout.setMetricPinned(id, true)).toBe(true)
    }

    const board = data.priorityBoard(layout.displayGroups, layout.state.priorityPinIDs, Date.now())

    expect(pinIDs(board.pinned), 'the saved account order, then each account\'s metric order').toEqual([
      'codex.weekly',
      'claude.weekly',
      'claude.session'
    ])
    expect(itemIDs(board.attention)).toEqual(['cursor.usage'])
    expect(itemIDs(board.usedUp)).toEqual(['codex.session'])

    expect(layout.setMetricPinned('cursor.usage', true)).toBe(true)
    const allPinned = data.priorityBoard(layout.displayGroups, layout.state.priorityPinIDs, Date.now())
    expect(itemIDs(allPinned.attention), 'a pinned limit that is running out is listed under Running Out').toEqual(['cursor.usage'])
    expect(pinIDs(allPinned.pinned), 'and only there').toEqual(['codex.weekly', 'claude.weekly', 'claude.session'])
    expect(allPinned.showsClearRow).toBe(false)
  })

  it('testRemovingAnAccountRemovesItsPins', async () => {
    const defaults = isolatedDefaults()
    const accounts = makeAccountStore(defaults)
    const personal = accounts.add({ kind: 'claude', label: 'Personal', credential: AccountCredential.apiKey('key') })
    const work = accounts.add({ kind: 'claude', label: 'Work', credential: AccountCredential.apiKey('key') })
    const container = new AppContainer({ accounts, defaults, http: refusingHTTP() })
    try {
      const layout = container.layout
      await waitUntil(() => layout.provider(Account.cardID(work)) !== undefined)
      expect(layout.setMetricPinned(`${Account.cardID(personal)}.session`, true)).toBe(true)
      expect(layout.setMetricPinned(`${Account.cardID(work)}.session`, true)).toBe(true)

      accounts.remove(personal.id)
      await waitUntil(() => layout.provider(Account.cardID(personal)) === undefined)

      expect([...layout.state.priorityPinIDs]).toEqual([`${Account.cardID(work)}.session`])
    } finally {
      container.dispose()
    }
  })
})
