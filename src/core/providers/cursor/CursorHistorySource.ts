import type { UsageDay } from '../../models/UsageHistory'
import type { HTTPResponse } from '../../services/HTTPClient'
import { AppLog, LogTags } from '../../support/AppLog'
import type { Calendar } from '../../support/Calendar'
import type { Instant, Seconds } from '../../support/time'
import type { UsageHistoryRead, UsageHistorySource } from '../UsageLedger'
import type { CursorUsageClient } from './CursorUsageClient'
import { CursorUsageEvents, type CursorUsageEvent } from './CursorUsageEvents'

type DayResult =
  | { type: 'read'; start: Instant; day: UsageDay }
  | { type: 'failed'; reason: string }
  | { type: 'rateLimited'; retryAfter?: Seconds }
  | { type: 'deadline' }

/** Reads Cursor's usage events a local day at a time: at most 4 days at once, for at most 20 seconds. */
export class CursorHistorySource implements UsageHistorySource {
  client: CursorUsageClient
  accessToken: string
  accountID: string
  budget: Seconds = 20
  maxConcurrentDays = 4
  pageSize = 1000
  private cancelled = false
  private endRead: (() => void) | undefined

  constructor(client: CursorUsageClient, accessToken: string, accountID: string) {
    this.client = client
    this.accessToken = accessToken
    this.accountID = accountID
  }

  /**
   * The port of cancelling the task that reads, as leaving the `async let` scope early does upstream:
   * what is in flight is dropped, nothing more is sent, and `read` returns the days it has.
   */
  cancel(): void {
    this.cancelled = true
    this.endRead?.()
  }

  async read(days: Instant[], asOf: Instant, calendar: Calendar): Promise<UsageHistoryRead> {
    let due = 0
    const read = new Map<Instant, UsageDay>()
    const failures: string[] = []
    let deadlineHit = false
    let rateLimitedFor: Seconds | undefined

    // The port of the task group: day reads run until none is left, a rate limit, or the deadline.
    // Whatever is still in flight when the group ends is stopped before its next page and its answer dropped.
    const group = { cancelled: this.cancelled }
    await new Promise<void>((resolve) => {
      if (group.cancelled) {
        resolve()
        return
      }
      let reading = 0
      let timer: ReturnType<typeof setTimeout> | undefined
      const end = (): void => {
        if (group.cancelled) return
        group.cancelled = true
        if (timer !== undefined) clearTimeout(timer)
        resolve()
      }
      this.endRead = end
      const next = (result: DayResult): void => {
        if (group.cancelled) return
        switch (result.type) {
          case 'read':
            read.set(result.start, result.day)
            break
          case 'failed':
            failures.push(result.reason)
            break
          case 'rateLimited':
            rateLimitedFor = result.retryAfter ?? 3600
            end()
            return
          case 'deadline':
            deadlineHit = true
            end()
            return
        }
        reading -= 1
        readNext()
        if (reading <= 0) end()
      }
      const readNext = (): void => {
        if (due >= days.length) return
        const start = days[due]
        due += 1
        reading += 1
        void this.readDay(start, asOf, calendar, group).then(next)
      }
      for (let index = 0; index < this.maxConcurrentDays; index += 1) readNext()
      if (reading <= 0) {
        end()
        return
      }
      timer = setTimeout(() => next({ type: 'deadline' }), this.budget * 1000)
    })

    this.endRead = undefined

    if (this.cancelled) return rateLimitedFor === undefined ? { days: read } : { days: read, rateLimitedFor }
    const first = failures[0]
    if (first !== undefined) {
      AppLog.warn(LogTags.plugin('cursor'), `${this.accountID} usage history: ${failures.length} of ${days.length} days failed (${first})`)
    }
    if (deadlineHit) {
      AppLog.warn(
        LogTags.plugin('cursor'),
        `${this.accountID} usage history: ran out of time with ${days.length - read.size} of ${days.length} days missing`
      )
    }
    if (rateLimitedFor !== undefined) {
      AppLog.warn(LogTags.plugin('cursor'), `${this.accountID} usage history: rate limited; next read in ${Math.trunc(rateLimitedFor)}s`)
    }
    return rateLimitedFor === undefined ? { days: read } : { days: read, rateLimitedFor }
  }

  private async readDay(start: Instant, asOf: Instant, calendar: Calendar, group: { cancelled: boolean }): Promise<DayResult> {
    const next = calendar.dateInterval('day', start).end
    if (!Number.isFinite(next)) return { type: 'failed', reason: 'invalid day' }
    const end = Math.trunc(Math.min(next, asOf)) - 1
    const events: CursorUsageEvent[] = []
    let expectedTotal: number | undefined
    for (let page = 1; ; page += 1) {
      // A cancelled read sends nothing more, as a cancelled task's request fails.
      if (group.cancelled) return { type: 'failed', reason: 'request failed' }
      let response: HTTPResponse
      try {
        const sent = await this.client.fetchUsageEventsPage(this.accessToken, start, end, page, this.pageSize)
        if (!sent) return { type: 'failed', reason: 'request could not be prepared from the current session' }
        response = sent
      } catch {
        return { type: 'failed', reason: 'request failed' }
      }
      if (response.statusCode === 429) {
        const retryAfter = response.retryAfter(asOf)
        return retryAfter === undefined ? { type: 'rateLimited' } : { type: 'rateLimited', retryAfter }
      }
      if (!(response.statusCode >= 200 && response.statusCode < 300)) return { type: 'failed', reason: `HTTP ${response.statusCode}` }
      const parsed = CursorUsageEvents.parsePage(response.body)
      if (!parsed || !parsed.events.every((event) => calendar.startOfDay(event.date) === start)) {
        return { type: 'failed', reason: 'invalid response' }
      }
      if ((expectedTotal ?? parsed.totalCount) !== parsed.totalCount) return { type: 'failed', reason: 'incomplete pages' }
      expectedTotal = parsed.totalCount
      events.push(...parsed.events)
      if (events.length === parsed.totalCount) {
        return { type: 'read', start, day: CursorUsageEvents.day(events) }
      }
      if (!(events.length < parsed.totalCount) || parsed.events.length === 0) return { type: 'failed', reason: 'incomplete pages' }
    }
  }
}
