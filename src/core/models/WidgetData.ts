import { MetricFormatter } from '../support/MetricFormatter'
import { Pace, type PaceStatus } from '../support/Pace'
import { rounded } from '../support/numbers'
import { secondsBetween, type Instant, type Seconds } from '../support/time'
import type { MetricKind } from './MetricKind'
import type { MetricValue } from './MetricValue'
import { PriorityLimits } from './PriorityLimits'
import type { ResetDisplayMode } from './ResetDisplayMode'
import { WidgetDisplayMode } from './WidgetDisplayMode'

export type MeterSeverity = 'normal' | 'warning' | 'critical'

export type MeterState = 'noData' | 'spent' | 'runningOut' | 'closeToLimit' | 'healthy' | 'unpaced'

/**
 * `zeroUsage`: Antigravity supplies reset dates for untouched windows. Only exact zero usage marks them fresh.
 *
 * `missingResetDate`: a missing reset date is the fresh signal: by the time a row carries one, a reset
 * instant means the window started. Claude's five-hour block is created by the first message, so it
 * simply reports no `resets_at` until then; OpenCode does report a placeholder for an untouched window,
 * which `OpenCodeUsageMapper` drops at capture time. Zero usage is NOT trusted here: both APIs report
 * utilization in whole percents, so an in-flight window under 1% also reads 0 - the reset date is what
 * tells the two apart.
 */
export type SessionStartSignal = 'zeroUsage' | 'missingResetDate'

export interface WidgetDataFields {
  title: string
  kind: MetricKind
  currencyCode?: string
  used: number
  limit?: number
  displayMode?: WidgetDisplayMode
  priorityLimits?: PriorityLimits
  resetDisplayMode?: ResetDisplayMode
  resetsAt?: Instant
  expiriesAt?: Instant[]
  showsResetExpiries?: boolean
  periodDurationMs?: number
  valueTextOverride?: string
  unboundedValueWord?: string
  hasData?: boolean
  values?: MetricValue[]
  sessionStartSignal?: SessionStartSignal
  showsPaceMarks?: boolean
}

/** One metric as the dashboard draws it: the reading plus the display settings that shape its text. */
export class WidgetData {
  static readonly noDataValue = '—'
  static readonly noDataDetail = 'No data'

  static readonly expiryWarningWindow: Seconds = 7 * 24 * 60 * 60
  static readonly expiryCriticalWindow: Seconds = 48 * 60 * 60

  title: string
  readonly kind: MetricKind
  currencyCode?: string
  readonly used: number
  limit?: number
  displayMode: WidgetDisplayMode
  priorityLimits: PriorityLimits
  resetDisplayMode: ResetDisplayMode
  resetsAt?: Instant
  expiriesAt: Instant[]
  showsResetExpiries: boolean
  periodDurationMs?: number
  valueTextOverride?: string
  unboundedValueWord?: string
  hasData: boolean
  values: MetricValue[]
  sessionStartSignal?: SessionStartSignal
  showsPaceMarks: boolean

  constructor(fields: WidgetDataFields) {
    this.title = fields.title
    this.kind = fields.kind
    this.currencyCode = fields.currencyCode
    this.used = fields.used
    this.limit = fields.limit
    this.displayMode = fields.displayMode ?? 'used'
    this.priorityLimits = fields.priorityLimits ?? PriorityLimits.standard
    this.resetDisplayMode = fields.resetDisplayMode ?? 'relative'
    this.resetsAt = fields.resetsAt
    this.expiriesAt = fields.expiriesAt ?? []
    this.showsResetExpiries = fields.showsResetExpiries ?? false
    this.periodDurationMs = fields.periodDurationMs
    this.valueTextOverride = fields.valueTextOverride
    this.unboundedValueWord = fields.unboundedValueWord
    this.hasData = fields.hasData ?? true
    this.values = fields.values ?? []
    this.sessionStartSignal = fields.sessionStartSignal
    this.showsPaceMarks = fields.showsPaceMarks ?? true
  }

  /** A copy with some fields replaced: Swift's `var copy = self; copy.x = ...`. */
  with(patch: Partial<WidgetDataFields>): WidgetData {
    return new WidgetData({ ...this.fields(), ...patch })
  }

  fields(): WidgetDataFields {
    return {
      title: this.title,
      kind: this.kind,
      currencyCode: this.currencyCode,
      used: this.used,
      limit: this.limit,
      displayMode: this.displayMode,
      priorityLimits: this.priorityLimits,
      resetDisplayMode: this.resetDisplayMode,
      resetsAt: this.resetsAt,
      expiriesAt: [...this.expiriesAt],
      showsResetExpiries: this.showsResetExpiries,
      periodDurationMs: this.periodDurationMs,
      valueTextOverride: this.valueTextOverride,
      unboundedValueWord: this.unboundedValueWord,
      hasData: this.hasData,
      values: this.values.map((value) => ({ ...value })),
      sessionStartSignal: this.sessionStartSignal,
      showsPaceMarks: this.showsPaceMarks
    }
  }

  equals(other: WidgetData): boolean {
    return JSON.stringify(this.fields()) === JSON.stringify(other.fields())
  }

  get isBounded(): boolean {
    return this.limit !== undefined
  }

  get hasMeterStyleToggle(): boolean {
    return this.hasData && this.isBounded && this.valueTextOverride === undefined
  }

  get displayedValue(): number {
    if (this.displayMode !== 'remaining' || this.limit === undefined) return this.used
    return Math.max(0, this.limit - this.used)
  }

  get fraction(): number {
    if (this.limit === undefined || !(this.limit > 0)) return 0
    return Math.min(Math.max(this.roundedDisplayValue / this.limit, 0), 1)
  }

  get remainingFraction(): number {
    if (this.limit === undefined || !(this.limit > 0)) return 0
    return Math.min(Math.max((this.limit - this.used) / this.limit, 0), 1)
  }

  /** A limit's color, and whether Priority lists it as running low, from what's left alone. Time plays no part. */
  get severity(): MeterSeverity {
    if (!this.hasData || this.limit === undefined || !(this.limit > 0)) return 'normal'
    const percentLeft = rounded(this.remainingFraction * 100)
    if (percentLeft <= this.priorityLimits.critical) return 'critical'
    return percentLeft <= this.priorityLimits.warning ? 'warning' : 'normal'
  }

  private get roundedDisplayValue(): number {
    return this.roundedAtDisplayPrecision(this.displayedValue)
  }

  private roundedAtDisplayPrecision(value: number): number {
    switch (this.kind) {
      case 'percent':
        return rounded(value)
      case 'count':
        return rounded(value * 10) / 10
      case 'dollars':
        return rounded(value * 100) / 100
    }
  }

  get valueText(): string {
    if (!this.hasData) return WidgetData.noDataValue
    if (this.valueTextOverride !== undefined) return this.valueTextOverride
    const first = this.values[0]
    if (first) return MetricFormatter.number(first.number, first.kind, 'row', first.currencyCode)
    return this.format(this.displayedValue)
  }

  /** The value on the tray mark and in its tooltip (`menuBarValue` upstream). */
  get menuBarValue(): string {
    if (!this.hasData) return WidgetData.noDataValue
    if (this.valueTextOverride !== undefined) return this.valueTextOverride
    const first = this.values[0]
    if (first) return MetricFormatter.number(first.number, first.kind, 'tray', first.currencyCode)
    if (this.kind === 'percent' && this.limit !== undefined && this.limit > 0) {
      return MetricFormatter.number((this.displayedValue / this.limit) * 100, 'percent', 'tray')
    }
    return MetricFormatter.number(this.displayedValue, this.kind, 'tray', this.currencyCode)
  }

  get unboundedDetail(): string {
    return this.unboundedFigures.join(' · ')
  }

  get unboundedFigures(): string[] {
    if (!this.hasData) return [WidgetData.noDataDetail]
    if (this.valueTextOverride !== undefined) return [this.valueTextOverride]
    if (this.values.length === 1 && this.values[0].kind === 'dollars' && this.unboundedValueWord !== undefined) {
      const value = this.values[0]
      return [`${MetricFormatter.number(value.number, 'dollars', 'row', value.currencyCode)} ${this.unboundedValueWord}`]
    }
    if (this.values.length > 0) {
      const hasDollars = this.values.some((value) => value.kind === 'dollars')
      return this.values.filter((value) => !hasDollars || value.label !== 'credits').map((value) => MetricFormatter.string(value, 'row'))
    }
    return [`${this.valueText} ${this.unboundedValueWord ?? WidgetDisplayMode.label(this.displayMode).toLowerCase()}`]
  }

  static expirySeverityFor(secondsRemaining: Seconds): MeterSeverity {
    if (secondsRemaining <= WidgetData.expiryCriticalWindow) return 'critical'
    if (secondsRemaining <= WidgetData.expiryWarningWindow) return 'warning'
    return 'normal'
  }

  /**
   * The figure of a row carrying reset expiries warns in the colour of the reset that expires next;
   * beyond the warning window it keeps the row's normal colour.
   */
  expirySeverity(now: Instant = Date.now()): MeterSeverity {
    if (!this.hasData || this.expiriesAt.length === 0) return 'normal'
    const soonest = Math.min(...this.expiriesAt)
    return WidgetData.expirySeverityFor(secondsBetween(soonest, now))
  }

  get resetCreditCount(): number {
    return Math.floor(this.values[0]?.number ?? 0)
  }

  private format(value: number): string {
    return MetricFormatter.number(value, this.kind, 'row', this.currencyCode)
  }

  // Pace

  private get paceContext(): { limit: number; resetsAt: Instant; period: Seconds } | undefined {
    if (!this.hasData || this.limit === undefined || !(this.limit > 0) || this.resetsAt === undefined) return undefined
    if (this.periodDurationMs === undefined || !(this.periodDurationMs > 0)) return undefined
    return { limit: this.limit, resetsAt: this.resetsAt, period: this.periodDurationMs / 1000 }
  }

  meterState(now: Instant = Date.now()): MeterState {
    if (!this.hasData || this.limit === undefined || !(this.limit > 0)) return this.hasData ? 'unpaced' : 'noData'
    if (this.roundedAtDisplayPrecision(this.limit - this.used) <= 0) return 'spent'
    const pace = this.pace(now)
    if (!pace) return 'unpaced'
    switch (pace.status) {
      case 'ahead':
        return 'healthy'
      case 'onTrack': {
        const spare = rounded((1 - pace.projectedFraction) * 100)
        return spare >= 1 ? 'closeToLimit' : 'runningOut'
      }
      case 'behind':
        return 'runningOut'
    }
  }

  paceTooltip(now: Instant = Date.now()): string | undefined {
    if (this.meterState(now) === 'spent') return 'Limit reached'
    const pace = this.pace(now)
    if (!pace) return undefined
    const percent = (share: number): number => rounded(share * 100)
    switch (pace.status) {
      case 'ahead':
        return `~${percent(1 - pace.projectedFraction)}% left at reset`
      case 'onTrack':
        return `~${percent(pace.projectedFraction)}% used at reset`
      case 'behind':
        return `~${Math.max(1, percent(pace.projectedFraction - 1))}% over limit at reset`
    }
  }

  private pace(now: Instant): { status: PaceStatus; projectedFraction: number } | undefined {
    if (this.isFreshSessionWindow(now)) return undefined
    const ctx = this.paceContext
    if (!ctx) return undefined
    const result = Pace.evaluate(this.used, ctx.limit, ctx.resetsAt, ctx.period, now)
    if (!result) return undefined
    if (!(result.status === 'ahead' || this.used / ctx.limit >= 0.05)) return undefined
    return { status: result.status, projectedFraction: result.projectedUsage / ctx.limit }
  }

  /** Where the bar or ring would reach by now at an even pace through the window, measured the way it fills. */
  paceMark(now: Instant = Date.now()): number | undefined {
    const ctx = this.paceContext
    if (!this.showsPaceMarks || !ctx) return undefined
    if (!(this.roundedAtDisplayPrecision(ctx.limit - this.used) > 0) || this.isFreshSessionWindow(now)) return undefined
    const share = Pace.elapsedShare(ctx.resetsAt, ctx.period, now)
    if (share === undefined) return undefined
    return this.displayMode === 'remaining' ? 1 - share : share
  }

  /** How long until the limit at the current pace, or undefined when there's no pace to project from. */
  runway(now: Instant = Date.now()): Seconds | undefined {
    const pace = this.pace(now)
    const ctx = this.paceContext
    if (!pace || !ctx) return undefined
    return (Math.max(0, 1 - this.used / ctx.limit) * ctx.period) / pace.projectedFraction
  }

  isFreshSessionWindow(now: Instant = Date.now()): boolean {
    if (this.sessionStartSignal === undefined || !this.hasData || this.limit === undefined || !(this.used <= 0)) return false
    switch (this.sessionStartSignal) {
      case 'zeroUsage':
        if (this.resetsAt === undefined) return false
        return now < this.resetsAt
      case 'missingResetDate':
        return this.resetsAt === undefined
    }
  }
}
