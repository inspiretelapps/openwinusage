import { Formatters } from '../support/Formatters'
import { MetricFormatter } from '../support/MetricFormatter'
import { secondsBetween, type Instant } from '../support/time'
import type { ResetDisplayMode } from './ResetDisplayMode'
import type { MeterSeverity, WidgetData } from './WidgetData'
import { WidgetDisplayMode } from './WidgetDisplayMode'

export type DashboardRowMark =
  | { type: 'bar'; fill: number; severity: MeterSeverity; value: string; reset?: string; isUsedUp: boolean }
  | { type: 'value'; text: string; detail?: string; severity: MeterSeverity }

export interface DashboardRowModel {
  readonly label: string
  readonly mark: DashboardRowMark
  /** Clock times run wider than countdowns, so they get the wider reset lane. */
  showsClockTimes: boolean
  /** Where the bar would reach by now at an even pace, or undefined when it has no mark. */
  paceMark?: number
}

function resetReading(resetsAt: Instant, mode: ResetDisplayMode, now: Instant): string | undefined {
  switch (mode) {
    case 'relative':
      return Formatters.compactDuration(secondsBetween(resetsAt, now))
    case 'absolute':
      return Formatters.compactClock(resetsAt, now)
  }
}

export const DashboardRowModel = {
  /** A limit that's used up with nothing left to draw. Under Used its bar is full and stays at full strength. */
  isFaded(row: DashboardRowModel): boolean {
    return row.mark.type === 'bar' && row.mark.isUsedUp && row.mark.fill === 0
  },

  /** `WidgetData.dashboardRow(now:)` */
  make(data: WidgetData, now: Instant = Date.now()): DashboardRowModel {
    if (!data.hasData || !data.isBounded) {
      const figures = data.unboundedFigures
      const detail = figures.length > 1 ? figures.slice(1).join(' · ') : undefined
      return {
        label: data.title,
        mark: { type: 'value', text: figures[0], detail, severity: data.expirySeverity(now) },
        showsClockTimes: false
      }
    }
    return {
      label: data.title,
      mark: {
        type: 'bar',
        fill: data.fraction,
        severity: data.severity,
        value: data.valueText,
        reset: DashboardRowModel.compactResetText(data, now),
        isUsedUp: data.meterState(now) === 'spent'
      },
      showsClockTimes: data.resetDisplayMode === 'absolute',
      paceMark: data.paceMark(now)
    }
  },

  /** The reading with the word that explains it, like `49% left`. */
  amountText(data: WidgetData): string {
    return data.hasMeterStyleToggle ? `${data.valueText} ${WidgetDisplayMode.label(data.displayMode).toLowerCase()}` : data.valueText
  },

  compactResetText(data: WidgetData, now: Instant = Date.now()): string | undefined {
    if (!data.hasData || data.resetsAt === undefined || data.isFreshSessionWindow(now)) return undefined
    if (!(secondsBetween(data.resetsAt, now) > 0)) return Formatters.imminent
    return resetReading(data.resetsAt, data.resetDisplayMode, now)
  },

  resetTooltip(data: WidgetData, now: Instant = Date.now()): string | undefined {
    if (!data.hasData || data.resetsAt === undefined || data.isFreshSessionWindow(now)) return undefined
    if (!(secondsBetween(data.resetsAt, now) > 0)) return undefined
    return resetReading(data.resetsAt, data.resetDisplayMode === 'relative' ? 'absolute' : 'relative', now)
  },

  meterStyleTooltip(data: WidgetData): string | undefined {
    if (!data.hasMeterStyleToggle || data.limit === undefined) return undefined
    const other = data.displayMode === 'remaining' ? data.used : Math.max(0, data.limit - data.used)
    const word = WidgetDisplayMode.label(data.displayMode === 'remaining' ? 'used' : 'remaining').toLowerCase()
    return `${MetricFormatter.number(other, data.kind, 'row', data.currencyCode)} ${word}`
  }
}
