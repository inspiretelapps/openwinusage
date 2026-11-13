import { MetricLine } from './MetricLine'
import type { MetricValue } from './MetricValue'
import type { Provider } from './Provider'
import type { ProviderSnapshot } from './ProviderSnapshot'
import { UsageBreakdown, UsageHistory, UsageMeasure, UsageWindow } from './UsageHistory'
import { WidgetDescriptor } from './WidgetDescriptor'

/** What one history row shows. A row holds two figures at most, because a third overflows the value column. */
export type HistoryRow =
  /** "Today  $1.20 · 1.2M tokens" */
  | { type: 'window'; window: UsageWindow; first: UsageMeasure; then?: UsageMeasure }
  /** "Usage Events  4.1K in 30 days" */
  | { type: 'measure'; title: string; measure: UsageMeasure; over: UsageWindow }

export const HistoryRow = {
  window(window: UsageWindow, first: UsageMeasure, then?: UsageMeasure): HistoryRow {
    return then === undefined ? { type: 'window', window, first } : { type: 'window', window, first, then }
  },

  measure(title: string, measure: UsageMeasure, over: UsageWindow): HistoryRow {
    return { type: 'measure', title, measure, over }
  },

  title(row: HistoryRow): string {
    return row.type === 'window' ? UsageWindow.title(row.window) : row.title
  },

  windowOf(row: HistoryRow): UsageWindow {
    return row.type === 'window' ? row.window : row.over
  },

  /** Undefined when none of the row's figures was reported. */
  line(row: HistoryRow, label: string, history: UsageHistory): MetricLine | undefined {
    const totals = UsageHistory.totals(history, HistoryRow.windowOf(row))
    if (!totals) return undefined
    let values: MetricValue[]
    if (row.type === 'window') {
      values = [row.first, row.then]
        .filter((measure): measure is UsageMeasure => measure !== undefined)
        .flatMap((measure) => {
          const number = totals.values[measure]
          return number === undefined ? [] : [UsageMeasure.metricValue(measure, number)]
        })
    } else {
      const number = totals.values[row.measure]
      values =
        number === undefined
          ? []
          : [{ number, kind: UsageMeasure.metricValue(row.measure, number).kind, label: UsageWindow.phrase(row.over) }]
    }
    return values.length === 0 ? undefined : MetricLine.values(label, values)
  },

  /** The window rows' hover detail; a measure row has none. */
  breakdown(row: HistoryRow, history: UsageHistory): UsageBreakdown | undefined {
    return row.type === 'window' ? UsageBreakdown.make(row.window, history) : undefined
  },

  /** Adds the descriptors' history rows and their breakdowns to the snapshot. */
  append(snapshot: ProviderSnapshot, descriptors: WidgetDescriptor[], history: UsageHistory | undefined): void {
    if (!history) return
    const breakdowns: Record<string, UsageBreakdown> = {}
    for (const descriptor of descriptors) {
      const row = descriptor.historyRow
      if (!row) continue
      const line = HistoryRow.line(row, descriptor.metricLabel, history)
      if (line) snapshot.lines.push(line)
      const breakdown = HistoryRow.breakdown(row, history)
      if (breakdown) breakdowns[descriptor.key] = breakdown
    }
    if (Object.keys(breakdowns).length === 0) delete snapshot.usageBreakdowns
    else snapshot.usageBreakdowns = breakdowns
  },

  /** How many days back from today the descriptors' rows reach, so a source reads exactly those. */
  dayCount(descriptors: WidgetDescriptor[]): number | undefined {
    const bounds = descriptors
      .map((descriptor) => (descriptor.historyRow ? UsageWindow.dayOffsets(HistoryRow.windowOf(descriptor.historyRow))?.upperBound : undefined))
      .filter((bound): bound is number => bound !== undefined)
    return bounds.length === 0 ? undefined : Math.max(...bounds) + 1
  },

  /** `WidgetDescriptor.history(key:provider:_:)`: a values row fed by a usage-history window. */
  descriptor(key: string, provider: Provider, row: HistoryRow): WidgetDescriptor {
    const descriptor = WidgetDescriptor.values({ key, provider, title: HistoryRow.title(row) })
    descriptor.historyRow = row
    if (row.type === 'window') {
      descriptor.unreportedValues = [row.first, row.then]
        .filter((measure): measure is UsageMeasure => measure !== undefined)
        .map((measure) => UsageMeasure.metricValue(measure, 0))
    }
    return descriptor
  }
}
