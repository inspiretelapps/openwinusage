import { describe, expect, it } from 'vitest'
import { DashboardRowModel } from '@core/models/DashboardRowModel'
import type { MetricKind } from '@core/models/MetricKind'
import { WidgetData } from '@core/models/WidgetData'
import type { WidgetDisplayMode } from '@core/models/WidgetDisplayMode'
import { addSeconds, fromUnixSeconds, type Seconds } from '@core/support/time'

describe('PaceMarkTests', () => {
  const now = fromUnixSeconds(1_800_000_000)
  const week: Seconds = 7 * 24 * 3600

  function limit(
    used: number,
    options: { elapsed?: number; period?: Seconds; kind?: MetricKind; displayMode?: WidgetDisplayMode } = {}
  ): WidgetData {
    const period = options.period ?? week
    const data = new WidgetData({
      title: 'Weekly',
      kind: options.kind ?? 'percent',
      used,
      limit: 100,
      displayMode: options.displayMode ?? 'remaining'
    })
    data.resetsAt = addSeconds(now, period * (1 - (options.elapsed ?? 0.25)))
    data.periodDurationMs = Math.trunc(period * 1000)
    return data
  }

  it('testTheMarkSitsAtTheElapsedShareUnderUsedAndAtWhatWouldBeLeftUnderLeft', () => {
    const used = DashboardRowModel.make(limit(60, { displayMode: 'used' }), now).paceMark
    expect(used).toBeDefined()
    expect(used!).toBeCloseTo(0.25, 9)
    const left = DashboardRowModel.make(limit(60, { displayMode: 'remaining' }), now).paceMark
    expect(left).toBeDefined()
    expect(left!).toBeCloseTo(0.75, 9)
  })

  // testTheMarkIsDrawnAtAboutHalfStrength resolves SwiftUI colors: no port.

  it('testTheMarkMovesWithTheClock', () => {
    const data = limit(10, { elapsed: 0.25, displayMode: 'used' })
    const later = data.paceMark(addSeconds(now, week / 4))
    expect(later).toBeDefined()
    expect(later!).toBeCloseTo(0.5, 9)
  })

  it('testEveryLimitWithAWindowGetsAMarkEvenUnusedOnPaceOrInDollars', () => {
    expect(limit(0).paceMark(now), "0% used still shows it's under pace").toBeDefined()
    expect(limit(25, { displayMode: 'used' }).paceMark(now), 'exactly on pace').toBeDefined()
    expect(limit(90).paceMark(now), 'over pace').toBeDefined()
    expect(limit(40, { kind: 'dollars' }).paceMark(now), 'a dollar limit with a window, like Cursor Extra Usage').toBeDefined()
  })

  it('testNoMarkWithoutAWindowThatHasStartedAndNotReset', () => {
    expect(limit(10, { elapsed: 0.009 }).paceMark(now), 'under 1% of a week has passed').toBeUndefined()
    expect(limit(10, { elapsed: 0.011 }).paceMark(now)).toBeDefined()
    expect(limit(10, { elapsed: 50.0 / 3600, period: 3600 }).paceMark(now), 'under a minute has passed').toBeUndefined()
    expect(limit(10, { elapsed: 70.0 / 3600, period: 3600 }).paceMark(now)).toBeDefined()
    expect(limit(10, { elapsed: 1 }).paceMark(now), 'at the reset').toBeUndefined()
    expect(limit(10, { elapsed: 1.1 }).paceMark(now), 'after the reset').toBeUndefined()

    const noPeriod = limit(10)
    noPeriod.periodDurationMs = undefined
    expect(noPeriod.paceMark(now), "a limit with no window length, like OpenRouter's Key Limit").toBeUndefined()
    const noReset = limit(10)
    noReset.resetsAt = undefined
    expect(noReset.paceMark(now)).toBeUndefined()

    const fresh = limit(0)
    fresh.sessionStartSignal = 'zeroUsage'
    expect(fresh.paceMark(now), "a session that hasn't started").toBeUndefined()
  })

  it('testNoMarkOnFiguresBalancesOrUsedUpLimits', () => {
    const balance = new WidgetData({ title: 'Credits', kind: 'dollars', used: 12.4, limit: undefined })
    balance.resetsAt = addSeconds(now, week / 2)
    balance.periodDurationMs = Math.trunc(week * 1000)
    expect(balance.paceMark(now)).toBeUndefined()
    expect(DashboardRowModel.make(balance, now).paceMark).toBeUndefined()

    const noData = limit(10)
    noData.hasData = false
    expect(noData.paceMark(now)).toBeUndefined()

    expect(limit(100).paceMark(now), 'used up').toBeUndefined()
    expect(limit(99.996).paceMark(now), 'used up at the shown precision').toBeUndefined()
    expect(DashboardRowModel.make(limit(100, { displayMode: 'used' }), now).paceMark).toBeUndefined()
  })

  // The store half of testTheSwitchDefaultsToOffTurnsMarksOnAndOffOnBothTabsAndSurvivesARelaunch needs
  // `WidgetDataStore`. What the switch sets on each reading is `showsPaceMarks`:
  it('a reading with pace marks switched off has no mark', () => {
    const data = limit(95, { elapsed: 0.5, displayMode: 'used' })
    data.showsPaceMarks = false
    expect(data.paceMark(now)).toBeUndefined()
    expect(DashboardRowModel.make(data, now).paceMark).toBeUndefined()
    data.showsPaceMarks = true
    expect(data.paceMark(now)).toBe(0.5)
    expect(DashboardRowModel.make(data, now).paceMark).toBe(0.5)
  })
})
