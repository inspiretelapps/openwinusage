import { RefreshSetting } from '../stores/RefreshSetting'
import { addSeconds, type Instant, type Seconds } from '../support/time'
import { describeError } from '../support/AppLog'
import { Provider } from './Provider'
import type { MetricLine } from './MetricLine'
import type { UsageBreakdown } from './UsageHistory'

/** One account's last reading. Plain data: it is saved to disk and sent to the panel as it is. */
export interface ProviderSnapshot {
  readonly providerID: string
  readonly displayName: string
  plan?: string
  lines: MetricLine[]
  /** Range details read with these lines, keyed by descriptor key. Older snapshots carry only lines. */
  usageBreakdowns?: Record<string, UsageBreakdown>
  /** Row titles this reading renames, keyed by line label. Older snapshots carry none. */
  lineTitles?: Record<string, string>
  notice?: string
  refreshedAt: Instant
}

export const ProviderSnapshot = {
  make(fields: {
    providerID: string
    displayName: string
    plan?: string
    lines: MetricLine[]
    notice?: string
    refreshedAt?: Instant
  }): ProviderSnapshot {
    const snapshot: ProviderSnapshot = {
      providerID: fields.providerID,
      displayName: fields.displayName,
      lines: fields.lines,
      refreshedAt: fields.refreshedAt ?? Date.now()
    }
    if (fields.plan !== undefined) snapshot.plan = fields.plan
    if (fields.notice !== undefined) snapshot.notice = fields.notice
    return snapshot
  },

  forProvider(provider: Provider, plan: string | undefined, lines: MetricLine[], notice?: string, refreshedAt: Instant = Date.now()): ProviderSnapshot {
    return ProviderSnapshot.make({ providerID: provider.id, displayName: Provider.displayName(provider), plan, lines, notice, refreshedAt })
  },

  line(snapshot: ProviderSnapshot, label: string): MetricLine | undefined {
    return snapshot.lines.find((line) => line.label === label)
  },

  staleAt(snapshot: ProviderSnapshot): Instant {
    return addSeconds(snapshot.refreshedAt, RefreshSetting.stalenessThreshold)
  },

  isStale(snapshot: ProviderSnapshot, at: Instant): boolean {
    return at >= ProviderSnapshot.staleAt(snapshot)
  }
}

export type RefreshFailureKind =
  | { type: 'rateLimited'; retryAfter?: Seconds }
  | { type: 'unreachable' }
  | { type: 'refused' }

export interface RefreshFailure {
  message: string
  kind: RefreshFailureKind
}

/**
 * Errors that mean the request never reached the provider (no internet, DNS failure, a timeout): the
 * port of `is URLError`. An HTTP client throws these for transport failures.
 */
export class NetworkError extends Error {
  constructor(message = 'Connection failed. Check your internet connection and try again.', options?: ErrorOptions) {
    super(message, options)
    this.name = 'NetworkError'
  }
}

/** The outcome of one refresh: Swift's `Result<ProviderSnapshot, RefreshFailure>`. */
export type RefreshResult = { ok: true; snapshot: ProviderSnapshot } | { ok: false; failure: RefreshFailure }

/** How an error is classified into a failure kind. `ProviderError` registers its own cases here. */
type FailureClassifier = (error: unknown) => RefreshFailureKind | undefined
const classifiers: FailureClassifier[] = []

export const RefreshFailure = {
  registerClassifier(classifier: FailureClassifier): void {
    classifiers.push(classifier)
  },

  fromError(error: unknown): RefreshFailure {
    let kind: RefreshFailureKind | undefined
    for (const classify of classifiers) {
      kind = classify(error)
      if (kind) break
    }
    if (!kind) kind = error instanceof NetworkError ? { type: 'unreachable' } : { type: 'refused' }
    return { message: describeError(error), kind }
  }
}
