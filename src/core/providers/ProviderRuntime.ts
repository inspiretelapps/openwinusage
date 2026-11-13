import type { MetricLine } from '../models/MetricLine'
import type { Provider } from '../models/Provider'
import type { ProviderSnapshot, RefreshResult } from '../models/ProviderSnapshot'
import type { UsageHistory } from '../models/UsageHistory'
import type { WidgetDescriptor } from '../models/WidgetDescriptor'

/** What reads one account's usage. `AccountProviderRuntime` is the real one; sample data has its own. */
export interface ProviderRuntime {
  readonly provider: Provider
  readonly widgetDescriptors: WidgetDescriptor[]

  refresh(): Promise<RefreshResult>
  forgetHourlyReads(): void
  restore(snapshot: ProviderSnapshot): void
  /** The snapshot with its once-an-hour reads redone, or undefined when the account has none. */
  refreshHourlyReads(snapshot: ProviderSnapshot): Promise<ProviderSnapshot | undefined>
}

/** What a provider's usage read returns, before it becomes a snapshot. */
export interface ProviderUsage {
  plan?: string
  lines: MetricLine[]
  notice?: string
  history?: UsageHistory
  /** Row titles this reading renames, keyed by line label. */
  lineTitles?: Record<string, string>
}

export const ProviderUsage = {
  make(plan: string | undefined, lines: MetricLine[], notice?: string): ProviderUsage {
    const usage: ProviderUsage = { lines }
    if (plan !== undefined) usage.plan = plan
    if (notice !== undefined) usage.notice = notice
    return usage
  }
}
