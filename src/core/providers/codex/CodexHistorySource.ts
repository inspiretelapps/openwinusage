import type { UsageDay } from '../../models/UsageHistory'
import type { HTTPResponse } from '../../services/HTTPClient'
import { AppLog, LogTags } from '../../support/AppLog'
import { Calendar } from '../../support/Calendar'
import type { Instant, Seconds } from '../../support/time'
import type { UsageHistoryRead, UsageHistorySource } from '../UsageLedger'
import type { CodexQueryItem, CodexUsageClient } from './CodexUsageClient'
import { CodexUsageReports, type CodexUsageReportsReport } from './CodexUsageReports'

export type CodexHistorySourceReport = 'counts' | 'teamCredits' | 'enterpriseCredits'

export const CodexHistorySourceReport = {
  workspaceCredits(planType: string | undefined): CodexHistorySourceReport | undefined {
    switch (planType?.toLowerCase()) {
      case 'team':
      case 'self_serve_business_prolite':
      case 'self_serve_business_usage_based':
      case 'sci':
      case 'sci_plus':
        return 'teamCredits'
      case 'business':
      case 'ent26':
      case 'enterprise_cbp_automation':
      case 'enterprise_cbp_usage_based':
      case 'enterprise':
      case 'edu':
      case 'edu_plus':
      case 'edu_pro':
        return 'enterpriseCredits'
      default:
        return undefined
    }
  }
}

/**
 * Reads one ChatGPT analytics report on UTC days. Token counts and supplemental workspace credits have
 * separate ledgers so a refused or rate-limited credits report cannot hide the primary counts.
 */
export class CodexHistorySource implements UsageHistorySource {
  constructor(
    public client: CodexUsageClient,
    public accessToken: string,
    public chatGPTAccountID: string | undefined,
    public cardID: string,
    public report: CodexHistorySourceReport
  ) {}

  get calendar(): Calendar {
    return Calendar.utc
  }

  get rereadInterval(): Seconds {
    return 3600
  }

  async read(days: Instant[], asOf: Instant, _calendar: Calendar): Promise<UsageHistoryRead> {
    if (days.length === 0) return { days: new Map() }
    const first = Math.min(...days)
    const last = Math.max(...days)
    const dates: CodexQueryItem[] = [
      { name: 'start_date', value: CodexHistorySource.date(first) },
      { name: 'end_date', value: CodexHistorySource.date(last) }
    ]
    const byDay: CodexQueryItem[] = [...dates, { name: 'group_by', value: 'day' }]
    let path: string
    let query: CodexQueryItem[]
    let parse: (body: Uint8Array) => CodexUsageReportsReport | undefined
    switch (this.report) {
      case 'counts':
        path = 'analytics/daily-workspace-usage-counts'
        query = [...byDay, { name: 'workspace_user', value: 'true' }]
        parse = CodexUsageReports.counts
        break
      case 'teamCredits':
        path = 'usage/daily-workspace-user-token-usage-breakdown'
        query = byDay
        parse = CodexUsageReports.workspaceCredits
        break
      case 'enterpriseCredits':
        path = 'usage/daily-workspace-user-credit-usage'
        query = [...dates, { name: 'breakdown', value: 'model' }]
        parse = CodexUsageReports.enterpriseCredits
        break
    }
    const tag = LogTags.plugin('codex')
    let response: HTTPResponse
    try {
      response = await this.client.fetchReport(path, query, this.accessToken, this.chatGPTAccountID)
    } catch {
      AppLog.warn(tag, `${this.cardID} usage history: ${path} request failed`)
      return { days: new Map() }
    }
    if (response.statusCode === 429) {
      const wait = response.retryAfter(asOf) ?? 3600
      AppLog.warn(tag, `${this.cardID} usage history: ${path} rate limited; next read in ${Math.trunc(wait)}s`)
      return { days: new Map(), rateLimitedFor: wait }
    }
    if (!(response.statusCode >= 200 && response.statusCode < 300)) {
      AppLog.warn(tag, `${this.cardID} usage history: ${path} HTTP ${response.statusCode}`)
      return { days: new Map() }
    }
    const parsed = parse(response.body)
    if (!parsed) {
      AppLog.warn(tag, `${this.cardID} usage history: ${path} invalid response`)
      return { days: new Map() }
    }
    const read = new Map<Instant, UsageDay>()
    for (const day of days) read.set(day, parsed.days.get(CodexHistorySource.date(day)) ?? parsed.quietDay)
    return { days: read }
  }

  /** A day start's UTC `yyyy-MM-dd`, the date format of the reports and their range parameters. */
  static date(day: Instant): string {
    return new Date(day).toISOString().slice(0, 10)
  }
}
