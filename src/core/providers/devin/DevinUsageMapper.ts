import { MetricLine } from '../../models/MetricLine'
import { metricValue } from '../../models/MetricValue'
import { MetricPeriod } from '../../support/MetricPeriod'
import { asObject, asString, nilIfEmpty, ProviderParse, type JSONObject } from '../../support/ProviderParse'
import { fromUnixSeconds, type Instant } from '../../support/time'
import { ProviderError } from '../ProviderError'
import { ProviderUsage } from '../ProviderRuntime'

interface Quota {
  remaining: number
  resetsAt?: Instant
}

/**
 * Devin reports the share of a quota left. Proto3 JSON omits a zero, so a window with a reset and
 * no share has none left. A share present but unreadable is a changed schema, not an empty quota.
 */
function quota(planStatus: JSONObject, key: string, resetKey: string): Quota | undefined {
  const reset = ProviderParse.number(planStatus[resetKey])
  const resetsAt = reset === undefined ? undefined : fromUnixSeconds(reset)
  const value = planStatus[key]
  if (value === undefined) return resetsAt === undefined ? undefined : { remaining: 0, resetsAt }
  const remaining = ProviderParse.number(value)
  if (remaining === undefined) throw ProviderError.invalidResponse
  return resetsAt === undefined ? { remaining } : { remaining, resetsAt }
}

function quotaLine(label: string, quota: Quota, periodMs: number): MetricLine {
  return MetricLine.percent(label, ProviderParse.clampPercent(100 - quota.remaining), quota.resetsAt, periodMs)
}

export const DevinUsageMapper = {
  map(body: Uint8Array | string): ProviderUsage {
    const userStatus = asObject(ProviderParse.jsonObject(body)?.userStatus)
    if (!userStatus) throw ProviderError.invalidResponse
    const planStatus = asObject(userStatus.planStatus) ?? {}
    const planInfo = asObject(planStatus.planInfo) ?? {}
    const daily = quota(planStatus, 'dailyQuotaRemainingPercent', 'dailyQuotaResetAtUnix')
    const weekly = quota(planStatus, 'weeklyQuotaRemainingPercent', 'weeklyQuotaResetAtUnix')

    const lines: MetricLine[] = []
    if (ProviderParse.bool(planInfo.hideDailyQuota) === true) {
      // A plan that hides its daily quota still meters it. With no weekly window, the Weekly row
      // carries it.
      const shown: Quota | undefined = weekly ?? (daily === undefined ? undefined : { remaining: daily.remaining })
      if (shown) lines.push(quotaLine('Weekly quota', shown, MetricPeriod.weekMs))
    } else {
      if (daily) lines.push(quotaLine('Daily quota', daily, MetricPeriod.dayMs))
      if (weekly) lines.push(quotaLine('Weekly quota', weekly, MetricPeriod.weekMs))
    }
    const micros = ProviderParse.number(planStatus.overageBalanceMicros)
    if (micros !== undefined) {
      lines.push(MetricLine.values('Extra usage balance', [metricValue(Math.max(0, micros) / 1_000_000, 'dollars')]))
    }
    if (lines.length === 0) {
      throw ProviderError.unavailable('Devin reports no quota for this account.')
    }
    const plan = nilIfEmpty(asString(planInfo.planName)?.trim())
    return ProviderUsage.make(plan, lines)
  }
}
