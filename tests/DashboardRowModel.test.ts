import { describe, expect, it } from 'vitest'
import { DashboardRowModel, type DashboardRowMark } from '@core/models/DashboardRowModel'
import { metricValue } from '@core/models/MetricValue'
import { WidgetData, type MeterSeverity } from '@core/models/WidgetData'
import type { WidgetDisplayMode } from '@core/models/WidgetDisplayMode'
import { Formatters } from '@core/support/Formatters'
import { addSeconds, fromUnixSeconds, type Seconds } from '@core/support/time'

/** `.bar(fill:severity:value:reset:isUsedUp:)` with Swift's default `isUsedUp: false`. */
function bar(fill: number, severity: MeterSeverity, value: string, reset: string | undefined, isUsedUp = false): DashboardRowMark {
  return { type: 'bar', fill, severity, value, reset, isUsedUp }
}

/** `.value(_:detail:severity:)` with Swift's defaults. */
function value(text: string, detail?: string, severity: MeterSeverity = 'normal'): DashboardRowMark {
  return { type: 'value', text, detail, severity }
}

describe('DashboardRowModelTests', () => {
  const now = fromUnixSeconds(1_800_000_000)
  const week: Seconds = 7 * 24 * 3600

  function paced(used: number, elapsed = 0.5, period: Seconds = week, title = 'Weekly'): WidgetData {
    const data = new WidgetData({ title, kind: 'percent', used, limit: 100 })
    data.displayMode = 'remaining'
    data.resetsAt = addSeconds(now, period * (1 - elapsed))
    data.periodDurationMs = Math.trunc(period * 1000)
    return data
  }

  it('testTheResetsFigureWarnsInTheColourOfTheResetThatExpiresNext', () => {
    const resets = new WidgetData({ title: 'Limit Resets', kind: 'count', used: 2, limit: undefined })
    resets.values = [metricValue(2, 'count', 'available')]
    resets.showsResetExpiries = true
    const day: Seconds = 24 * 3600
    const cases: [expiries: Seconds[], severity: MeterSeverity][] = [
      [[], 'normal'],
      [[7 * day + 3600], 'normal'],
      [[7 * day, 20 * day], 'warning'],
      [[20 * day, 2 * day], 'critical'],
      [[-1 * day, 20 * day], 'critical']
    ]
    for (const [expiries, severity] of cases) {
      resets.expiriesAt = expiries.map((offset) => addSeconds(now, offset))
      expect(DashboardRowModel.make(resets, now).mark, `${expiries}`).toEqual(value('2 available', undefined, severity))
    }
  })

  it('testOnlyABoundedReadingFlipsBetweenUsedAndLeft', () => {
    expect(paced(30).hasMeterStyleToggle).toBe(true)
    const badge = paced(30)
    badge.valueTextOverride = 'Disabled'
    expect(badge.hasMeterStyleToggle).toBe(false)
    const credits = new WidgetData({ title: 'Credits', kind: 'count', used: 452, limit: undefined })
    credits.values = [metricValue(452, 'count', 'credits')]
    expect(credits.hasMeterStyleToggle).toBe(false)
    const empty = paced(30)
    empty.hasData = false
    expect(empty.hasMeterStyleToggle).toBe(false)
  })

  it('testTheBarAndTheAmountCarryTheColour', () => {
    expect(DashboardRowModel.make(paced(93, 0.2), now).mark).toEqual(bar(0.07, 'critical', '7%', '5d 14h'))
    expect(DashboardRowModel.make(paced(49), now).mark).toEqual(bar(0.51, 'normal', '51%', '3d 12h'))
    expect(DashboardRowModel.make(paced(85, 0.9), now).mark).toEqual(bar(0.15, 'warning', '15%', '16h 48m'))
  })

  it('testAUsedUpLimitIsMarkedAndKeepsItsOrdinaryResetLine', () => {
    expect(DashboardRowModel.make(paced(100), now).mark).toEqual(bar(0, 'critical', '0%', '3d 12h', true))
    const used = paced(100)
    used.displayMode = 'used'
    expect(DashboardRowModel.make(used, now).mark).toEqual(bar(1, 'critical', '100%', '3d 12h', true))
  })

  it('testDollarLimitShowsCentsOnBothSidesOfTheMeter', () => {
    const data = new WidgetData({ title: 'Key Limit', kind: 'dollars', used: 9.6, limit: 10 })
    const cases: [WidgetDisplayMode, string][] = [
      ['remaining', '$0.40'],
      ['used', '$9.60']
    ]
    for (const [mode, expected] of cases) {
      data.displayMode = mode
      const mark = DashboardRowModel.make(data, now).mark
      expect(mark.type, 'Expected a bounded dollar row').toBe('bar')
      if (mark.type !== 'bar') return
      expect(mark.value).toBe(expected)
    }
  })

  it('testTheAmountSaysWhichReadingItIs', () => {
    const dollars = new WidgetData({ title: 'Credits', kind: 'dollars', used: 184.72, limit: 500 })
    dollars.displayMode = 'remaining'
    expect(DashboardRowModel.amountText(dollars)).toBe('$315.28 left')
    dollars.displayMode = 'used'
    expect(DashboardRowModel.amountText(dollars)).toBe('$184.72 used')
    const badge = paced(30)
    badge.valueTextOverride = 'Disabled'
    expect(DashboardRowModel.amountText(badge)).toBe('Disabled')
  })

  it('testAValueRowsSecondFigureIsItsDetail', () => {
    const today = new WidgetData({ title: 'Today', kind: 'dollars', used: 0, limit: undefined })
    today.values = [metricValue(12.5, 'dollars'), metricValue(3_000, 'count', 'tokens')]
    expect(DashboardRowModel.make(today, now).mark).toEqual(value('$12.50', '3K tokens'))
    expect(today.unboundedDetail).toBe('$12.50 · 3K tokens')
    today.values.push(metricValue(4, 'count', 'turns'))
    expect(DashboardRowModel.make(today, now).mark).toEqual(value('$12.50', '3K tokens · 4 turns'))
  })

  it('testAFreshSessionACapWithoutAResetAndABadgeLeaveTheResetEmpty', () => {
    const fresh = paced(0, 0.1, 5 * 3600, 'Session')
    fresh.sessionStartSignal = 'zeroUsage'
    expect(DashboardRowModel.make(fresh, now).mark).toEqual(bar(1, 'normal', '100%', undefined))

    const dollars = new WidgetData({ title: 'On-demand', kind: 'dollars', used: 12, limit: 20 })
    expect(DashboardRowModel.make(dollars, now).mark).toEqual(bar(0.6, 'normal', '$12', undefined))

    const badge = new WidgetData({ title: 'Status', kind: 'count', used: 0, limit: undefined })
    badge.valueTextOverride = 'Disabled'
    expect(DashboardRowModel.make(badge, now).mark).toEqual(value('Disabled'))
  })

  it('testTheBarsHoverIsTheProjectionAtReset', () => {
    expect(paced(30).paceTooltip(now)).toBe('~40% left at reset')
    expect(paced(46).paceTooltip(now)).toBe('~92% used at reset')
    expect(paced(49.8).paceTooltip(now)).toBe('~100% used at reset')
    expect(paced(60).paceTooltip(now)).toBe('~20% over limit at reset')
    expect(paced(50.2).paceTooltip(now)).toBe('~1% over limit at reset')
    expect(paced(100).paceTooltip(now)).toBe('Limit reached')
    expect(paced(4, 0.02).paceTooltip(now), 'a 4% reading early in the window is a level band, not a blow-out').toBeUndefined()
    expect(
      new WidgetData({ title: 'Credits', kind: 'dollars', used: 80, limit: 100 }).paceTooltip(now),
      'no window, no projection'
    ).toBeUndefined()
    const empty = paced(30)
    empty.hasData = false
    expect(empty.paceTooltip(now)).toBeUndefined()
  })

  it('testTheValuesHoverIsTheOtherReadingAndTheResetsTheOtherFormat', () => {
    const data = paced(30)
    expect(DashboardRowModel.meterStyleTooltip(data), 'the value reads 70%').toBe('30% used')
    data.displayMode = 'used'
    expect(DashboardRowModel.meterStyleTooltip(data), 'the value reads 30%').toBe('70% left')
    const badge = paced(30)
    badge.valueTextOverride = 'Disabled'
    expect(DashboardRowModel.meterStyleTooltip(badge)).toBeUndefined()
    const credits = new WidgetData({ title: 'Credits', kind: 'count', used: 452, limit: undefined })
    credits.values = [metricValue(452, 'count', 'credits')]
    expect(DashboardRowModel.meterStyleTooltip(credits)).toBeUndefined()

    expect(DashboardRowModel.resetTooltip(data, now), 'the reset reads 3d 12h').toBe(Formatters.compactClock(data.resetsAt!, now))
    data.resetDisplayMode = 'absolute'
    expect(DashboardRowModel.resetTooltip(data, now)).toBe('3d 12h')
    data.resetsAt = addSeconds(now, -1)
    expect(DashboardRowModel.resetTooltip(data, now), 'a due reset reads soon either way').toBeUndefined()
    const fresh = paced(0, 0.1, 5 * 3600, 'Session')
    fresh.sessionStartSignal = 'zeroUsage'
    expect(DashboardRowModel.resetTooltip(fresh, now)).toBeUndefined()
    expect(DashboardRowModel.resetTooltip(credits, now)).toBeUndefined()
  })

  it('testOnlyAnEmptyBarFades', () => {
    const row = (fill: number, isUsedUp: boolean): DashboardRowModel => ({
      label: 'Weekly',
      mark: bar(fill, 'critical', '', undefined, isUsedUp),
      showsClockTimes: false
    })
    expect(DashboardRowModel.isFaded(row(0, true)), 'used up, shown as left').toBe(true)
    expect(DashboardRowModel.isFaded(row(1, true)), 'used up, shown as used').toBe(false)
    expect(DashboardRowModel.isFaded(row(0.05, false))).toBe(false)
  })
})
