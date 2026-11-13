import { describe, expect, it } from 'vitest'
import { PriorityBoard, PriorityItem } from '@core/models/PriorityBoard'
import { PriorityLimits } from '@core/models/PriorityLimits'
import type { Provider } from '@core/models/Provider'
import { WidgetData } from '@core/models/WidgetData'
import { accountOf } from './MockData'

describe('PriorityLimitsTests', () => {
  it('testMovingOneLevelOntoOrPastTheOtherPushesTheOtherAStep', () => {
    let limits = PriorityLimits.standard
    limits = PriorityLimits.settingCritical(limits, 25)
    limits = PriorityLimits.settingWarning(limits, 20)
    expect([limits.warning, limits.critical], 'Warning at or under Critical drops Critical to Warning - 5').toEqual([20, 15])
    limits = PriorityLimits.settingCritical(limits, 25)
    expect([limits.warning, limits.critical], 'Critical at or over Warning raises Warning to Critical + 5').toEqual([30, 25])

    const badSave = PriorityLimits.make(20, 25)
    expect([badSave.warning, badSave.critical]).toEqual([20, 15])
    const outOfRange = PriorityLimits.make(90, 2)
    expect([outOfRange.warning, outOfRange.critical]).toEqual([70, 5])

    expect(PriorityLimits.standard, 'the standard limits are a value, never changed by a setter').toEqual({ warning: 30, critical: 10 })
    expect(PriorityLimits.warningOptions).toEqual([70, 65, 60, 55, 50, 45, 40, 35, 30, 25, 20])
    expect(PriorityLimits.criticalOptions).toEqual([25, 20, 15, 10, 5])
  })

  // testRaisingWarningTo45TurnsALimitWith40PercentLeftOrangeAndListsItUnderRunningOut runs through
  // `WidgetDataStore`. The model half: a reading carrying the raised limits turns orange and is listed.
  it('a limit with 40% left turns orange and is listed once Warning is raised to 45', () => {
    const provider: Provider = { id: 'test', kind: 'cursor' }
    const reading = (limits: PriorityLimits): WidgetData =>
      new WidgetData({ title: 'Weekly', kind: 'percent', used: 60, limit: 100, priorityLimits: limits })
    const runningOut = (data: WidgetData): string[] =>
      PriorityBoard.make({ accounts: [accountOf(provider, data)], now: Date.now() }).attention.map(PriorityItem.id)

    const standard = reading(PriorityLimits.standard)
    expect(standard.severity).toBe('normal')
    expect(runningOut(standard)).toEqual([])

    const raised = reading(PriorityLimits.settingWarning(PriorityLimits.standard, 45))
    expect(raised.severity).toBe('warning')
    expect(runningOut(raised)).toEqual(['test.Weekly'])
  })
})
