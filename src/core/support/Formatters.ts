import { Calendar } from './Calendar'
import { ProviderParse } from './ProviderParse'
import { roundedUp } from './numbers'
import { secondsBetween, type Instant, type Seconds } from './time'
import { TimeFormatSetting } from '../stores/TimeFormatSetting'
import type { ResetDisplayMode } from '../models/ResetDisplayMode'

/** `Int.max` */
const intMax = 2n ** 63n - 1n

export const Formatters = {
  imminent: 'soon',

  /** `Nov 3` */
  monthDayLabel(date: Instant): string {
    return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' }).format(date)
  },

  whenLabel(date: Instant, mode: ResetDisplayMode, now: Instant = Date.now(), calendar: Calendar = Calendar.current): string | undefined {
    switch (mode) {
      case 'relative': {
        const seconds = secondsBetween(date, now)
        if (seconds <= 5 * 60) return Formatters.imminent
        return Formatters.compactDuration(seconds)
      }
      case 'absolute': {
        if (secondsBetween(date, now) <= 0) return Formatters.imminent
        const dayDiff = calendar.daysBetween(now, date)
        const time = TimeFormatSetting.shortTime(TimeFormatSetting.current, date)
        if (dayDiff <= 0) return `today at ${time}`
        if (dayDiff === 1) return `tomorrow at ${time}`
        return `${Formatters.monthDayLabel(date)} at ${time}`
      }
    }
  },

  compactClock(date: Instant, now: Instant = Date.now(), calendar: Calendar = Calendar.current): string {
    const days = calendar.daysBetween(now, date)
    if (days <= 0) return TimeFormatSetting.shortTime(TimeFormatSetting.current, date)
    if (days < 7) return TimeFormatSetting.weekdayTime(TimeFormatSetting.current, date)
    return Formatters.monthDayLabel(date)
  },

  /** `2d 4h`, `1h 13m`, `5m`; undefined for nothing left. */
  compactDuration(seconds: Seconds): string | undefined {
    if (!Number.isFinite(seconds) || seconds <= 0) return undefined
    // Swift counts the minutes in an `Int`, and `Int.max` of them for a duration too long for one.
    // Whole-number `BigInt` arithmetic keeps a far-off reset reading the same here.
    const wholeMinutes = ProviderParse.int(roundedUp(seconds / 60))
    const totalMinutes = wholeMinutes === undefined ? intMax : BigInt(Math.max(1, wholeMinutes))
    const days = totalMinutes / (24n * 60n)
    const hours = (totalMinutes % (24n * 60n)) / 60n
    const minutes = totalMinutes % 60n

    if (days > 0n) return `${days}d ${hours}h`
    if (hours > 0n) return minutes > 0n ? `${hours}h ${minutes}m` : `${hours}h`
    return `${minutes}m`
  }
}
