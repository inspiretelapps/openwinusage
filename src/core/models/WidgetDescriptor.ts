import type { ProviderKind } from './Account'
import type { HistoryRow } from './HistoryRow'
import { LimitResourceDescriptor, LimitResourceSource, type LimitResourceKind } from './LimitResourceDescriptor'
import type { MetricValue } from './MetricValue'
import type { Provider } from './Provider'
import { WidgetData, type SessionStartSignal } from './WidgetData'

/** One metric an account can show: where it reads from (`metricLabel`), how it draws (`sample`), and what the command line exports. */
export class WidgetDescriptor {
  readonly id: string
  readonly providerID: string
  readonly providerKind: ProviderKind
  readonly key: string
  readonly metricLabel: string
  readonly sample: WidgetData
  limitResources: LimitResourceDescriptor[] = []
  historyRow?: HistoryRow
  /** What the row reads when the provider reports nothing for it; undefined hides the row instead. */
  unreportedValues?: MetricValue[]

  constructor(provider: Provider, key: string, metricLabel: string, sample: WidgetData) {
    this.id = `${provider.id}.${key}`
    this.providerID = provider.id
    this.providerKind = provider.kind
    this.key = key
    this.metricLabel = metricLabel
    this.sample = sample
  }

  private copy(): WidgetDescriptor {
    const copy: WidgetDescriptor = Object.create(WidgetDescriptor.prototype)
    Object.assign(copy, this)
    copy.limitResources = [...this.limitResources]
    return copy
  }

  get kindScopedKey(): string {
    return `${this.providerKind}.${this.key}`
  }

  get title(): string {
    return this.sample.title
  }

  /**
   * What's left of an open balance: money or credits the user holds, with no limit to measure it
   * against. Limit Resets export as a balance too, but having none is not having run out of anything.
   */
  balance(data: WidgetData): MetricValue | undefined {
    if (this.sample.showsResetExpiries || !data.hasData || data.limit !== undefined) return undefined
    const resource = this.limitResources.find((candidate) => candidate.kind === 'balance')
    return resource ? LimitResourceDescriptor.value(resource, data.values) : undefined
  }

  /** Marks the metric as one the command line exports under `key`. */
  exportingLimit(
    key: string,
    options: { kind?: LimitResourceKind; unit: string; source?: LimitResourceSource }
  ): WidgetDescriptor {
    const copy = this.copy()
    copy.limitResources.push({
      key,
      kind: options.kind ?? 'consumption',
      unit: options.unit,
      source: options.source ?? LimitResourceSource.progress
    })
    return copy
  }

  // Factories (WidgetDescriptor+Factories.swift)

  static percent(options: {
    key: string
    provider: Provider
    title: string
    metricLabel?: string
    sessionStartSignal?: SessionStartSignal
  }): WidgetDescriptor {
    const sample = new WidgetData({
      title: options.title,
      kind: 'percent',
      used: 0,
      limit: 100,
      sessionStartSignal: options.sessionStartSignal
    })
    return new WidgetDescriptor(options.provider, options.key, options.metricLabel ?? options.title, sample)
  }

  static boundedDollars(options: {
    key: string
    provider: Provider
    title: string
    metricLabel?: string
    limit: number
    valueWord?: string
  }): WidgetDescriptor {
    return new WidgetDescriptor(
      options.provider,
      options.key,
      options.metricLabel ?? options.title,
      new WidgetData({ title: options.title, kind: 'dollars', used: 0, limit: options.limit, unboundedValueWord: options.valueWord })
    )
  }

  static boundedCount(options: {
    key: string
    provider: Provider
    title: string
    metricLabel?: string
    limit: number
    periodDurationMs?: number
  }): WidgetDescriptor {
    return new WidgetDescriptor(
      options.provider,
      options.key,
      options.metricLabel ?? options.title,
      new WidgetData({ title: options.title, kind: 'count', used: 0, limit: options.limit, periodDurationMs: options.periodDurationMs })
    )
  }

  static values(options: {
    key: string
    provider: Provider
    title: string
    metricLabel?: string
    valueWord?: string
    showsResetExpiries?: boolean
  }): WidgetDescriptor {
    const sample = new WidgetData({
      title: options.title,
      kind: 'dollars',
      used: 0,
      limit: undefined,
      unboundedValueWord: options.valueWord,
      showsResetExpiries: options.showsResetExpiries ?? false
    })
    return new WidgetDescriptor(options.provider, options.key, options.metricLabel ?? options.title, sample)
  }

  static badge(options: { key: string; provider: Provider; title: string; metricLabel?: string }): WidgetDescriptor {
    return new WidgetDescriptor(
      options.provider,
      options.key,
      options.metricLabel ?? options.title,
      new WidgetData({ title: options.title, kind: 'count', used: 0, limit: undefined })
    )
  }
}
