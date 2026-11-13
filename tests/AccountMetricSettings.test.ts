import { describe, expect, it } from 'vitest'
import { LayoutStore } from '@core/stores/LayoutStore'
import { mockRegistry } from './support/layoutSettingsHelpers'
import { isolatedDefaults } from './TestSupport'

const ids = (items: { id: string }[]): string[] => items.map((item) => item.id)

describe('AccountMetricSettingsTests', () => {
  it('testHidingAndReorderingAnAccountsMetricsSurvivesARestart', () => {
    const defaults = isolatedDefaults()
    const store = new LayoutStore(mockRegistry(), defaults)

    expect(store.setMetricShown('claude.weekly', false)).toBe(true)
    expect(store.reorderMetric('claude.today', 'claude.session', 'claude')).toBe(true)

    const relaunched = new LayoutStore(mockRegistry(), defaults)
    expect(relaunched.isMetricShown('claude.weekly')).toBe(false)
    expect(ids(relaunched.orderedSupportedMetrics('claude')), 'the account page keeps listing a hidden metric in its place').toEqual([
      'claude.today',
      'claude.session',
      'claude.weekly',
      'claude.extra'
    ])
    const group = relaunched.displayGroups.find((candidate) => candidate.provider.id === 'claude')
    expect(
      group ? ids(group.metrics) : undefined,
      'All Usage, Priority and the menu bar all read these groups, so the hidden metric leaves each'
    ).toEqual(['claude.today', 'claude.session', 'claude.extra'])
    expect(relaunched.isMetricShown('codex.weekly'), 'hiding is per account').toBe(true)

    expect(relaunched.setMetricShown('claude.weekly', true)).toBe(true)
    expect(new LayoutStore(mockRegistry(), defaults).isMetricShown('claude.weekly')).toBe(true)
  })

  // testTheAccountPageSwitchHidesItsMetric hosts the SwiftUI AccountDetailView and clicks its NSSwitch: no port.
})
