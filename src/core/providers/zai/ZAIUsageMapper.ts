import { MetricLine, ProgressFormat } from '../../models/MetricLine'
import { MetricPeriod } from '../../support/MetricPeriod'
import { asArray, asString, isJSONObject, nilIfEmpty, ProviderParse, type JSONObject } from '../../support/ProviderParse'
import type { Instant } from '../../support/time'
import { ProviderError } from '../ProviderError'
import { ProviderUsage } from '../ProviderRuntime'

type TokenWindow = { type: 'session'; periodMs: number } | { type: 'weekly'; periodMs: number }

export const ZAIUsageMapper = {
  map(quotaBody: Uint8Array | string, subscriptionBody: Uint8Array | string | undefined): ProviderUsage {
    const plan = subscriptionBody === undefined ? undefined : ZAIUsageMapper.planName(subscriptionBody)
    return ProviderUsage.make(plan, ZAIUsageMapper.mapQuota(quotaBody))
  },

  mapQuota(body: Uint8Array | string): MetricLine[] {
    const root = ProviderParse.jsonObject(body)
    if (!root) throw ProviderError.invalidResponse
    if (root.success === false && asString(root.msg)?.toLowerCase().includes('coding plan') === true) {
      throw ProviderError.unavailable('No active GLM Coding Plan. Subscribe at z.ai/subscribe to see usage.')
    }
    if (root.success === false && root.code === 401) {
      throw ProviderError.signInExpired('zai')
    }
    let container: JSONObject
    if (root.data !== undefined) {
      if (!isJSONObject(root.data)) throw ProviderError.invalidResponse
      container = root.data
    } else {
      container = root
    }
    const limits = objects(container.limits)
    if (!limits) throw ProviderError.invalidResponse
    if (limits.length === 0) return []

    const lines: MetricLine[] = []
    let sawRecognizedLimit = false

    const percentageLimits = limits.filter((entry) => {
      const type = asString(entry.type) ?? asString(entry.name)
      return type === 'CREDIT_LIMIT' || type === 'TOKENS_LIMIT'
    })
    for (const entry of percentageLimits) {
      const window = classifyTokenWindow(entry)
      if (!window) continue
      sawRecognizedLimit = true
      switch (window.type) {
        case 'session':
          lines.push(percentLine(entry, 'Session', window.periodMs))
          break
        case 'weekly':
          lines.push(percentLine(entry, 'Weekly', window.periodMs))
          break
      }
    }
    const web = findLimit(limits, 'TIME_LIMIT')
    if (web) {
      sawRecognizedLimit = true
      lines.push(webSearchLine(web))
    }

    if (lines.length === 0) {
      if (sawRecognizedLimit) throw ProviderError.invalidResponse
      return []
    }
    return lines
  },

  planName(body: Uint8Array | string): string | undefined {
    const root = ProviderParse.jsonObject(body)
    const list = objects(root?.data)
    const first = list?.[0]
    if (!first) return undefined
    // `.whitespaces`: spaces and tabs, not line breaks.
    return nilIfEmpty(asString(first.productName)?.replace(/^[\p{Zs}\t]+|[\p{Zs}\t]+$/gu, ''))
  }
}

/** `value as? [[String: Any]]` */
function objects(value: unknown): JSONObject[] | undefined {
  const list = asArray(value)
  return list && list.every(isJSONObject) ? list : undefined
}

function classifyTokenWindow(entry: JSONObject): TokenWindow | undefined {
  const unit = ProviderParse.number(entry.unit)
  const number = ProviderParse.number(entry.number)
  if (unit === undefined || number === undefined || !(number > 0)) throw ProviderError.invalidResponse
  let unitMs: number
  switch (unit) {
    case 3:
      unitMs = 60 * 60 * 1000
      break
    case 4:
      unitMs = 24 * 60 * 60 * 1000
      break
    case 6:
      unitMs = 7 * 24 * 60 * 60 * 1000
      break
    case 5:
      unitMs = 30 * 24 * 60 * 60 * 1000
      break
    default:
      return undefined
  }
  const duration = unitMs * number
  const periodMs = duration >= 1 ? ProviderParse.int(duration) : undefined
  if (periodMs === undefined) throw ProviderError.invalidResponse
  if (periodMs < 24 * 60 * 60 * 1000) {
    return { type: 'session', periodMs }
  }
  return { type: 'weekly', periodMs }
}

function percentLine(entry: JSONObject, label: string, periodMs: number): MetricLine {
  const rawPercentage = ProviderParse.number(entry.percentage)
  if (rawPercentage === undefined) throw ProviderError.invalidResponse
  const percentage = ProviderParse.clampPercent(rawPercentage)
  const nextResetTime = ProviderParse.number(entry.nextResetTime)
  const resetsAt = nextResetTime === undefined ? undefined : epochMsToDate(nextResetTime)
  return MetricLine.percent(label, percentage, resetsAt, periodMs)
}

function webSearchLine(entry: JSONObject): MetricLine {
  const used = ProviderParse.number(entry.currentValue)
  const limit = ProviderParse.number(entry.usage)
  if (used === undefined || limit === undefined || !(used >= 0) || !(limit >= 0)) throw ProviderError.invalidResponse
  const nextResetTime = ProviderParse.number(entry.nextResetTime)
  const resetsAt = nextResetTime === undefined ? undefined : epochMsToDate(nextResetTime)
  return MetricLine.progress('Web Searches', used, limit, ProgressFormat.count('searches'), resetsAt, MetricPeriod.monthMs)
}

/** A limit entry matches by `type` or `name`: Z.ai's payload has used either field across revisions. */
function findLimit(limits: JSONObject[], type: string): JSONObject | undefined {
  for (const entry of limits) {
    if (asString(entry.type) === type || asString(entry.name) === type) {
      return entry
    }
  }
  return undefined
}

/** Z.ai's reset times are epoch milliseconds, which is what an `Instant` is. */
function epochMsToDate(ms: number): Instant {
  return ms
}
