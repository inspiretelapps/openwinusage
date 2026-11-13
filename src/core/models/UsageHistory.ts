import { Calendar, intervalContains } from '../support/Calendar'
import { MetricFormatter } from '../support/MetricFormatter'
import type { Instant } from '../support/time'
import { metricValue, type MetricValue } from './MetricValue'

/** One quantity a provider reports for a span. Never estimated, never priced. */
export type UsageMeasure =
  | 'spend'
  /** Spend on the user's own provider keys; never added to `spend`. */
  | 'byokSpend'
  | 'usageValue'
  | 'credits'
  | 'usageEvents'
  | 'requests'
  | 'turns'
  | 'tokens'
  | 'inputTokens'
  | 'cacheReadTokens'
  | 'cacheWriteTokens'
  | 'outputTokens'
  | 'reasoningTokens'

export const UsageMeasure = {
  allCases: [
    'spend',
    'byokSpend',
    'usageValue',
    'credits',
    'usageEvents',
    'requests',
    'turns',
    'tokens',
    'inputTokens',
    'cacheReadTokens',
    'cacheWriteTokens',
    'outputTokens',
    'reasoningTokens'
  ] as const satisfies readonly UsageMeasure[],

  /** The kinds of token a provider may split its total into, with their short names. */
  tokenParts: [
    { measure: 'inputTokens', title: 'Input' },
    { measure: 'cacheReadTokens', title: 'Cache Read' },
    { measure: 'cacheWriteTokens', title: 'Cache Write' },
    { measure: 'outputTokens', title: 'Output' },
    { measure: 'reasoningTokens', title: 'Reasoning' }
  ] as const satisfies readonly { measure: UsageMeasure; title: string }[],

  metricValue(measure: UsageMeasure, number: number): MetricValue {
    switch (measure) {
      case 'spend':
      case 'usageValue':
        return metricValue(number, 'dollars')
      case 'byokSpend':
        return metricValue(number, 'dollars', 'BYOK')
      case 'credits':
        return metricValue(number, 'count', 'credits')
      case 'usageEvents':
        return metricValue(number, 'count', 'events')
      case 'requests':
        return metricValue(number, 'count', 'requests')
      case 'turns':
        return metricValue(number, 'count', 'turns')
      case 'tokens':
      case 'inputTokens':
      case 'cacheReadTokens':
      case 'cacheWriteTokens':
      case 'outputTokens':
      case 'reasoningTokens':
        return metricValue(number, 'count', 'tokens')
    }
  }
}

/** The measures a provider reported for one span. A missing measure was not reported, which is never zero. */
export interface UsageTotals {
  values: Partial<Record<UsageMeasure, number>>
}

export const UsageTotals = {
  empty(): UsageTotals {
    return { values: {} }
  },

  make(values: Partial<Record<UsageMeasure, number>>): UsageTotals {
    return { values: { ...values } }
  },

  zero(measures: UsageMeasure[]): UsageTotals {
    const values: Partial<Record<UsageMeasure, number>> = {}
    for (const measure of measures) values[measure] = 0
    return { values }
  },

  get(totals: UsageTotals, measure: UsageMeasure): number | undefined {
    return totals.values[measure]
  },

  /** Sums what either reports, so a day missing a measure doesn't cost the range the rest of it. */
  adding(totals: UsageTotals, other: UsageTotals): UsageTotals {
    const values = { ...totals.values }
    for (const [measure, number] of Object.entries(other.values) as [UsageMeasure, number][]) {
      values[measure] = (values[measure] ?? 0) + number
    }
    return { values }
  },

  equal(a: UsageTotals, b: UsageTotals): boolean {
    const keys = new Set([...Object.keys(a.values), ...Object.keys(b.values)]) as Set<UsageMeasure>
    for (const key of keys) if (a.values[key] !== b.values[key]) return false
    return true
  }
}

export interface UsageDay {
  totals: UsageTotals
  /** What the provider reported by model for the day; undefined when it named none. */
  byModel?: Record<string, UsageTotals>
}

export type UsageWindow =
  | { type: 'today' }
  | { type: 'yesterday' }
  /** Today and the days before it. */
  | { type: 'lastDays'; count: number }
  /** The days before today. */
  | { type: 'priorDays'; count: number }
  /** The calendar's week or month so far; the source's calendar sets where a week starts. */
  | { type: 'thisWeek' }
  | { type: 'thisMonth' }

export const UsageWindow = {
  today: { type: 'today' } as UsageWindow,
  yesterday: { type: 'yesterday' } as UsageWindow,
  thisWeek: { type: 'thisWeek' } as UsageWindow,
  thisMonth: { type: 'thisMonth' } as UsageWindow,
  lastDays: (count: number): UsageWindow => ({ type: 'lastDays', count }),
  priorDays: (count: number): UsageWindow => ({ type: 'priorDays', count }),

  /** A stable string for using a window as a map key. */
  key(window: UsageWindow): string {
    return window.type === 'lastDays' || window.type === 'priorDays' ? `${window.type}:${window.count}` : window.type
  },

  equal(a: UsageWindow, b: UsageWindow): boolean {
    return UsageWindow.key(a) === UsageWindow.key(b)
  },

  title(window: UsageWindow): string {
    switch (window.type) {
      case 'today':
        return 'Today'
      case 'yesterday':
        return 'Yesterday'
      case 'lastDays':
        return `Last ${window.count} Days`
      case 'priorDays':
        return `Prior ${window.count} Days`
      case 'thisWeek':
        return 'This Week'
      case 'thisMonth':
        return 'This Month'
    }
  },

  phrase(window: UsageWindow): string {
    switch (window.type) {
      case 'today':
        return 'today'
      case 'yesterday':
        return 'yesterday'
      case 'lastDays':
        return `in ${window.count} days`
      case 'priorDays':
        return `in prior ${window.count} days`
      case 'thisWeek':
        return 'this week'
      case 'thisMonth':
        return 'this month'
    }
  },

  /** The inclusive day offsets back from today; undefined for a window whose length depends on the calendar. */
  dayOffsets(window: UsageWindow): { lowerBound: number; upperBound: number } | undefined {
    switch (window.type) {
      case 'today':
        return { lowerBound: 0, upperBound: 0 }
      case 'yesterday':
        return { lowerBound: 1, upperBound: 1 }
      case 'lastDays':
        return { lowerBound: 0, upperBound: window.count - 1 }
      case 'priorDays':
        return { lowerBound: 1, upperBound: window.count }
      case 'thisWeek':
      case 'thisMonth':
        return undefined
    }
  }
}

function offsetsIn(range: { lowerBound: number; upperBound: number }): number[] {
  const out: number[] = []
  for (let offset = range.lowerBound; offset <= range.upperBound; offset++) out.push(offset)
  return out
}

/** Usage a provider reported per local day, as of one moment. */
export interface UsageHistory {
  readonly calendar: Calendar
  readonly asOf: Instant
  /** Keyed by day start; a day that is absent was not read. */
  days: Map<Instant, UsageDay>
  /** A supplementary report can fail on dates the primary history read successfully. */
  unreadDatesByMeasure: Partial<Record<UsageMeasure, Set<Instant>>>
  /** A window's totals as the provider reported them, keyed by `UsageWindow.key`; each measure they report wins over the sum of days. */
  reported: Map<string, UsageTotals>
}

export const UsageHistory = {
  make(calendar: Calendar, asOf: Instant, days: Map<Instant, UsageDay> = new Map()): UsageHistory {
    return { calendar, asOf, days: new Map(days), unreadDatesByMeasure: {}, reported: new Map() }
  },

  /** The starts of the days `offsets` back from the day holding `now`. */
  dayStarts(offsets: Iterable<number>, now: Instant, calendar: Calendar): Instant[] {
    const today = calendar.startOfDay(now)
    return [...offsets].map((offset) => calendar.startOfDay(calendar.addingDays(today, -offset)))
  },

  /** `dayStarts(0..<count, ...)` */
  dayStartsBack(count: number, now: Instant, calendar: Calendar): Instant[] {
    return UsageHistory.dayStarts(
      Array.from({ length: Math.max(0, count) }, (_, index) => index),
      now,
      calendar
    )
  },

  setReported(history: UsageHistory, window: UsageWindow, totals: UsageTotals): void {
    history.reported.set(UsageWindow.key(window), totals)
  },

  /** The sum of the window's days that have been read, under what the provider reported for the window; undefined when neither exists. */
  totals(history: UsageHistory, window: UsageWindow): UsageTotals | undefined {
    const days = daysIn(history, window)
    const summed = days.length > 0 ? days.slice(1).reduce((sum, day) => UsageTotals.adding(sum, day.totals), days[0].totals) : undefined
    const reported = history.reported.get(UsageWindow.key(window))
    if (!reported) return summed
    return { values: { ...(summed?.values ?? {}), ...reported.values } }
  },

  /** What the window's days report by model, added up. */
  models(history: UsageHistory, window: UsageWindow): Record<string, UsageTotals> {
    const models: Record<string, UsageTotals> = {}
    for (const day of daysIn(history, window)) {
      for (const [name, totals] of Object.entries(day.byModel ?? {})) {
        models[name] = models[name] ? UsageTotals.adding(models[name], totals) : totals
      }
    }
    return models
  },

  /** Sources record a successfully read date even when the provider had no activity to report. */
  unreadDays(history: UsageHistory, window: UsageWindow, measure: UsageMeasure | undefined): number {
    const offsets = UsageWindow.dayOffsets(window)
    if (history.reported.has(UsageWindow.key(window)) || !offsets) return 0
    const extra = (measure !== undefined ? history.unreadDatesByMeasure[measure] : undefined) ?? new Set<Instant>()
    return UsageHistory.dayStarts(offsetsIn(offsets), history.asOf, history.calendar).filter(
      (day) => !history.days.has(day) || extra.has(day)
    ).length
  }
}

function daysIn(history: UsageHistory, window: UsageWindow): UsageDay[] {
  const offsets = UsageWindow.dayOffsets(window)
  if (offsets) {
    return UsageHistory.dayStarts(offsetsIn(offsets), history.asOf, history.calendar)
      .map((day) => history.days.get(day))
      .filter((day): day is UsageDay => day !== undefined)
  }
  const interval = history.calendar.dateInterval(window.type === 'thisWeek' ? 'weekOfYear' : 'month', history.asOf)
  return [...history.days.entries()].filter(([day]) => intervalContains(interval, day)).map(([, day]) => day)
}

/** What Top Models shows and ranks by. */
export type ModelFigure =
  | 'cost'
  | 'tokens'
  /** A model's part of the range's credits or turns, for a provider with no dollars or tokens by model. */
  | 'share'

// Foundation's format styles round ties to even; `Intl` rounds them away from zero unless told otherwise.
const sharePercent = new Intl.NumberFormat('en-US', {
  style: 'percent',
  maximumFractionDigits: 0,
  roundingMode: 'halfEven'
} as Intl.NumberFormatOptions)

export const ModelFigure = {
  key: 'usageBreakdownModelFigure',
  allCases: ['cost', 'tokens', 'share'] as const satisfies readonly ModelFigure[],

  label(figure: ModelFigure): string {
    switch (figure) {
      case 'cost':
        return 'Cost'
      case 'tokens':
        return 'Tokens'
      case 'share':
        return 'Share'
    }
  },

  text(figure: ModelFigure, number: number): string {
    switch (figure) {
      case 'cost':
        return MetricFormatter.number(number, 'dollars', 'row')
      case 'tokens':
        return MetricFormatter.number(number, 'count', 'row')
      case 'share':
        return sharePercent.format(number)
    }
  }
}

export interface UsageBreakdownModel {
  readonly name: string
  readonly dollars?: number
  readonly tokens?: number
  readonly share?: number
}

export interface UsageBreakdownTokenPart {
  readonly title: string
  readonly number: number
}

/** What a window's hover detail shows: what it charged, its tokens by kind, and its top models. Plain data, kept with the snapshot. */
export interface UsageBreakdown {
  readonly window: UsageWindow
  readonly reportingDay: Instant
  readonly reportingTimeZone: 'local' | 'utc'
  readonly totals: UsageTotals
  readonly unreadDays: number
  /** Only the names and figures shown in the popover are kept with the snapshot. */
  readonly rankings: Partial<Record<ModelFigure, UsageBreakdownModel[]>>
}

const dollarMeasures: UsageMeasure[] = ['spend', 'usageValue']

function modelNumber(model: UsageBreakdownModel, figure: ModelFigure): number | undefined {
  switch (figure) {
    case 'cost':
      return model.dollars
    case 'tokens':
      return model.tokens
    case 'share':
      return model.share
  }
}

function withDefined<T extends object>(value: T): T {
  for (const key of Object.keys(value) as (keyof T)[]) if (value[key] === undefined) delete value[key]
  return value
}

/** The top models by `figure`, the rest as Other. */
function rank(models: UsageBreakdownModel[], figure: ModelFigure): UsageBreakdownModel[] {
  const ranked = models
    .filter((model) => modelNumber(model, figure) !== undefined)
    .sort((a, b) => {
      const left = modelNumber(a, figure) ?? 0
      const right = modelNumber(b, figure) ?? 0
      if (left !== right) return right - left
      return a.name < b.name ? -1 : a.name > b.name ? 1 : 0
    })
  const rest = ranked.slice(UsageBreakdown.shownModels)
  if (rest.length === 0) return ranked
  const sum = (number: (model: UsageBreakdownModel) => number | undefined): number | undefined => {
    const values = rest.map(number).filter((value): value is number => value !== undefined)
    return values.length === 0 ? undefined : values.reduce((total, value) => total + value, 0)
  }
  return [
    ...ranked.slice(0, UsageBreakdown.shownModels),
    withDefined({ name: 'Other', dollars: sum((m) => m.dollars), tokens: sum((m) => m.tokens), share: sum((m) => m.share) })
  ]
}

export const UsageBreakdown = {
  shownModels: 5,

  make(window: UsageWindow, history: UsageHistory): UsageBreakdown {
    const totals = UsageHistory.totals(history, window) ?? UsageTotals.empty()
    const models = UsageHistory.models(history, window)
    const isReported = (measure: UsageMeasure): boolean => Object.values(models).some((model) => (model.values[measure] ?? 0) > 0)
    const dollars = dollarMeasures.find(isReported)
    const hasTokens = isReported('tokens')
    const share = (['credits', 'turns'] as UsageMeasure[]).find((measure) => (totals.values[measure] ?? 0) > 0 && isReported(measure))

    const everyModel = Object.entries(models).map(([name, model]): UsageBreakdownModel => {
      let fraction: number | undefined
      if (share !== undefined) {
        const amount = model.values[share]
        const total = totals.values[share]
        if (amount !== undefined && total !== undefined) {
          const contribution = amount / total
          fraction = Number.isFinite(contribution) ? contribution : undefined
        }
      }
      return withDefined({
        name,
        dollars: dollars !== undefined ? model.values[dollars] : undefined,
        tokens: hasTokens ? model.values.tokens : undefined,
        share: fraction
      })
    })
    const figures: ModelFigure[] = [...(dollars === undefined ? [] : (['cost'] as ModelFigure[])), ...(hasTokens ? (['tokens'] as ModelFigure[]) : [])]
    const available: ModelFigure[] = figures.length === 0 && share !== undefined ? ['share'] : figures
    const rankings: Partial<Record<ModelFigure, UsageBreakdownModel[]>> = {}
    for (const figure of available) rankings[figure] = rank(everyModel, figure)
    return {
      window,
      reportingDay: history.calendar.startOfDay(history.asOf),
      reportingTimeZone: history.calendar.timeZone,
      totals,
      unreadDays: UsageHistory.unreadDays(history, window, figures.length === 0 ? share : undefined),
      rankings
    }
  },

  /** What the models report, in order of preference. Credits or turns supply a share when neither dollars nor tokens were reported by model. */
  modelFigures(breakdown: UsageBreakdown): ModelFigure[] {
    return ModelFigure.allCases.filter((figure) => breakdown.rankings[figure] !== undefined)
  },

  /** Relative window names expire at midnight on the source's clock. */
  archivedTitle(breakdown: UsageBreakdown, now: Instant = Date.now()): string | undefined {
    const calendar = new Calendar(breakdown.reportingTimeZone)
    if (calendar.isSameDay(breakdown.reportingDay, now)) return undefined
    const end = calendar.addingDays(breakdown.reportingDay, -(UsageWindow.dayOffsets(breakdown.window)?.lowerBound ?? 0))
    const date = new Intl.DateTimeFormat(undefined, {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
      timeZone: calendar.intlTimeZone
    }).format(end)
    switch (breakdown.window.type) {
      case 'today':
      case 'yesterday':
        return date
      case 'lastDays':
      case 'priorDays':
        return `${breakdown.window.count} Days Ending ${date}`
      case 'thisWeek':
        return `Week Through ${date}`
      case 'thisMonth':
        return `Month Through ${date}`
    }
  },

  models(breakdown: UsageBreakdown, figure: ModelFigure): UsageBreakdownModel[] {
    return breakdown.rankings[figure] ?? []
  },

  modelNumber,

  /** Every figure is zero, so there is nothing to show beyond a zero total. Unread days can still have activity, unless nothing at all was reported for the range. */
  isEmpty(breakdown: UsageBreakdown): boolean {
    const values = Object.values(breakdown.totals.values)
    return (breakdown.unreadDays === 0 || values.length === 0) && values.every((value) => value === 0)
  },

  /** What the window charged, then its tokens and any spend on the user's own keys. A window that reports neither dollars nor tokens falls back to the first thing it does report. */
  figures(breakdown: UsageBreakdown): string[] {
    const totals = breakdown.totals.values
    const charged = dollarMeasures.find((measure) => totals[measure] !== undefined)
    const shown = ([charged, 'tokens', 'byokSpend'] as (UsageMeasure | undefined)[])
      .filter((measure): measure is UsageMeasure => measure !== undefined)
      .filter((measure) => {
        const number = totals[measure]
        if (number === undefined) return false
        return measure !== 'byokSpend' || number > 0
      })
    const measures = shown.length === 0 ? UsageMeasure.allCases.filter((measure) => totals[measure] !== undefined).slice(0, 1) : shown
    return measures.map((measure) => MetricFormatter.string(UsageMeasure.metricValue(measure, totals[measure] as number), 'row'))
  },

  /** The kinds of token that have any, largest first. */
  tokenParts(breakdown: UsageBreakdown): UsageBreakdownTokenPart[] {
    const parts: UsageBreakdownTokenPart[] = []
    for (const part of UsageMeasure.tokenParts) {
      const number = breakdown.totals.values[part.measure]
      if (number !== undefined && number > 0) parts.push({ title: part.title, number })
    }
    return parts.sort((a, b) => b.number - a.number)
  },

  /** Some providers count cached tokens inside input, so only parts that add up to the total can be drawn as shares of it. */
  tokenPartsFillTotal(breakdown: UsageBreakdown): boolean {
    const total = breakdown.totals.values.tokens
    if (total === undefined || !(total > 0)) return false
    return Math.abs(UsageBreakdown.tokenParts(breakdown).reduce((sum, part) => sum + part.number, 0) - total) < 1
  }
}
