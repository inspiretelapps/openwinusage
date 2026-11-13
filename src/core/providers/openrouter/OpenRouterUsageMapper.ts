import { MetricLine, ProgressFormat } from '../../models/MetricLine'
import { metricValue } from '../../models/MetricValue'
import { UsageTotals, UsageWindow, type UsageDay, type UsageMeasure } from '../../models/UsageHistory'
import { Calendar } from '../../support/Calendar'
import { OpenUsageISO8601 } from '../../support/OpenUsageISO8601'
import { asArray, asObject, asString, isJSONObject, ProviderParse, type JSONObject } from '../../support/ProviderParse'
import type { Instant } from '../../support/time'
import { ProviderError } from '../ProviderError'

/** A key's or an account's spend per window, keyed by `UsageWindow.key`: Swift's `[UsageWindow: UsageTotals]`. */
export type OpenRouterSpend = Map<string, UsageTotals>

export type OpenRouterKeyKind = { type: 'management' } | { type: 'standard'; spend: OpenRouterSpend }

/**
 * What `/api/v1/key` says about the key that calls it. A management key cannot run inference, so its
 * own spend is always zero; the account's spend is the sum over the keys `/api/v1/keys` lists.
 */
export interface OpenRouterKey {
  kind: OpenRouterKeyKind
  plan?: string
  /** Key Limit, Budget and Free Requests, each when OpenRouter reports one. */
  lines: MetricLine[]
}

const resetPeriods = new Map<string, 'day' | 'weekOfYear' | 'month'>([
  ['daily', 'day'],
  ['weekly', 'weekOfYear'],
  ['monthly', 'month']
])

/** OpenRouter's days, limits and budgets reset at midnight UTC, and its weeks start on Monday. */
const utc: Calendar = Calendar.utc.withFirstWeekday(2)

export const OpenRouterUsageMapper = {
  /** A UTC day with no activity row. */
  get quietDay(): UsageDay {
    return {
      totals: UsageTotals.zero(['spend', 'byokSpend', 'tokens', 'inputTokens', 'cacheReadTokens', 'outputTokens', 'reasoningTokens']),
      byModel: {}
    }
  },

  key(body: Uint8Array | string, now: Instant = Date.now()): OpenRouterKey {
    const data = dataObject(body)
    const isManagement = data?.is_management_key
    if (!data || typeof isManagement !== 'boolean') throw ProviderError.invalidResponse
    const isFreeTier = data.is_free_tier
    const plan = typeof isFreeTier === 'boolean' ? (isFreeTier ? 'Free' : 'Pay-as-you-go') : undefined
    const lines = [keyLimitLine(data, now), budgetLine(data, now), freeRequestsLine(data, now)]
    const key: OpenRouterKey = {
      kind: isManagement ? { type: 'management' } : { type: 'standard', spend: spend(data) },
      lines: lines.filter((line): line is MetricLine => line !== undefined)
    }
    if (plan !== undefined) key.plan = plan
    return key
  },

  creditsLines(body: Uint8Array | string): MetricLine[] {
    const data = dataObject(body)
    const totalCredits = data ? ProviderParse.number(data.total_credits) : undefined
    const totalUsage = data ? ProviderParse.number(data.total_usage) : undefined
    if (totalCredits === undefined || totalUsage === undefined) throw ProviderError.invalidResponse
    const balance = Math.max(0, Math.max(0, totalCredits) - Math.max(0, totalUsage))
    return [MetricLine.values('Balance', [metricValue(balance, 'dollars')])]
  },

  keysPage(body: Uint8Array | string): OpenRouterSpend[] {
    const keys = objects(ProviderParse.jsonObject(body)?.data)
    if (!keys) throw ProviderError.invalidResponse
    return keys.map(spend)
  },

  /** `/api/v1/activity`'s rows summed per UTC day and per model; undefined when any row is malformed. */
  activityDays(body: Uint8Array | string): Map<Instant, UsageDay> | undefined {
    const rows = objects(ProviderParse.jsonObject(body)?.data)
    if (!rows) return undefined
    const days = new Map<Instant, UsageDay>()
    for (const row of rows) {
      const dateText = asString(row.date)
      const date = dateText === undefined ? undefined : OpenUsageISO8601.date(`${dateText}T00:00:00Z`)
      const model = asString(row.model)
      const totals = activityTotals(row)
      if (date === undefined || model === undefined || !totals) return undefined
      const day = days.get(date) ?? OpenRouterUsageMapper.quietDay
      const models = { ...(day.byModel ?? {}) }
      models[model] = Object.hasOwn(models, model) ? UsageTotals.adding(models[model], totals) : totals
      days.set(date, { totals: UsageTotals.adding(day.totals, totals), byModel: models })
    }
    return days
  },

  /** OpenRouter's days, limits and budgets reset at midnight UTC, and its weeks start on Monday. */
  utc
}

function dataObject(body: Uint8Array | string): JSONObject | undefined {
  return asObject(ProviderParse.jsonObject(body)?.data)
}

/** `value as? [[String: Any]]` */
function objects(value: unknown): JSONObject[] | undefined {
  const list = asArray(value)
  return list && list.every(isJSONObject) ? list : undefined
}

/** What a key spent today, this week and this month, with what it spent on BYOK when reported. */
function spend(key: JSONObject): OpenRouterSpend {
  const periods: [UsageWindow, string][] = [
    [UsageWindow.today, 'daily'],
    [UsageWindow.thisWeek, 'weekly'],
    [UsageWindow.thisMonth, 'monthly']
  ]
  return new Map(
    periods.map(([window, period]): [string, UsageTotals] => {
      const spent = ProviderParse.number(key[`usage_${period}`])
      if (spent === undefined) throw ProviderError.invalidResponse
      const totals = UsageTotals.make({ spend: Math.max(0, spent) })
      const byok = ProviderParse.number(key[`byok_usage_${period}`])
      if (byok !== undefined) totals.values.byokSpend = Math.max(0, byok)
      return [UsageWindow.key(window), totals]
    })
  )
}

/**
 * Prompt tokens include cached ones and completion tokens include reasoning, so tokens are the two summed
 * and Input and Output leave out what Cache Read and Reasoning already count.
 */
function activityTotals(row: JSONObject): UsageTotals | undefined {
  const fields: [UsageMeasure, string][] = [
    ['spend', 'usage'],
    ['byokSpend', 'byok_usage_inference'],
    ['inputTokens', 'prompt_tokens'],
    ['cacheReadTokens', 'cached_tokens'],
    ['outputTokens', 'completion_tokens'],
    ['reasoningTokens', 'reasoning_tokens']
  ]
  const totals = UsageTotals.empty()
  for (const [measure, field] of fields) {
    const value = row[field]
    if (value === undefined || value === null) continue
    const number = ProviderParse.number(value)
    if (number === undefined || !(number >= 0)) return undefined
    totals.values[measure] = number
  }
  const prompt = totals.values.inputTokens
  const completion = totals.values.outputTokens
  if (totals.values.spend === undefined || prompt === undefined || completion === undefined) return undefined
  totals.values.tokens = prompt + completion
  totals.values.inputTokens = prompt - (totals.values.cacheReadTokens ?? 0)
  totals.values.outputTokens = completion - (totals.values.reasoningTokens ?? 0)
  return totals
}

function keyLimitLine(key: JSONObject, now: Instant): MetricLine | undefined {
  const limit = ProviderParse.number(key.limit)
  if (limit === undefined || !(limit > 0)) return undefined
  const remaining = ProviderParse.number(key.limit_remaining)
  if (remaining === undefined) throw ProviderError.invalidResponse
  return progress('Key Limit', Math.max(0, limit - Math.max(0, remaining)), limit, ProgressFormat.dollars, asString(key.limit_reset), now)
}

/** The budget OpenRouter checks this key's requests against. */
function budgetLine(key: JSONObject, now: Instant): MetricLine | undefined {
  const budget = asObject(key.effective_budget)
  const limit = budget ? ProviderParse.number(budget.limit_usd) : undefined
  if (!budget || limit === undefined || !(limit > 0)) return undefined
  const spent = ProviderParse.number(budget.spend_usd)
  if (spent === undefined) throw ProviderError.invalidResponse
  return progress('Budget', Math.max(0, spent), limit, ProgressFormat.dollars, asString(budget.reset_interval), now)
}

/** The account's free-model requests for the UTC day. */
function freeRequestsLine(key: JSONObject, now: Instant): MetricLine | undefined {
  const free = asObject(key.free_model_daily_requests)
  const limit = free ? ProviderParse.number(free.limit) : undefined
  if (!free || limit === undefined || !(limit > 0)) return undefined
  const used = ProviderParse.number(free.used)
  if (used === undefined) throw ProviderError.invalidResponse
  return progress('Free Requests', Math.max(0, used), limit, ProgressFormat.count('requests'), 'daily', now)
}

function progress(label: string, used: number, limit: number, format: ProgressFormat, period: string | undefined, now: Instant): MetricLine {
  const component = period === undefined ? undefined : resetPeriods.get(period)
  const window = component === undefined ? undefined : utc.dateInterval(component, now)
  return MetricLine.progress(label, used, limit, format, window?.end, window === undefined ? undefined : Math.trunc(window.end - window.start))
}
