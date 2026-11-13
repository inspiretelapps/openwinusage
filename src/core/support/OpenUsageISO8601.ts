import type { Instant } from './time'

const loose = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}:\d{2})(?:\.(\d+))?(Z|[+-]\d{2}:\d{2})?/
const strict = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(Z|[+-]\d{2}:\d{2})$/

export const OpenUsageISO8601 = {
  /** Internet date-time with milliseconds, in UTC: `2026-07-13T01:40:00.000Z`. */
  string(from: Instant): string {
    return new Date(from).toISOString()
  },

  /** Parses the timestamp shapes providers send; undefined for anything else. */
  date(value: string): Instant | undefined {
    let s = value.trim()
    if (s.endsWith(' UTC')) s = s.slice(0, -4) + 'Z'
    const match = loose.exec(s)
    if (match) {
      const [whole, day, time, digits, zone] = match
      if (whole.length === s.length) {
        const fraction = digits === undefined ? '' : '.' + digits.slice(0, 3).padEnd(3, '0')
        s = `${day}T${time}${fraction}${zone ?? 'Z'}`
      } else {
        s = `${day}T${s.slice(day.length + 1)}`
      }
    }
    const parts = strict.exec(s)
    if (!parts) return undefined
    const [, year, month, dayOfMonth, hour, minute, second, fraction, zone] = parts
    const ms = fraction === undefined ? 0 : Math.trunc(Number('0.' + fraction) * 1000)
    const local = Date.UTC(
      Number(year),
      Number(month) - 1,
      Number(dayOfMonth),
      Number(hour),
      Number(minute),
      Number(second),
      ms
    )
    if (!Number.isFinite(local)) return undefined
    // Reject dates the calendar doesn't have (month 13, day 32), which `Date.UTC` would roll over.
    const check = new Date(local)
    if (check.getUTCMonth() !== Number(month) - 1 || check.getUTCDate() !== Number(dayOfMonth)) return undefined
    if (Number(hour) > 23 || Number(minute) > 59 || Number(second) > 60) return undefined
    if (zone === 'Z') return local
    const sign = zone.startsWith('-') ? -1 : 1
    const offsetMinutes = Number(zone.slice(1, 3)) * 60 + Number(zone.slice(4, 6))
    return local - sign * offsetMinutes * 60_000
  }
}
