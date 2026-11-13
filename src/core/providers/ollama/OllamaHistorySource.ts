import { UsageTotals, type UsageDay, type UsageMeasure } from '../../models/UsageHistory'
import type { HTTPResponse } from '../../services/HTTPClient'
import { AppLog, LogTags } from '../../support/AppLog'
import { Calendar } from '../../support/Calendar'
import { OpenUsageISO8601 } from '../../support/OpenUsageISO8601'
import { asArray, asObject, asString, nilIfEmpty, ProviderParse, type JSONObject } from '../../support/ProviderParse'
import type { Instant, Seconds } from '../../support/time'
import type { UsageHistoryRead, UsageHistorySource } from '../UsageLedger'
import type { OllamaUsageClient } from './OllamaUsageClient'

const measures: { field: string; measure: UsageMeasure }[] = [
  { field: 'request_count', measure: 'requests' },
  { field: 'usage_usd', measure: 'usageValue' },
  { field: 'input_tokens', measure: 'inputTokens' },
  { field: 'cached_input_tokens', measure: 'cacheReadTokens' },
  { field: 'output_tokens', measure: 'outputTokens' }
]

/** Reads Ollama's UTC days in one call: the last 7 days when every due day is among them, else 30. */
export class OllamaHistorySource implements UsageHistorySource {
  client: OllamaUsageClient
  apiKey: string
  accountID: string

  constructor(client: OllamaUsageClient, apiKey: string, accountID: string) {
    this.client = client
    this.apiKey = apiKey
    this.accountID = accountID
  }

  get calendar(): Calendar {
    return Calendar.utc
  }

  /** Hourly, so history adds one call an hour per account. */
  get rereadInterval(): Seconds | undefined {
    return 3600
  }

  async read(days: Instant[], asOf: Instant, calendar: Calendar): Promise<UsageHistoryRead> {
    const tag = LogTags.plugin('ollama')
    const weekAgo = calendar.addingDays(calendar.startOfDay(asOf), -7)
    let response: HTTPResponse
    try {
      response = await this.client.fetchUsage(this.apiKey, days.every((day) => day >= weekAgo) ? '7d' : '30d')
    } catch {
      AppLog.warn(tag, `${this.accountID} usage history: request failed`)
      return { days: new Map() }
    }
    if (!(response.statusCode >= 200 && response.statusCode < 300)) {
      AppLog.warn(tag, `${this.accountID} usage history: HTTP ${response.statusCode}`)
      return { days: new Map() }
    }
    const read = OllamaHistorySource.days(response.body, calendar)
    if (!read) {
      AppLog.warn(tag, `${this.accountID} usage history: invalid response`)
      return { days: new Map() }
    }
    // The request covered these dates even when Ollama supplied no figures for one of them.
    return { days: new Map(days.map((day) => [day, read.get(day) ?? { totals: UsageTotals.empty() }])) }
  }

  /**
   * Every bucket keyed by its UTC day, or undefined when any bucket is not one, so a read is never partly used.
   * A day is split by model only when no usage falls in Ollama's `remainder` beyond the named models.
   */
  static days(body: Uint8Array | string, calendar: Calendar): Map<Instant, UsageDay> | undefined {
    const root = ProviderParse.jsonObject(body)
    if (!root || asString(root.granularity) !== 'day') return undefined
    const buckets = asArray(root.buckets)
    if (!buckets) return undefined
    const days = new Map<Instant, UsageDay>()
    for (const rawBucket of buckets) {
      const bucket = asObject(rawBucket)
      if (!bucket) return undefined
      const fromText = asString(bucket.from)
      const untilText = asString(bucket.until)
      const from = fromText === undefined ? undefined : OpenUsageISO8601.date(fromText)
      const until = untilText === undefined ? undefined : OpenUsageISO8601.date(untilText)
      if (from === undefined || until === undefined) return undefined
      if (calendar.startOfDay(from) !== from || days.has(from)) return undefined
      const end = calendar.addingDays(from, 1)
      if (!(from < until && until <= end)) return undefined
      const bucketTotals = totals(bucket)
      if (!bucketTotals) return undefined
      let byModel: Record<string, UsageTotals> | undefined
      const rawGroups = bucket.groups
      if (rawGroups !== undefined) {
        const groups = asArray(rawGroups)
        if (!groups) return undefined
        const models: Record<string, UsageTotals> = {}
        for (const rawGroup of groups) {
          const group = asObject(rawGroup)
          if (!group) return undefined
          const model = nilIfEmpty(asString(group.model))
          if (model === undefined || Object.hasOwn(models, model)) return undefined
          const modelTotals = totals(group)
          if (!modelTotals) return undefined
          models[model] = modelTotals
        }
        byModel = bucket.remainder === undefined ? models : undefined
      }
      const day: UsageDay = { totals: bucketTotals }
      if (byModel !== undefined) day.byModel = byModel
      days.set(from, day)
    }
    return days
  }
}

/**
 * Cached input is part of input, so tokens are input plus output. Undefined without a request count, or
 * when a figure is not a number of zero or more.
 */
function totals(object: JSONObject): UsageTotals | undefined {
  const totals = UsageTotals.empty()
  for (const { field, measure } of measures) {
    const raw = object[field]
    if (raw === undefined || raw === null) continue
    const number = ProviderParse.number(raw)
    if (number === undefined || !(number >= 0)) return undefined
    totals.values[measure] = number
  }
  if (totals.values.requests === undefined) return undefined
  const input = totals.values.inputTokens
  const output = totals.values.outputTokens
  if (input !== undefined && output !== undefined) totals.values.tokens = input + output
  return totals
}
