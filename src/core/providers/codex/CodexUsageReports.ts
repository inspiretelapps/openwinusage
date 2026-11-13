import { UsageTotals, type UsageDay, type UsageHistory, type UsageMeasure } from '../../models/UsageHistory'
import { asArray, asObject, asString, isJSONObject, ProviderParse, type JSONObject } from '../../support/ProviderParse'
import type { Instant } from '../../support/time'

export interface CodexUsageReportsReport {
  /** Keyed by the day's UTC `yyyy-MM-dd` date. */
  days: Map<string, UsageDay>
  /** What a date the report leaves out stands for. */
  quietDay: UsageDay
}

/** A credits report without charged credits, which reports none for any day. */
function noCredits(): CodexUsageReportsReport {
  return { days: new Map(), quietDay: { totals: UsageTotals.empty() } }
}

const countedTokens: { key: string; measure: UsageMeasure }[] = [
  { key: 'text_total_tokens', measure: 'tokens' },
  { key: 'uncached_text_input_tokens', measure: 'inputTokens' },
  { key: 'cached_text_input_tokens', measure: 'cacheReadTokens' },
  { key: 'text_output_tokens', measure: 'outputTokens' }
]

/** `value as? [[String: Any]]`: every element has to be an object. */
function asObjects(value: unknown): JSONObject[] | undefined {
  const array = asArray(value)
  return array && array.every(isJSONObject) ? array : undefined
}

/** Nil when the record names no models. */
function countedModels(record: JSONObject): Record<string, UsageTotals> | undefined {
  const models = asObjects(record.models)
  if (!models || models.length === 0) return undefined
  const totals = new Map<string, UsageTotals>()
  for (const model of models) {
    const name = asString(model.model) ?? 'Unknown'
    for (const [key, measure] of [
      ['turns', 'turns'],
      ['text_total_tokens', 'tokens']
    ] as [string, UsageMeasure][]) {
      const number = count(model[key])
      if (number === undefined) continue
      const sum = totals.get(name) ?? UsageTotals.empty()
      sum.values[measure] = (sum.values[measure] ?? 0) + number
      totals.set(name, sum)
    }
  }
  return Object.fromEntries(totals)
}

function records(body: Uint8Array | string): JSONObject[] | undefined {
  return asObjects(ProviderParse.jsonObject(body)?.data)
}

function date(record: JSONObject): string | undefined {
  const date = asString(record.date)
  if (date === undefined || date.length < 10) return undefined
  return date.slice(0, 10)
}

function creditDay(credits: number, models: Map<string, number> | undefined): UsageDay {
  const day: UsageDay = { totals: UsageTotals.make({ credits }) }
  if (models) {
    day.byModel = Object.fromEntries([...models].map(([name, amount]) => [name, UsageTotals.make({ credits: amount })]))
  }
  return day
}

function mergingModels(earlier: Record<string, UsageTotals>, later: Record<string, UsageTotals>): Record<string, UsageTotals> {
  const merged = new Map(Object.entries(earlier))
  for (const [name, totals] of Object.entries(later)) {
    const existing = merged.get(name)
    merged.set(name, existing ? UsageTotals.adding(existing, totals) : totals)
  }
  return Object.fromEntries(merged)
}

/** Several records for one date add up, as the Codex client sums them. */
function add(day: UsageDay, date: string, days: Map<string, UsageDay>): void {
  const earlier = days.get(date)
  if (!earlier) {
    days.set(date, day)
    return
  }
  const byModel = mergingModels(earlier.byModel ?? {}, day.byModel ?? {})
  const sum: UsageDay = { totals: UsageTotals.adding(earlier.totals, day.totals) }
  if (!(Object.keys(byModel).length === 0 && earlier.byModel === undefined && day.byModel === undefined)) sum.byModel = byModel
  days.set(date, sum)
}

/** Credit amounts, which can be negative adjustments; nil when any is not a number. */
function numbers(amounts: JSONObject): Map<string, number> | undefined {
  const numbers = new Map<string, number>()
  for (const [name, value] of Object.entries(amounts)) {
    const number = ProviderParse.number(value)
    if (number === undefined) return undefined
    numbers.set(name, number)
  }
  return numbers
}

function count(value: unknown): number | undefined {
  const number = ProviderParse.number(value)
  return number !== undefined && number >= 0 ? number : undefined
}

function sum(amounts: Map<string, number>): number {
  let total = 0
  for (const amount of amounts.values()) total += amount
  return total
}

/**
 * ChatGPT's daily usage reports, parsed into days keyed by their UTC `yyyy-MM-dd` date. A report with any
 * malformed day is rejected whole, so a day is never partly read.
 */
export const CodexUsageReports = {
  /**
   * `analytics/daily-workspace-usage-counts`: each day's turns, its text tokens by kind when reported,
   * and each model's turns. A date it leaves out is not reported yet, so it has none of them.
   */
  counts(body: Uint8Array | string): CodexUsageReportsReport | undefined {
    const all = records(body)
    if (!all) return undefined
    const days = new Map<string, UsageDay>()
    for (const record of all) {
      const day = date(record)
      const totals = asObject(record.totals)
      const turns = count(totals?.turns)
      if (day === undefined || !totals || turns === undefined) return undefined
      const values: Partial<Record<UsageMeasure, number>> = { turns }
      for (const { key, measure } of countedTokens) {
        const reported = totals[key]
        if (reported === undefined || reported === null) continue
        const tokens = count(reported)
        if (tokens === undefined) return undefined
        values[measure] = tokens
      }
      const read: UsageDay = { totals: UsageTotals.make(values) }
      const byModel = countedModels(record)
      if (byModel) read.byModel = byModel
      add(read, day, days)
    }
    return { days, quietDay: { totals: UsageTotals.empty() } }
  },

  /**
   * `usage/daily-workspace-user-token-usage-breakdown`: each day's charged credits
   * (`premium_usage_values.credit_usage_credits`) and each model's (`on_demand_credits`).
   */
  workspaceCredits(body: Uint8Array | string): CodexUsageReportsReport | undefined {
    const all = records(body)
    if (!all) return undefined
    const days = new Map<string, UsageDay>()
    for (const record of all) {
      const day = date(record)
      if (day === undefined) return undefined
      const premium = asObject(asObject(record.premium_usage_values)?.credit_usage_credits)
      if (!premium) return noCredits()
      const charged = numbers(premium)
      if (!charged) return undefined
      const models = new Map<string, number>()
      for (const model of asObjects(record.models) ?? []) {
        const credits = ProviderParse.number(model.on_demand_credits)
        if (credits === undefined) continue
        const name = asString(model.model) ?? 'Unknown'
        models.set(name, (models.get(name) ?? 0) + credits)
      }
      add(creditDay(sum(charged), models), day, days)
    }
    return { days, quietDay: creditDay(0, new Map()) }
  },

  /** `usage/daily-workspace-user-credit-usage?breakdown=model`: each day's charged credits by model. */
  enterpriseCredits(body: Uint8Array | string): CodexUsageReportsReport | undefined {
    const all = records(body)
    if (!all) return undefined
    const days = new Map<string, UsageDay>()
    for (const record of all) {
      const day = date(record)
      if (day === undefined) return undefined
      const values = asObject(record.values)
      if (!values) return noCredits()
      const models = numbers(values)
      if (!models) return undefined
      add(creditDay(sum(models), models), day, days)
    }
    return { days, quietDay: creditDay(0, new Map()) }
  },

  /**
   * Token counts determine which days can be shown. When the credits report is available it also
   * supplies the charged credits by model, alongside the turns from the counts report.
   */
  combining(counts: UsageHistory, credits: UsageHistory | undefined): UsageHistory {
    if (!credits) return counts
    const result: UsageHistory = {
      ...counts,
      days: new Map(counts.days),
      unreadDatesByMeasure: { ...counts.unreadDatesByMeasure },
      reported: new Map(counts.reported)
    }
    result.unreadDatesByMeasure.credits = new Set<Instant>([...counts.days.keys()].filter((date) => !credits.days.has(date)))
    for (const [date, charged] of credits.days) {
      const day = result.days.get(date)
      if (!day) continue
      const combined: UsageDay = { ...day, totals: UsageTotals.adding(day.totals, charged.totals) }
      if (charged.byModel) combined.byModel = mergingModels(day.byModel ?? {}, charged.byModel)
      result.days.set(date, combined)
    }
    return result
  }
}
