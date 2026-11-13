import { HistoryRow } from '../models/HistoryRow'
import { UsageHistory, type UsageDay } from '../models/UsageHistory'
import { Calendar } from '../support/Calendar'
import { addSeconds, type Instant, type Seconds } from '../support/time'
import type { AccountProviderRuntime } from './AccountProviderRuntime'

export interface UsageHistoryRead {
  /** The days read in full, keyed by day start. A day that could not be read is left out. */
  days: Map<Instant, UsageDay>
  /** How long to wait when the provider rate-limited the read. */
  rateLimitedFor?: Seconds
}

export interface UsageHistorySource {
  /** The calendar whose days the provider reports. Defaults to the machine's (`Calendar.current`). */
  readonly calendar?: Calendar
  /** How long today and yesterday stay read; undefined rereads them on every refresh. */
  readonly rereadInterval?: Seconds
  /** Today's read ends at `asOf`. */
  read(days: Instant[], asOf: Instant, calendar: Calendar): Promise<UsageHistoryRead>
}

/** An account's read days, in memory only. Its source is its only writer. */
export class UsageLedger {
  days = new Map<Instant, UsageDay>()
  /** Nothing is read before this once the provider rate-limited a read. */
  private resumeAt: Instant | undefined
  /** Today at the last record, whose read ended before the day did. */
  private partialDay: Instant | undefined
  /** When the last read was sent, and the day that was today then. */
  private lastRead: { at: Instant; today: Instant } | undefined

  /**
   * `span` runs back from today. Today and yesterday are read on every refresh, an older day until one
   * read of it after its end succeeds.
   */
  due(span: Instant[]): Instant[] {
    return [...span.slice(0, 2), ...span.slice(2).filter((day) => !this.days.has(day) || day === this.partialDay)]
  }

  /**
   * Days outside `span` are dropped, and a due day that did not come back is unread, so a failed re-read
   * hides its rows instead of showing an old value.
   */
  record(read: Map<Instant, UsageDay>, due: Instant[], span: Instant[]): void {
    const dueSet = new Set(due)
    const kept = new Set(span.filter((day) => !dueSet.has(day)))
    const next = new Map<Instant, UsageDay>()
    for (const [day, value] of this.days) if (kept.has(day)) next.set(day, value)
    for (const [day, value] of read) next.set(day, value)
    this.days = next
    this.partialDay = span[0]
  }

  isHeld(now: Instant): boolean {
    return this.resumeAt !== undefined && now < this.resumeAt
  }

  hold(wait: Seconds, now: Instant): void {
    this.resumeAt = addSeconds(now, wait)
  }

  /**
   * Whether nothing is due for a source that rereads once per `interval`: the last read was sent on this
   * same day, less than `interval` ago. A new day is read at once.
   */
  isResting(span: Instant[], now: Instant, interval: Seconds): boolean {
    if (!this.lastRead || this.lastRead.today !== span[0]) return false
    return now < addSeconds(this.lastRead.at, interval)
  }

  noteRead(now: Instant, today: Instant): void {
    this.lastRead = { at: now, today }
  }

  /** A forced refresh reads today and yesterday again at once. */
  forgetLastRead(): void {
    this.lastRead = undefined
  }
}

/** Reads the due days and returns every read day. Never throws, so history cannot fail the card. */
export async function refreshHistory(
  rt: AccountProviderRuntime,
  source: UsageHistorySource,
  ledger: UsageLedger = rt.usageLedger
): Promise<UsageHistory | undefined> {
  const dayCount = HistoryRow.dayCount(rt.widgetDescriptors)
  if (dayCount === undefined) return undefined
  const calendar = source.calendar ?? Calendar.current
  const asOf = rt.now()
  const span = UsageHistory.dayStartsBack(dayCount, asOf, calendar)
  if (source.rereadInterval !== undefined && ledger.isResting(span, asOf, source.rereadInterval)) {
    return UsageHistory.make(calendar, asOf, ledger.days)
  }
  const due = ledger.due(span)
  if (ledger.isHeld(asOf)) {
    ledger.record(new Map(), due, span)
  } else {
    ledger.noteRead(asOf, span[0])
    let read: UsageHistoryRead
    try {
      read = await source.read(due, asOf, calendar)
    } catch {
      read = { days: new Map() }
    }
    ledger.record(read.days, due, span)
    if (read.rateLimitedFor !== undefined) ledger.hold(read.rateLimitedFor, rt.now())
  }
  return UsageHistory.make(calendar, asOf, ledger.days)
}
