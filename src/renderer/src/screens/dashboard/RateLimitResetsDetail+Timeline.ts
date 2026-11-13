import { WidgetData, type MeterSeverity } from '@core/models/WidgetData'
import { ZAIResetWindow, type ZAIReset } from '@core/providers/zai/ZAIResets'
import { Formatters } from '@core/support/Formatters'
import { secondsBetween, type Instant } from '@core/support/time'

/** What tells one node of the timeline from the next: two resets can share an expiry. */
export interface ResetEntryKey {
  readonly date: Instant
  readonly ordinal: number
  /** The exact record a window entry claims; undefined on the flat timeline, which claims by date. */
  readonly reset?: ZAIReset
}

export interface ResetEntry {
  readonly id: number
  readonly number: number
  readonly date: Instant
  readonly key: ResetEntryKey
  /** `key` as a string, for comparing and for React. */
  readonly keyID: string
  readonly severity: MeterSeverity
  readonly time: string
  readonly countdown?: string
}

export const ResetEntry = {
  keyID(key: ResetEntryKey): string {
    const reset = key.reset
    return reset === undefined ? `${key.date}:${key.ordinal}` : `${key.date}:${key.ordinal}:${reset.window}:${reset.recordID}:${reset.grantType}`
  },

  accessibilityLabel(entry: ResetEntry): string {
    return `Reset ${entry.number}, ${entry.time}` + (entry.countdown !== undefined ? `, expires in ${entry.countdown}` : '')
  }
}

export type ResetsContent = { type: 'timeline'; entries: ResetEntry[] } | { type: 'unknownExpiries'; count: number } | { type: 'empty' }

export interface ResetsWindow {
  readonly window: ZAIResetWindow
  readonly entries: ResetEntry[]
}

export const ResetsTimeline = {
  content(count: number, expiries: Instant[], now: Instant = Date.now()): ResetsContent {
    const entries = ResetsTimeline.entries(expiries, now)
    if (entries.length > 0) return { type: 'timeline', entries }
    if (count > 0) return { type: 'unknownExpiries', count }
    return { type: 'empty' }
  },

  contentEntries(content: ResetsContent): ResetEntry[] {
    return content.type === 'timeline' ? content.entries : []
  },

  /**
   * The expiries still on the timeline once `claimed` resets have been used: one occurrence of a
   * date per claim, since a login that repeats one expiry per reset left shares it between nodes.
   */
  visibleExpiries(expiries: Instant[], claimed: ReadonlyMap<Instant, number>): Instant[] {
    const remaining = new Map(claimed)
    return expiries.filter((date) => {
      const left = remaining.get(date)
      if (left === undefined || left <= 0) return true
      remaining.set(date, left - 1)
      return false
    })
  },

  /** Each window's resets on its own timeline, in the given earliest-first order. */
  windows(resets: ZAIReset[], now: Instant = Date.now()): ResetsWindow[] {
    const windows: ResetsWindow[] = []
    for (const window of ZAIResetWindow.allCases) {
      const own = resets.filter((reset) => reset.window === window)
      if (own.length === 0) continue
      windows.push({
        window,
        entries: ResetsTimeline.entriesOf(
          own.map((reset) => ({ date: reset.expiresAt, reset })),
          now
        )
      })
    }
    return windows
  },

  entries(expiries: Instant[], now: Instant = Date.now()): ResetEntry[] {
    return ResetsTimeline.entriesOf(
      expiries.map((date) => ({ date })),
      now
    )
  },

  /** Each expiry travels with the record it claims, so sorting can never pair a date with another record. */
  entriesOf(items: { date: Instant; reset?: ZAIReset }[], now: Instant = Date.now()): ResetEntry[] {
    const seen = new Map<Instant, number>()
    const sorted = items
      .map((item, offset) => ({ item, offset }))
      .sort((a, b) => a.item.date - b.item.date || (a.item.reset?.recordID ?? 0) - (b.item.reset?.recordID ?? 0) || a.offset - b.offset)
      .map((entry) => entry.item)
    return sorted.map(({ date, reset }, index): ResetEntry => {
      const ordinal = seen.get(date) ?? 0
      seen.set(date, ordinal + 1)
      const relative = Formatters.whenLabel(date, 'relative', now)
      const absolute = Formatters.whenLabel(date, 'absolute', now)
      const imminent = relative === undefined || relative === Formatters.imminent
      const key: ResetEntryKey = reset === undefined ? { date, ordinal } : { date, ordinal, reset }
      const entry: ResetEntry = {
        id: index,
        number: index + 1,
        date,
        key,
        keyID: ResetEntry.keyID(key),
        severity: WidgetData.expirySeverityFor(secondsBetween(date, now)),
        time: imminent || absolute === undefined ? 'Expiring soon' : absolute
      }
      return imminent ? entry : { ...entry, countdown: relative }
    })
  }
}
