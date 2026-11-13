import type { Instant } from './time'

export interface DateInterval {
  start: Instant
  /** Exclusive end, as `DateInterval.end` is for `contains` on a day start. */
  end: Instant
}

export interface DateComponents {
  year: number
  /** 1...12 */
  month: number
  /** 1...31 */
  day: number
  hour: number
  minute: number
  second: number
  /** 1 = Sunday ... 7 = Saturday, as in Foundation. */
  weekday: number
}

/**
 * The slice of Foundation's `Calendar` the app uses: a Gregorian calendar in either the machine's time
 * zone or UTC, with a first weekday (1 = Sunday ... 7 = Saturday).
 */
export class Calendar {
  readonly timeZone: 'local' | 'utc'
  readonly firstWeekday: number

  constructor(timeZone: 'local' | 'utc' = 'local', firstWeekday?: number) {
    this.timeZone = timeZone
    this.firstWeekday = firstWeekday ?? (timeZone === 'utc' ? 1 : Calendar.localeFirstWeekday())
  }

  /** `Calendar.current` */
  static get current(): Calendar {
    return (Calendar.cachedCurrent ??= new Calendar('local'))
  }

  /** `Calendar.utc`: Gregorian, UTC, weeks starting on Sunday. */
  static readonly utc = new Calendar('utc', 1)

  private static cachedCurrent: Calendar | undefined

  private static localeFirstWeekday(): number {
    try {
      const locale = new Intl.Locale(Intl.DateTimeFormat().resolvedOptions().locale) as Intl.Locale & {
        getWeekInfo?: () => { firstDay: number }
        weekInfo?: { firstDay: number }
      }
      const firstDay = locale.getWeekInfo?.().firstDay ?? locale.weekInfo?.firstDay
      // Intl: 1 = Monday ... 7 = Sunday. Foundation: 1 = Sunday ... 7 = Saturday.
      if (typeof firstDay === 'number') return (firstDay % 7) + 1
    } catch {
      // Fall through to Sunday.
    }
    return 1
  }

  /** A copy with another first weekday, like setting `calendar.firstWeekday`. */
  withFirstWeekday(firstWeekday: number): Calendar {
    return new Calendar(this.timeZone, firstWeekday)
  }

  components(instant: Instant): DateComponents {
    const date = new Date(instant)
    if (this.timeZone === 'utc') {
      return {
        year: date.getUTCFullYear(),
        month: date.getUTCMonth() + 1,
        day: date.getUTCDate(),
        hour: date.getUTCHours(),
        minute: date.getUTCMinutes(),
        second: date.getUTCSeconds(),
        weekday: date.getUTCDay() + 1
      }
    }
    return {
      year: date.getFullYear(),
      month: date.getMonth() + 1,
      day: date.getDate(),
      hour: date.getHours(),
      minute: date.getMinutes(),
      second: date.getSeconds(),
      weekday: date.getDay() + 1
    }
  }

  /** The instant of a calendar date at midnight. Out-of-range days and months roll over, as in `Date`. */
  date(year: number, month: number, day: number, hour = 0, minute = 0, second = 0): Instant {
    if (this.timeZone === 'utc') return Date.UTC(year, month - 1, day, hour, minute, second)
    return new Date(year, month - 1, day, hour, minute, second).getTime()
  }

  startOfDay(instant: Instant): Instant {
    const c = this.components(instant)
    return this.date(c.year, c.month, c.day)
  }

  /** `date(byAdding: .day, value:, to:)`: the same wall-clock time `days` calendar days away. */
  addingDays(instant: Instant, days: number): Instant {
    const c = this.components(instant)
    const ms = instant - this.date(c.year, c.month, c.day, c.hour, c.minute, c.second)
    return this.date(c.year, c.month, c.day + days, c.hour, c.minute, c.second) + ms
  }

  /** `dateComponents([.day], from: startOfDay(a), to: startOfDay(b)).day`: whole calendar days from `from` to `to`. */
  daysBetween(from: Instant, to: Instant): number {
    const a = this.components(from)
    const b = this.components(to)
    return Math.round((Date.UTC(b.year, b.month - 1, b.day) - Date.UTC(a.year, a.month - 1, a.day)) / 86_400_000)
  }

  isSameDay(a: Instant, b: Instant): boolean {
    return this.daysBetween(a, b) === 0
  }

  /** `dateInterval(of: .weekOfYear / .month, for:)` */
  dateInterval(of: 'weekOfYear' | 'month' | 'day', instant: Instant): DateInterval {
    const c = this.components(instant)
    if (of === 'day') {
      return { start: this.date(c.year, c.month, c.day), end: this.date(c.year, c.month, c.day + 1) }
    }
    if (of === 'month') {
      return { start: this.date(c.year, c.month, 1), end: this.date(c.year, c.month + 1, 1) }
    }
    const back = (c.weekday - this.firstWeekday + 7) % 7
    return { start: this.date(c.year, c.month, c.day - back), end: this.date(c.year, c.month, c.day - back + 7) }
  }

  /** The IANA name `Intl` formatters take for this calendar's zone; undefined means the machine's own. */
  get intlTimeZone(): string | undefined {
    return this.timeZone === 'utc' ? 'UTC' : undefined
  }
}

export function intervalContains(interval: DateInterval, instant: Instant): boolean {
  return instant >= interval.start && instant < interval.end
}
