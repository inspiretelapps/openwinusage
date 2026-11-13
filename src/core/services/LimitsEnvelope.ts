import { LimitResourceDescriptor, type LimitResourceKind } from '../models/LimitResourceDescriptor'
import type { MetricLine } from '../models/MetricLine'
import { Provider } from '../models/Provider'
import { ProviderSnapshot } from '../models/ProviderSnapshot'
import type { WidgetDescriptor } from '../models/WidgetDescriptor'
import type { WidgetRegistry } from '../stores/WidgetRegistry'
import { OpenUsageISO8601 } from '../support/OpenUsageISO8601'
import type { Instant } from '../support/time'

interface WireResource {
  kind: LimitResourceKind
  unit: string
  used?: number
  available?: number
  limit?: number
  remaining?: number
  utilization?: number
  resetsAt?: string
  windowSeconds?: number
  expiresAt?: string[]
}

interface WireProvider {
  displayName: string
  plan?: string
  fetchedAt: string
  expiresAt: string
  stale: boolean
  resources: Record<string, WireResource>
}

function progressUnit(line: MetricLine): string | undefined {
  if (line.type !== 'progress') return undefined
  switch (line.format.type) {
    case 'percent':
      return 'percent'
    case 'dollars':
      return 'usd'
    case 'currency':
      return line.format.code.toLowerCase()
    case 'count': {
      const unit = line.format.suffix.trim()
      return unit.length === 0 ? undefined : unit
    }
  }
}

function wireResource(resource: LimitResourceDescriptor, line: MetricLine): WireResource | undefined {
  const wire: WireResource = { kind: resource.kind, unit: progressUnit(line) ?? resource.unit }
  const source = resource.source.type

  if (line.type === 'progress' && (source === 'progress' || source === 'progressOrValue')) {
    const boundedLimit = Math.max(0, line.limit)
    const boundedUsed = Math.max(0, line.used)
    if (resource.kind === 'consumption') wire.used = boundedUsed
    else wire.available = boundedUsed
    wire.limit = boundedLimit
    wire.remaining = Math.max(0, boundedLimit - boundedUsed)
    if (boundedLimit > 0) wire.utilization = boundedUsed / boundedLimit
    if (line.resetsAt !== undefined) wire.resetsAt = OpenUsageISO8601.string(line.resetsAt)
    if (line.periodDurationMs !== undefined) wire.windowSeconds = line.periodDurationMs / 1000
    return wire
  }

  if (line.type === 'values' && (source === 'value' || source === 'progressOrValue')) {
    const metric = LimitResourceDescriptor.value(resource, line.values)
    if (!metric) return undefined
    wire.unit = metric.currencyCode?.toLowerCase() ?? wire.unit
    if (resource.kind === 'balance') wire.available = metric.number
    else wire.used = metric.number
    const expiries = line.expiriesAt ?? []
    if (expiries.length > 0) wire.expiresAt = [...expiries].sort((a, b) => a - b).map((expiry) => OpenUsageISO8601.string(expiry))
    return wire
  }

  return undefined
}

function wireProvider(provider: Provider, snapshot: ProviderSnapshot, descriptors: WidgetDescriptor[], generatedAt: Instant): WireProvider {
  const resources: Record<string, WireResource> = {}
  for (const descriptor of descriptors) {
    const line = ProviderSnapshot.line(snapshot, descriptor.metricLabel)
    if (!line) continue
    for (const resource of descriptor.limitResources) {
      const value = wireResource(resource, line)
      if (value) resources[resource.key] = value
    }
  }
  const wire: WireProvider = {
    displayName: Provider.fullName(provider),
    fetchedAt: OpenUsageISO8601.string(snapshot.refreshedAt),
    expiresAt: OpenUsageISO8601.string(ProviderSnapshot.staleAt(snapshot)),
    stale: ProviderSnapshot.isStale(snapshot, generatedAt),
    resources
  }
  if (snapshot.plan !== undefined) wire.plan = snapshot.plan
  return wire
}

/** JSON with every object's keys sorted, like `JSONEncoder` with `.sortedKeys`. */
function sortedJSON(value: unknown): string {
  return JSON.stringify(value, (_key, inner: unknown) => {
    if (inner === null || typeof inner !== 'object' || Array.isArray(inner)) return inner
    return Object.fromEntries(Object.entries(inner as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
  })
}

/** The command line's output: every fetched account's limits as one JSON document. */
export const LimitsEnvelope = {
  schema: 'openusage.limits.v2',

  encode(input: { registry: WidgetRegistry; snapshots: Record<string, ProviderSnapshot>; generatedAt?: Instant }): string {
    const generatedAt = input.generatedAt ?? Date.now()
    const providers: Record<string, WireProvider> = {}
    for (const provider of input.registry.providers) {
      const snapshot = input.snapshots[provider.id]
      if (!snapshot) continue
      providers[provider.id] = wireProvider(provider, snapshot, input.registry.descriptors(provider.id), generatedAt)
    }
    try {
      return sortedJSON({ schema: LimitsEnvelope.schema, generatedAt: OpenUsageISO8601.string(generatedAt), providers })
    } catch {
      return `{"providers":{},"schema":"${LimitsEnvelope.schema}"}`
    }
  }
}
