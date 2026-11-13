import { describe, expect, it } from 'vitest'
import { DashboardRowModel } from '@core/models/DashboardRowModel'
import { MetricLine, type ProgressLine } from '@core/models/MetricLine'
import type { ResetDisplayMode } from '@core/models/ResetDisplayMode'
import { WidgetData } from '@core/models/WidgetData'
import { TimeFormatSetting } from '@core/stores/TimeFormatSetting'
import { Calendar } from '@core/support/Calendar'
import { Formatters } from '@core/support/Formatters'
import { MetricPeriod } from '@core/support/MetricPeriod'
import { addSeconds, fromUnixSeconds, type Instant, type Seconds } from '@core/support/time'

/**
 * `AntigravityUsageMapper.line(pool:fraction:resetTime:periodMs:)`, restated here because the provider
 * module is outside this suite: the remaining fraction clamps into 0...1 and becomes a percent used.
 */
function antigravityLine(pool: string, fraction: number, resetTime: Instant | undefined, periodMs: number): ProgressLine {
  const clamped = Math.max(0, Math.min(1, fraction))
  return MetricLine.percent(pool, (1 - clamped) * 100, resetTime, periodMs) as ProgressLine
}

describe('ResetDisplayTests', () => {
  const now = fromUnixSeconds(1_800_000_000)

  const utcCalendar = (): Calendar => new Calendar('utc', 1)

  it('testWhenLabelBucketsTheDayAndCollapsesImminentDeadlines', () => {
    const calendar = utcCalendar()
    const now = calendar.date(2024, 6, 1, 12)

    expect(Formatters.whenLabel(addSeconds(now, 2 * 3600 + 360), 'relative', now)).toBe('2h 6m')
    expect(Formatters.whenLabel(addSeconds(now, 2 * 3600), 'absolute', now, calendar)!.startsWith('today at ')).toBe(true)

    const tomorrow = addSeconds(calendar.addingDays(now, 1), 3600)
    expect(Formatters.whenLabel(tomorrow, 'absolute', now, calendar)!.startsWith('tomorrow at ')).toBe(true)

    const later = calendar.addingDays(now, 5)
    const label = Formatters.whenLabel(later, 'absolute', now, calendar)!
    expect(label.includes(' at ')).toBe(true)
    expect(label.startsWith('today') || label.startsWith('tomorrow')).toBe(false)

    expect(Formatters.whenLabel(addSeconds(now, 60), 'relative', now)).toBe('soon')
    expect(Formatters.whenLabel(addSeconds(now, -1), 'absolute', now, calendar)).toBe('soon')
  })

  it('testFreshSessionWindowReadsNotStartedAndSuppressesPacing', () => {
    const period: Seconds = 5 * 3600
    const data = new WidgetData({ title: 'Session', kind: 'percent', used: 0, limit: 100 })
    data.sessionStartSignal = 'zeroUsage'
    data.periodDurationMs = Math.trunc(period * 1000)
    data.resetsAt = addSeconds(now, period / 2)

    expect(data.isFreshSessionWindow(now)).toBe(true)
    expect(DashboardRowModel.make(data, now).mark).toEqual({
      type: 'bar',
      fill: 0,
      severity: 'normal',
      value: '0%',
      reset: undefined,
      isUsedUp: false
    })
    expect(data.meterState(now)).toBe('unpaced')

    expect(data.isFreshSessionWindow(addSeconds(data.resetsAt, 1))).toBe(false)
  })

  it('testAntigravitySessionJustUnderFullKeepsItsCountdownBehindTheRoundedPercent', () => {
    const line = antigravityLine('Gemini 5h', 0.99965, addSeconds(now, 2 * 3600), MetricPeriod.sessionMs)
    expect(line.used).toBeCloseTo(0.035, 3)
    expect(line.used).toBeGreaterThan(0)

    const data = new WidgetData({
      title: 'Gemini 5h',
      kind: 'percent',
      used: line.used,
      limit: line.limit,
      resetsAt: line.resetsAt,
      periodDurationMs: line.periodDurationMs
    })
    data.sessionStartSignal = 'zeroUsage'
    data.displayMode = 'remaining'

    expect(data.valueText).toBe('100%')
    expect(data.isFreshSessionWindow(now)).toBe(false)
    expect(DashboardRowModel.compactResetText(data, now)).toBe('2h')
    const mark = DashboardRowModel.make(data, now).mark
    expect(mark.type, 'expected a bar mark').toBe('bar')
    if (mark.type !== 'bar') return
    expect(mark.value).toBe('100%')
    expect(mark.reset).toBe('2h')
  })

  it('testAntigravityUntouchedAndExhaustedWindowsKeepTheirFreshAndCountdownReads', () => {
    const line = (fraction: number): WidgetData => {
      const progress = antigravityLine('Gemini 5h', fraction, addSeconds(now, 2 * 3600), MetricPeriod.sessionMs)
      const data = new WidgetData({
        title: 'Gemini 5h',
        kind: 'percent',
        used: progress.used,
        limit: progress.limit,
        resetsAt: progress.resetsAt,
        periodDurationMs: progress.periodDurationMs
      })
      data.sessionStartSignal = 'zeroUsage'
      data.displayMode = 'remaining'
      return data
    }

    const untouched = line(1)
    expect(untouched.isFreshSessionWindow(now)).toBe(true)
    expect(DashboardRowModel.compactResetText(untouched, now)).toBeUndefined()

    const exhausted = line(0)
    expect(exhausted.isFreshSessionWindow(now)).toBe(false)
    expect(DashboardRowModel.compactResetText(exhausted, now)).toBe('2h')
  })

  it('testAntigravityWeeklyKeepsTheFractionsRawPercentForTheCardToRound', () => {
    const line = antigravityLine('Gemini', 0.9742, addSeconds(now, 5 * 24 * 3600), MetricPeriod.weekMs)
    const data = new WidgetData({
      title: 'Gemini',
      kind: 'percent',
      used: line.used,
      limit: line.limit,
      resetsAt: line.resetsAt,
      periodDurationMs: line.periodDurationMs
    })
    data.displayMode = 'remaining'

    expect(data.valueText).toBe('97%')
  })

  it('testMissingResetDateSignalKeepsCountdownForSubOnePercentSession', () => {
    // Claude reports utilization in whole percents, so an in-flight session under 1% reads
    // used == 0 - but its reset date exists precisely because the window started. The row must show
    // the normal countdown, never "not started".
    const data = new WidgetData({ title: 'Session', kind: 'percent', used: 0, limit: 100 })
    data.sessionStartSignal = 'missingResetDate'
    data.periodDurationMs = 5 * 3600 * 1000
    data.resetsAt = addSeconds(now, 2 * 3600)

    expect(data.isFreshSessionWindow(now)).toBe(false)
    expect(DashboardRowModel.compactResetText(data, now)).toBe('2h')

    data.resetsAt = undefined
    expect(data.isFreshSessionWindow(now)).toBe(true)
    expect(DashboardRowModel.compactResetText(data, now)).toBeUndefined()
  })

  it('testNonSessionWindowNeverReadsNotStarted', () => {
    const period: Seconds = 7 * 24 * 3600
    const data = new WidgetData({ title: 'Weekly', kind: 'percent', used: 0, limit: 100 })
    data.periodDurationMs = Math.trunc(period * 1000)
    data.resetsAt = addSeconds(now, period / 2)

    expect(data.isFreshSessionWindow(now)).toBe(false)
    expect(DashboardRowModel.compactResetText(data, now)).toBe('3d 12h')
  })

  it('testACapWithoutAResetDateHasNoResetUnderEitherClockSetting', () => {
    const data = new WidgetData({ title: 'Credits', kind: 'dollars', used: 12, limit: 20 })
    for (const mode of ['relative', 'absolute'] as ResetDisplayMode[]) {
      data.resetDisplayMode = mode
      expect(DashboardRowModel.compactResetText(data, now)).toBeUndefined()
    }
  })

  // testResetsRowIsWiredOnlyOnClaudeCodexAndZAIAccounts needs `AccountProviderRuntime.widgetDescriptors`.
  // The four testResetsPopover... cases and testClaimingOneOfTwoResets... exercise `RateLimitResetsDetail` (Views).

  it('testCompactDurationAlwaysShowsHoursAtDayScale', () => {
    expect(Formatters.compactDuration(4 * 24 * 3600 + 52 * 60)).toBe('4d 0h')
    expect(Formatters.compactDuration(9 * 24 * 3600 + 21 * 3600)).toBe('9d 21h')
    expect(Formatters.compactDuration(5 * 3600)).toBe('5h')
    expect(Formatters.compactDuration(52 * 60)).toBe('52m')
  })

  it('testWeekdayTimeShowsMinutesSoTheHourNeverReadsAsADate', () => {
    const reset = fromUnixSeconds(1_794_382_293) // Wed 2026-11-11 07:31:33 UTC
    const madrid = 'Europe/Madrid'

    expect(TimeFormatSetting.weekdayTime('auto', reset, 'es-ES', madrid)).toBe('mié, 8:31')
    // Upstream expects "Wed 8:31\u{202F}AM". The port swaps ICU's narrow no-break space for a plain one.
    expect(TimeFormatSetting.weekdayTime('auto', reset, 'en-US', madrid)).toBe('Wed 8:31 AM')
    expect(TimeFormatSetting.weekdayTime('24h', reset, 'en-US', madrid)).toBe('Wed 08:31')
  })

  it('testCompactDurationOfAResetTooFarOffForAnIntShowsTheLongestCountdown', () => {
    expect(Formatters.compactDuration(1e300)).toBe('6405119470038038d 18h')
  })

  // Not upstream cases. The expected strings are what Foundation prints for an en_US user.
  describe('clock readings for an en-US user', () => {
    const reset = fromUnixSeconds(1_794_382_293) // Wed 2026-11-11 08:31 in Madrid
    const madrid = 'Europe/Madrid'

    it('shortTime follows the 12/24-hour setting', () => {
      expect(TimeFormatSetting.shortTime('auto', reset, 'en-US', madrid)).toBe('8:31 AM')
      expect(TimeFormatSetting.shortTime('12h', reset, 'en-GB', madrid)).toBe('8:31 am')
      expect(TimeFormatSetting.shortTime('24h', reset, 'en-US', madrid)).toBe('08:31')
      expect(TimeFormatSetting.shortTime('auto', reset, 'de-DE', madrid)).toBe('8:31')
      expect(TimeFormatSetting.shortTime('24h', addSeconds(reset, 16 * 3600 + 29 * 60), 'en-US', madrid)).toBe('01:00')
      expect(TimeFormatSetting.weekdayTime('auto', reset, 'en-GB', madrid)).toBe('Wed 08:31')
      expect(TimeFormatSetting.weekdayTime('12h', reset, 'de-DE', madrid)).toBe('Mi. 8:31 AM')
    })

    it('compactDuration rounds up to the minute and never reads zero', () => {
      expect(Formatters.compactDuration(1)).toBe('1m')
      expect(Formatters.compactDuration(60)).toBe('1m')
      expect(Formatters.compactDuration(61)).toBe('2m')
      expect(Formatters.compactDuration(3600)).toBe('1h')
      expect(Formatters.compactDuration(3601)).toBe('1h 1m')
      expect(Formatters.compactDuration(24 * 3600)).toBe('1d 0h')
      expect(Formatters.compactDuration(0)).toBeUndefined()
      expect(Formatters.compactDuration(-5)).toBeUndefined()
      expect(Formatters.compactDuration(Infinity)).toBeUndefined()
      expect(Formatters.compactDuration(NaN)).toBeUndefined()
    })
  })
})
