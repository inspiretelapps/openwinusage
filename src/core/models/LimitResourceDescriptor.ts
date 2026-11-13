import type { MetricKind } from './MetricKind'
import type { MetricValue } from './MetricValue'

export type LimitResourceKind = 'consumption' | 'balance'

export type LimitResourceSource =
  | { type: 'progress' }
  | { type: 'value'; kind: MetricKind; label?: string }
  | { type: 'progressOrValue'; kind: MetricKind; label?: string }

export const LimitResourceSource = {
  progress: { type: 'progress' } as LimitResourceSource,
  value: (kind: MetricKind, label?: string): LimitResourceSource => (label === undefined ? { type: 'value', kind } : { type: 'value', kind, label }),
  progressOrValue: (kind: MetricKind, label?: string): LimitResourceSource =>
    label === undefined ? { type: 'progressOrValue', kind } : { type: 'progressOrValue', kind, label }
}

/** How one metric is exported by the command line: its key, kind, unit, and which figure of the line it reads. */
export interface LimitResourceDescriptor {
  readonly key: string
  readonly kind: LimitResourceKind
  readonly unit: string
  readonly source: LimitResourceSource
}

export const LimitResourceDescriptor = {
  /** The figure of a values line this resource reads. */
  value(resource: LimitResourceDescriptor, values: MetricValue[]): MetricValue | undefined {
    const source = resource.source
    if (source.type === 'progress') return undefined
    return values.find((value) => value.kind === source.kind && (source.label === undefined || value.label === source.label))
  }
}
