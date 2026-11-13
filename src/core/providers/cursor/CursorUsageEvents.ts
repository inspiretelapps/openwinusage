import { UsageTotals, type UsageDay, type UsageMeasure } from '../../models/UsageHistory'
import { rounded } from '../../support/numbers'
import { asArray, asObject, asString, ProviderParse } from '../../support/ProviderParse'
import type { Instant } from '../../support/time'

export interface CursorUsageEventsPage {
  totalCount: number
  events: CursorUsageEvent[]
}

export interface CursorUsageEvent {
  date: Instant
  model?: string
  totals: UsageTotals
}

/** `value as? Bool` on a decoded JSON value: a boolean, or the numbers 0 and 1, which Foundation bridges. */
export function asBool(value: unknown): boolean | undefined {
  if (typeof value === 'boolean') return value
  if (value === 0) return false
  if (value === 1) return true
  return undefined
}

const tokenKinds: { field: string; measure: UsageMeasure }[] = [
  { field: 'inputTokens', measure: 'inputTokens' },
  { field: 'cacheReadTokens', measure: 'cacheReadTokens' },
  { field: 'cacheWriteTokens', measure: 'cacheWriteTokens' },
  { field: 'outputTokens', measure: 'outputTokens' }
]

export const CursorUsageEvents = {
  /**
   * On-demand usage, the only kind Cursor bills. Included, errored, and free events carry a
   * `chargedCents` too, but for them it is the value taken from the plan, not a charge.
   */
  chargeableKind: 'USAGE_EVENT_KIND_USAGE_BASED',
  measures: ['spend', 'usageEvents', 'tokens', 'inputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'outputTokens'] as UsageMeasure[],

  /**
   * Undefined when the page or any event on it is not what Cursor sends, so a day is never summed from part
   * of its events. Cursor leaves out an empty event list, a zero `chargedCents`, and a zero token kind.
   * An event without `tokenUsage` counts zero tokens.
   */
  parsePage(data: Uint8Array | string): CursorUsageEventsPage | undefined {
    const object = ProviderParse.jsonObject(data)
    if (!object) return undefined
    const total = ProviderParse.number(object.totalUsageEventsCount)
    if (total === undefined || !(total >= 0) || rounded(total) !== total || !(total < 1e15)) return undefined
    const rawEvents = object.usageEventsDisplay === undefined ? [] : asArray(object.usageEventsDisplay)
    if (!rawEvents) return undefined

    const events: CursorUsageEvent[] = []
    for (const rawEvent of rawEvents) {
      const event = asObject(rawEvent)
      if (!event) return undefined
      const milliseconds = ProviderParse.number(event.timestamp)
      if (milliseconds === undefined || !(milliseconds >= 0)) return undefined
      const totals = UsageTotals.make({ spend: 0, usageEvents: 1 })
      if (asString(event.kind) === CursorUsageEvents.chargeableKind && asBool(event.isChargeable) !== false && event.chargedCents !== undefined) {
        const cents = ProviderParse.number(event.chargedCents)
        if (cents === undefined || !(cents >= 0)) return undefined
        totals.values.spend = cents / 100
      }
      const usage = event.tokenUsage === undefined ? {} : asObject(event.tokenUsage)
      if (!usage) return undefined
      let tokens = 0.0
      for (const kind of tokenKinds) {
        let count = 0.0
        const rawCount = usage[kind.field]
        if (rawCount !== undefined) {
          const parsed = ProviderParse.number(rawCount)
          if (parsed === undefined || !(parsed >= 0)) return undefined
          count = parsed
        }
        totals.values[kind.measure] = count
        tokens += count
      }
      totals.values.tokens = tokens
      const parsedEvent: CursorUsageEvent = { date: milliseconds, totals }
      const model = asString(event.model)
      if (model !== undefined) parsedEvent.model = model
      events.push(parsedEvent)
    }
    return { totalCount: Math.trunc(total), events }
  },

  /** One day's events summed: a day with no events reports zeros. */
  day(events: CursorUsageEvent[]): UsageDay {
    const sum = (events: CursorUsageEvent[]): UsageTotals =>
      events.reduce((totals, event) => UsageTotals.adding(totals, event.totals), UsageTotals.zero(CursorUsageEvents.measures))
    const grouped = new Map<string, CursorUsageEvent[]>()
    for (const event of events) {
      if (event.model === undefined) continue
      const group = grouped.get(event.model)
      if (group) group.push(event)
      else grouped.set(event.model, [event])
    }
    const byModel: Record<string, UsageTotals> = {}
    for (const [model, group] of grouped) byModel[model] = sum(group)
    return { totals: sum(events), byModel }
  }
}
