import type { HTTPResponse } from '../../services/HTTPClient'
import { AppLog, describeError, LogTags } from '../../support/AppLog'
import type { Calendar } from '../../support/Calendar'
import type { Instant, Seconds } from '../../support/time'
import type { UsageHistoryRead, UsageHistorySource } from '../UsageLedger'
import type { OpenRouterUsageClient } from './OpenRouterUsageClient'
import { OpenRouterUsageMapper } from './OpenRouterUsageMapper'

/**
 * Reads a Management key's `/api/v1/activity`, which ends at yesterday, so today is never read:
 * `?date=` when one day is due, else the last 30 finished UTC days, in one call either way.
 */
export class OpenRouterActivitySource implements UsageHistorySource {
  client: OpenRouterUsageClient
  apiKey: string
  accountID: string

  constructor(client: OpenRouterUsageClient, apiKey: string, accountID: string) {
    this.client = client
    this.apiKey = apiKey
    this.accountID = accountID
  }

  get calendar(): Calendar {
    return OpenRouterUsageMapper.utc
  }

  /** Hourly, so history adds one call an hour per account. */
  get rereadInterval(): Seconds | undefined {
    return 3600
  }

  async read(due: Instant[], asOf: Instant, calendar: Calendar): Promise<UsageHistoryRead> {
    const tag = LogTags.plugin('openrouter')
    const today = calendar.startOfDay(asOf)
    const days = due.filter((day) => day < today)
    if (days.length === 0) return { days: new Map() }
    let response: HTTPResponse
    try {
      response = await this.client.activity(this.apiKey, days.length === 1 ? days[0] : undefined)
    } catch (error) {
      AppLog.warn(tag, `${this.accountID} activity request failed: ${describeError(error)}`)
      return { days: new Map() }
    }
    if (!(response.statusCode >= 200 && response.statusCode < 300)) {
      AppLog.warn(tag, `${this.accountID} activity returned HTTP ${response.statusCode}`)
      return { days: new Map() }
    }
    const read = OpenRouterUsageMapper.activityDays(response.body)
    if (!read) {
      AppLog.warn(tag, `${this.accountID} activity response was invalid`)
      return { days: new Map() }
    }
    return { days: new Map(days.map((day) => [day, read.get(day) ?? OpenRouterUsageMapper.quietDay])) }
  }
}
