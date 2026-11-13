import type { MetricKind } from './MetricKind'

export interface MetricValue {
  number: number
  kind: MetricKind
  label?: string
  currencyCode?: string
}

export function metricValue(number: number, kind: MetricKind, label?: string, currencyCode?: string): MetricValue {
  const value: MetricValue = { number, kind }
  if (label !== undefined) value.label = label
  if (currencyCode !== undefined) value.currencyCode = currencyCode
  return value
}
