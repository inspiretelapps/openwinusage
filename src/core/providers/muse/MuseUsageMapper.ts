import { MetricLine } from '../../models/MetricLine'
import { MetricPeriod } from '../../support/MetricPeriod'
import type { Instant } from '../../support/time'
import { ProviderError } from '../ProviderError'
import { ProviderUsage } from '../ProviderRuntime'
import type { MuseAccount, MuseAccountWindow } from './MuseUsageClient'

function aged(line: MetricLine, now: Instant): MetricLine {
  if (line.type !== 'progress' || line.resetsAt === undefined || !(line.resetsAt <= now)) return line
  return MetricLine.percent(line.label, 0, undefined, line.periodDurationMs)
}

export const MuseUsageMapper = {
  /**
   * Muse leaves out `subs_usage` until the plan's first use and while the 5-hour window is idle, even when
   * the week has usage, so the card keeps its last known values then. A kept window whose reset has passed,
   * and a window Muse has never reported, read 0%.
   */
  map(account: MuseAccount, lastKnown: MetricLine[], now: Instant): ProviderUsage {
    if (!account.isSubscribed) {
      throw ProviderError.unavailable('No Muse Code subscription on this account.')
    }
    const windows: [string, MuseAccountWindow | undefined, number][] = [
      ['Session', account.usage?.window, MetricPeriod.sessionMs],
      ['Weekly', account.usage?.weekly, MetricPeriod.weekMs]
    ]
    const lines = windows.map(([label, window, periodMs]) => {
      if (window) {
        return MetricLine.percent(label, window.usedPercent, window.resetsAt, periodMs)
      }
      if (account.usage === undefined) {
        const kept = lastKnown.find((line) => line.label === label)
        if (kept) return aged(kept, now)
      }
      return MetricLine.percent(label, 0, undefined, periodMs)
    })
    return ProviderUsage.make(account.plan, lines)
  }
}
