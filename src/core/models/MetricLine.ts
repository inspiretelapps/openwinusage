import type { Instant } from '../support/time'
import type { MetricKind } from './MetricKind'
import type { MetricValue } from './MetricValue'

export type ProgressFormat =
  | { type: 'percent' }
  | { type: 'dollars' }
  | { type: 'currency'; code: string }
  | { type: 'count'; suffix: string }

export const ProgressFormat = {
  percent: { type: 'percent' } as ProgressFormat,
  dollars: { type: 'dollars' } as ProgressFormat,
  currency: (code: string): ProgressFormat => ({ type: 'currency', code }),
  count: (suffix: string): ProgressFormat => ({ type: 'count', suffix }),

  metricKind(format: ProgressFormat): MetricKind {
    switch (format.type) {
      case 'percent':
        return 'percent'
      case 'dollars':
      case 'currency':
        return 'dollars'
      case 'count':
        return 'count'
    }
  },

  currencyCode(format: ProgressFormat): string | undefined {
    return format.type === 'currency' ? format.code : undefined
  }
}

export interface ValuesLine {
  type: 'values'
  label: string
  values: MetricValue[]
  expiriesAt: Instant[]
}

export interface ProgressLine {
  type: 'progress'
  label: string
  used: number
  limit: number
  format: ProgressFormat
  resetsAt?: Instant
  periodDurationMs?: number
}

export interface BadgeLine {
  type: 'badge'
  label: string
  text: string
}

/** One row a provider reports. The Swift enum's cases are the `type` here. */
export type MetricLine = ValuesLine | ProgressLine | BadgeLine

export const MetricLine = {
  values(label: string, values: MetricValue[], expiriesAt: Instant[] = []): MetricLine {
    return { type: 'values', label, values, expiriesAt }
  },

  progress(
    label: string,
    used: number,
    limit: number,
    format: ProgressFormat,
    resetsAt?: Instant,
    periodDurationMs?: number
  ): MetricLine {
    const line: ProgressLine = { type: 'progress', label, used, limit, format }
    if (resetsAt !== undefined) line.resetsAt = resetsAt
    if (periodDurationMs !== undefined) line.periodDurationMs = periodDurationMs
    return line
  },

  badge(label: string, text: string): MetricLine {
    return { type: 'badge', label, text }
  },

  /** A 0-100 progress line. */
  percent(label: string, used: number, resetsAt?: Instant, periodMs?: number): MetricLine {
    return MetricLine.progress(label, used, 100, ProgressFormat.percent, resetsAt, periodMs)
  }
}
