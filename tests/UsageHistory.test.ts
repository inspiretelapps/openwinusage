import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { HistoryRow } from '@core/models/HistoryRow'
import { MetricLine } from '@core/models/MetricLine'
import { metricValue } from '@core/models/MetricValue'
import {
  UsageBreakdown,
  UsageHistory,
  UsageTotals,
  UsageWindow,
  type UsageBreakdownModel,
  type UsageDay,
  type UsageMeasure
} from '@core/models/UsageHistory'
import { Calendar } from '@core/support/Calendar'
import { OpenUsageISO8601 } from '@core/support/OpenUsageISO8601'
import { addSeconds, fromUnixSeconds, secondsBetween, toUnixSeconds } from '@core/support/time'
import { withTimeZone } from './MockData'

const range = (count: number): number[] => Array.from({ length: count }, (_, index) => index)

/** The ranking shown when the user has no saved figure preference. */
function models(breakdown: UsageBreakdown): UsageBreakdownModel[] {
  const first = UsageBreakdown.modelFigures(breakdown)[0]
  return first === undefined ? [] : UsageBreakdown.models(breakdown, first)
}

/**
 * Upstream builds its calendar with `TimeZone(identifier: "Asia/Dubai")`. The port's calendar is the
 * machine's zone or UTC, so the suite runs with the machine in Dubai instead.
 */
describe('UsageHistoryTests', () => {
  const savedTimeZone = process.env.TZ
  beforeAll(() => {
    process.env.TZ = 'Asia/Dubai'
  })
  afterAll(() => {
    if (savedTimeZone === undefined) delete process.env.TZ
    else process.env.TZ = savedTimeZone
  })

  const calendar = new Calendar('local', 1)
  /** 00:30 on 31 October in Dubai, still 30 October in UTC. */
  const now = fromUnixSeconds(1_793_392_200)

  function history(days: Record<number, UsageDay>): UsageHistory {
    const starts = UsageHistory.dayStarts(range(30), now, calendar)
    return UsageHistory.make(calendar, now, new Map(Object.entries(days).map(([offset, day]) => [starts[Number(offset)], day])))
  }

  function everyDay(totals: UsageTotals): Record<number, UsageDay> {
    return Object.fromEntries(range(30).map((offset) => [offset, { totals }]))
  }

  it('the machine zone the suite runs in is Dubai', () => {
    expect(new Date(now).getHours()).toBe(0)
    expect(new Date(now).getDate()).toBe(31)
    expect(new Date(now).getUTCDate()).toBe(30)
  })

  it('testDaysAcrossSantiagosClockChangesAreItsDayStarts', () => {
    withTimeZone('America/Santiago', (santiago) => {
      const september6Noon = fromUnixSeconds(1_788_706_800)
      const september7Noon = fromUnixSeconds(1_788_793_200)

      expect(
        UsageHistory.dayStarts([0, 1, 2], september6Noon, santiago).map(toUnixSeconds),
        'Sep 6 starts at 01:00 and the days before at midnight'
      ).toEqual([1_788_667_200, 1_788_580_800, 1_788_494_400])
      const september = UsageHistory.dayStarts([0, 1, 2], september7Noon, santiago)
      expect(secondsBetween(september[0], september[1]), 'Sep 6 is 23 hours').toBe(23 * 3600)
      expect(secondsBetween(september[1], september[2])).toBe(24 * 3600)
      for (const start of [...UsageHistory.dayStarts(range(30), september6Noon, santiago), ...september]) {
        expect(santiago.startOfDay(start)).toBe(start)
      }
    })
  })

  it('testAZeroFromReadDaysConfirmsNoUsageOnlyWhenNoDayFailed', () => {
    const row = HistoryRow.window(UsageWindow.lastDays(2), 'tokens')
    const title = HistoryRow.title(row)
    const expected = MetricLine.values(title, [metricValue(0, 'count', 'tokens')])
    const days: Record<number, UsageDay> = { 0: { totals: UsageTotals.zero(['tokens']) }, 1: { totals: UsageTotals.empty() } }

    const sparse = history(days)
    expect(HistoryRow.line(row, title, sparse)).toEqual(expected)
    expect(UsageBreakdown.isEmpty(HistoryRow.breakdown(row, sparse)!), 'both days were successfully read').toBe(true)

    delete days[1]
    const partial = history(days)
    expect(HistoryRow.line(row, title, partial), 'keep the figure from the day that was read').toEqual(expected)
    expect(UsageBreakdown.isEmpty(HistoryRow.breakdown(row, partial)!), "the other day's activity is unknown").toBe(false)
    expect(HistoryRow.line(row, title, history({}))).toBeUndefined()
  })

  it('testARowSumsTheDaysThatReportAFigureAndHidesWhenNoneDo', () => {
    const days = everyDay(UsageTotals.make({ spend: 1, usageEvents: 2, tokens: 100 }))
    days[3] = { totals: UsageTotals.make({ spend: 1, usageEvents: 2 }) }
    const all = history(days)

    expect(HistoryRow.line(HistoryRow.window(UsageWindow.lastDays(30), 'spend', 'tokens'), 'Last 30 Days', all)).toEqual(
      MetricLine.values('Last 30 Days', [metricValue(30, 'dollars'), metricValue(2_900, 'count', 'tokens')])
    )
    expect(HistoryRow.line(HistoryRow.window(UsageWindow.lastDays(30), 'requests'), 'Last 30 Days', all)).toBeUndefined()
    expect(HistoryRow.line(HistoryRow.measure('Usage Events', 'usageEvents', UsageWindow.lastDays(30)), 'Usage Events', all)).toEqual(
      MetricLine.values('Usage Events', [metricValue(60, 'count', 'in 30 days')])
    )
  })

  it('testRestoredWindowsUseTheOriginalReportingDayAfterProviderMidnight', () => {
    const beforeUTC = OpenUsageISO8601.date('2026-10-31T23:59:00Z')!
    const afterUTC = OpenUsageISO8601.date('2026-11-01T00:01:00Z')!
    expect(beforeUTC).toBeDefined()
    expect(afterUTC).toBeDefined()
    const utc = Calendar.utc
    // `Date.FormatStyle(date: .abbreviated, time: .omitted, timeZone: utc)`
    const format = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' })
    const restored = (window: UsageWindow, calendar: Calendar): UsageBreakdown => {
      const history = UsageHistory.make(calendar, beforeUTC)
      UsageHistory.setReported(history, window, UsageTotals.zero(['tokens']))
      const detail = UsageBreakdown.make(window, history)
      return JSON.parse(JSON.stringify(detail)) as UsageBreakdown
    }

    const today = restored(UsageWindow.today, utc)
    expect(UsageBreakdown.archivedTitle(today, beforeUTC)).toBeUndefined()
    expect(UsageBreakdown.archivedTitle(today, afterUTC)).toBe(format.format(beforeUTC))
    const yesterday = restored(UsageWindow.yesterday, utc)
    expect(UsageBreakdown.archivedTitle(yesterday, afterUTC)).toBe(format.format(addSeconds(beforeUTC, -86_400)))
    expect(UsageBreakdown.archivedTitle(restored(UsageWindow.today, calendar), afterUTC), 'both instants are Nov 1 in Dubai').toBeUndefined()

    // Not upstream assertions: the titles of the longer windows, and what an en-US user reads.
    if (format.resolvedOptions().locale === 'en-US') expect(UsageBreakdown.archivedTitle(today, afterUTC)).toBe('Oct 31, 2026')
    const date = format.format(beforeUTC)
    expect(UsageBreakdown.archivedTitle(restored(UsageWindow.lastDays(30), utc), afterUTC)).toBe(`30 Days Ending ${date}`)
    expect(UsageBreakdown.archivedTitle(restored(UsageWindow.priorDays(30), utc), afterUTC)).toBe(
      `30 Days Ending ${format.format(addSeconds(beforeUTC, -86_400))}`
    )
    expect(UsageBreakdown.archivedTitle(restored(UsageWindow.thisWeek, utc), afterUTC)).toBe(`Week Through ${date}`)
    expect(UsageBreakdown.archivedTitle(restored(UsageWindow.thisMonth, utc), afterUTC)).toBe(`Month Through ${date}`)
  })

  it('testEncodedRankingsKeepOnlyTheTopModelsAndOtherForEachFigure', () => {
    const byModel = Object.fromEntries(
      range(15).map((offset) => {
        const index = offset + 1
        return [`model-${index}`, UsageTotals.make({ spend: index, tokens: 16 - index })]
      })
    )
    const day: UsageDay = { totals: UsageTotals.make({ spend: 120, tokens: 120 }), byModel }
    const detail = UsageBreakdown.make(UsageWindow.today, history({ 0: day }))
    const encoded = JSON.stringify(detail)
    const saved = JSON.parse(encoded) as UsageBreakdown

    expect(saved).toEqual(detail)
    expect(UsageBreakdown.models(saved, 'cost').map((model) => model.name)).toEqual([
      'model-15',
      'model-14',
      'model-13',
      'model-12',
      'model-11',
      'Other'
    ])
    expect(UsageBreakdown.models(saved, 'tokens').map((model) => model.name)).toEqual([
      'model-1',
      'model-2',
      'model-3',
      'model-4',
      'model-5',
      'Other'
    ])
    expect(UsageBreakdown.models(saved, 'cost').at(-1)?.dollars).toBe(55)
    expect(UsageBreakdown.models(saved, 'tokens').at(-1)?.tokens).toBe(55)
    for (const index of [6, 7, 8, 9, 10]) {
      expect(encoded.includes(`"model-${index}"`)).toBe(false)
    }
  })

  it('testModelsNoOneWasChargedForRankByTokensWithNoDollars', () => {
    const byModel = {
      a: UsageTotals.make({ spend: 0, tokens: 100 }),
      b: UsageTotals.make({ spend: 0, tokens: 900 })
    }
    const days = { 0: { totals: UsageTotals.make({ spend: 0, tokens: 1_000 }), byModel } }

    const today = UsageBreakdown.make(UsageWindow.today, history(days))

    expect(UsageBreakdown.modelFigures(today)).toEqual(['tokens'])
    expect(models(today).map((model) => model.name)).toEqual(['b', 'a'])
    expect(models(today).map((model) => model.dollars)).toEqual([undefined, undefined])
  })

  it('testUnattributedUsageCountsTowardTotalsWhileModelFiguresShowOnlyReportedAmounts', () => {
    const attributed: UsageDay = {
      totals: UsageTotals.make({ spend: 10, tokens: 100 }),
      byModel: { a: UsageTotals.make({ spend: 8, tokens: 40 }), b: UsageTotals.make({ spend: 2 }) }
    }
    const unsplit: UsageDay = { totals: UsageTotals.make({ spend: 100, tokens: 100_000 }) }
    const breakdown = UsageBreakdown.make(UsageWindow.lastDays(2), history({ 0: attributed, 1: unsplit }))

    expect(UsageTotals.get(breakdown.totals, 'spend')).toBe(110)
    expect(UsageTotals.get(breakdown.totals, 'tokens')).toBe(100_100)
    expect(UsageBreakdown.models(breakdown, 'cost').map((model) => model.name)).toEqual(['a', 'b'])
    expect(UsageBreakdown.models(breakdown, 'cost').map((model) => model.dollars)).toEqual([8, 2])
    expect(UsageBreakdown.models(breakdown, 'tokens').map((model) => model.name)).toEqual(['a'])
    expect(UsageBreakdown.models(breakdown, 'tokens').map((model) => model.tokens)).toEqual([40])
  })

  it('testModelSharesUseReportedCreditsAndFallBackToTurnsWithoutAPositiveCreditTotal', () => {
    const charged: UsageDay = {
      totals: UsageTotals.make({ credits: 8, turns: 10 }),
      byModel: { billed: UsageTotals.make({ credits: 2 }), 'turns-only': UsageTotals.make({ turns: 10 }) }
    }
    const recent: UsageDay = { totals: UsageTotals.make({ turns: 4 }), byModel: { 'turns-only': UsageTotals.make({ turns: 4 }) } }
    const lastTwoDays = (): UsageBreakdown => UsageBreakdown.make(UsageWindow.lastDays(2), history({ 0: recent, 1: charged }))

    const credits = lastTwoDays()
    expect(UsageTotals.get(credits.totals, 'credits'), 'today reported only turns').toBe(8)
    expect(models(credits).map((model) => model.name)).toEqual(['billed'])
    expect(models(credits)[0]?.share, 'two of the eight reported credits were attributed').toBe(0.25)

    charged.byModel!['refund'] = UsageTotals.make({ credits: -1 })
    expect(models(lastTwoDays()).at(-1)?.share, 'a credit adjustment keeps its sign').toBe(-0.125)

    for (const total of [undefined, 0]) {
      if (total === undefined) delete charged.totals.values.credits
      else charged.totals.values.credits = total
      const turns = lastTwoDays()
      expect(UsageTotals.get(turns.totals, 'credits')).toBe(total)
      expect(models(turns).map((model) => model.name)).toEqual(['turns-only'])
      expect(models(turns)[0]?.share).toBe(1)
    }
  })

  it('testTheFiguresLeadWithDollarsAndBYOKShowsOnlyWhenSpent', () => {
    const figures = (values: Partial<Record<UsageMeasure, number>>): string[] =>
      UsageBreakdown.figures(UsageBreakdown.make(UsageWindow.today, history({ 0: { totals: UsageTotals.make(values) } })))
    expect(figures({ spend: 12.5, usageEvents: 9, tokens: 3_000, byokSpend: 0 })).toEqual(['$12.50', '3K tokens'])
    expect(figures({ spend: 12.5, byokSpend: 2, tokens: 3_000 })).toEqual(['$12.50', '3K tokens', '$2 BYOK'])
    expect(figures({ tokens: 3_000 })).toEqual(['3K tokens'])
    expect(figures({ requests: 8 }), 'a legacy plan reports nothing else').toEqual(['8 requests'])
  })

  it('testTokenPartsAreLargestFirstAndABarNeedsThemToAddUpToTheTotal', () => {
    const breakdown = (values: Partial<Record<UsageMeasure, number>>): UsageBreakdown =>
      UsageBreakdown.make(UsageWindow.today, history({ 0: { totals: UsageTotals.make(values) } }))
    const split = breakdown({ tokens: 100, inputTokens: 10, cacheReadTokens: 80, cacheWriteTokens: 0, outputTokens: 10 })
    expect(UsageBreakdown.tokenParts(split).map((part) => part.title)).toEqual(['Cache Read', 'Input', 'Output'])
    expect(UsageBreakdown.tokenPartsFillTotal(split)).toBe(true)

    const cachedInsideInput = breakdown({ tokens: 660, inputTokens: 600, cacheReadTokens: 200, outputTokens: 60 })
    expect(UsageBreakdown.tokenPartsFillTotal(cachedInsideInput), 'cached tokens are already part of input').toBe(false)
  })

  // Not upstream cases: the windows the calendar sizes, and what the provider's own window total overrides.
  describe('calendar windows and reported totals', () => {
    it('this week and this month sum the days from the calendar week and month so far', () => {
      // 31 October 2026 is a Saturday: the week began Sunday 25 October (six days back).
      const all = history(everyDay(UsageTotals.make({ spend: 1 })))
      expect(UsageHistory.totals(all, UsageWindow.thisWeek)?.values.spend).toBe(7)
      expect(UsageHistory.totals(all, UsageWindow.thisMonth)?.values.spend).toBe(30)

      const monday = UsageHistory.make(calendar.withFirstWeekday(2), now, all.days)
      expect(UsageHistory.totals(monday, UsageWindow.thisWeek)?.values.spend, 'Monday 26 October through Saturday').toBe(6)
      expect(UsageHistory.totals(all, UsageWindow.yesterday)?.values.spend).toBe(1)
      expect(UsageHistory.totals(all, UsageWindow.priorDays(7))?.values.spend).toBe(7)
    })

    it("a provider's own total for a window wins, measure by measure, over the sum of its days", () => {
      const all = history(everyDay(UsageTotals.make({ spend: 1, tokens: 10 })))
      UsageHistory.setReported(all, UsageWindow.lastDays(30), UsageTotals.make({ spend: 99 }))
      expect(UsageHistory.totals(all, UsageWindow.lastDays(30))?.values).toEqual({ spend: 99, tokens: 300 })
      expect(UsageHistory.unreadDays(all, UsageWindow.lastDays(30), undefined), 'a reported window has no unread days').toBe(0)

      const sparse = history({ 0: { totals: UsageTotals.zero(['tokens']) }, 2: { totals: UsageTotals.zero(['tokens']) } })
      expect(UsageHistory.unreadDays(sparse, UsageWindow.lastDays(3), undefined)).toBe(1)
      expect(UsageHistory.unreadDays(sparse, UsageWindow.thisMonth, undefined), 'a calendar window counts none').toBe(0)
      sparse.unreadDatesByMeasure.credits = new Set([UsageHistory.dayStarts([0], now, calendar)[0]])
      expect(UsageHistory.unreadDays(sparse, UsageWindow.lastDays(3), 'credits')).toBe(2)
    })
  })
})
