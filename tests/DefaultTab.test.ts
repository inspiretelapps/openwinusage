import { describe, expect, it } from 'vitest'
import { DashboardTab } from '@core/models/DashboardTab'
import { PopoverState } from '../src/renderer/src/state/PopoverState'
import { isolatedDefaults } from './TestSupport'

describe('DefaultTabTests', () => {
  it('testColdLaunchAndReopenUseTheDefaultEvenAfterAnotherTabWasSelected', () => {
    const defaults = isolatedDefaults()
    const popover = new PopoverState()

    popover.show('allUsage')
    popover.show(DashboardTab.preferred(defaults))
    expect(popover.dashboardTab).toBe('priority')

    defaults.set(DashboardTab.defaultKey, 'allUsage' satisfies DashboardTab)
    popover.dashboardTab = 'priority'
    popover.show(DashboardTab.preferred(defaults))
    expect(popover.dashboardTab).toBe('allUsage')
  })

  it('testClosingThePanelReturnsSettingsToItsFirstTab', () => {
    const popover = new PopoverState()
    popover.settingsTab = 'alerts'
    popover.reset()
    expect(popover.settingsTab).toBe('general')
  })
})
