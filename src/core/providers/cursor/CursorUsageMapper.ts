import { MetricLine, ProgressFormat } from '../../models/MetricLine'
import { metricValue } from '../../models/MetricValue'
import { MetricPeriod } from '../../support/MetricPeriod'
import { OpenUsageISO8601 } from '../../support/OpenUsageISO8601'
import { asObject, asString, nilIfEmpty, ProviderParse, titleCased, type JSONObject } from '../../support/ProviderParse'
import type { Instant } from '../../support/time'
import { ProviderError } from '../ProviderError'
import type { ProviderUsage } from '../ProviderRuntime'
import { asBool } from './CursorUsageEvents'

const isWhitespace = (char: string): boolean => /\s/u.test(char)

export class CursorPlanUsageFacts {
  readonly isEnabled: boolean
  readonly hasPlanUsage: boolean
  readonly limit: number | undefined
  readonly totalPercentUsed: number | undefined
  readonly hasModelPools: boolean
  readonly spendLimitType: string | undefined
  readonly pooledLimit: number

  constructor(usage: JSONObject) {
    this.isEnabled = asBool(usage.enabled) !== false
    const planUsage = asObject(usage.planUsage)
    this.hasPlanUsage = planUsage !== undefined
    this.limit = planUsage ? ProviderParse.number(planUsage.limit) : undefined
    this.totalPercentUsed = planUsage ? ProviderParse.number(planUsage.totalPercentUsed) : undefined
    const auto = planUsage ? ProviderParse.number(planUsage.autoPercentUsed) : undefined
    const api = planUsage ? ProviderParse.number(planUsage.apiPercentUsed) : undefined
    const spent =
      (planUsage ? ProviderParse.number(planUsage.totalSpend) : undefined) ??
      (this.limit ?? 0) - ((planUsage ? ProviderParse.number(planUsage.remaining) : undefined) ?? this.limit ?? 0)
    if (auto !== undefined && api !== undefined && Number.isFinite(auto) && Number.isFinite(api) && auto >= 0 && api >= 0) {
      this.hasModelPools = auto > 0 || api > 0 || spent === 0
    } else {
      this.hasModelPools = false
    }
    const spendLimitUsage = asObject(usage.spendLimitUsage)
    this.spendLimitType = asString(spendLimitUsage?.limitType)?.toLowerCase()
    this.pooledLimit = ProviderParse.number(spendLimitUsage?.pooledLimit) ?? 0
  }

  get hasLimit(): boolean {
    return this.limit !== undefined
  }
  get hasTotalUsagePercent(): boolean {
    return this.totalPercentUsed !== undefined
  }
  get planUsageLimitMissing(): boolean {
    return this.hasPlanUsage && !this.hasLimit
  }
  get planUsageUnusable(): boolean {
    return !this.hasPlanUsage || (this.planUsageLimitMissing && !this.hasModelPools)
  }
  get isTeamByShape(): boolean {
    return this.spendLimitType === 'team' || this.pooledLimit > 0
  }
  get shouldTryGenericRequestFallback(): boolean {
    return this.isEnabled && this.hasPlanUsage && !this.hasLimit && !this.hasTotalUsagePercent && !this.hasModelPools
  }
}

const billingPeriodMs = MetricPeriod.monthMs

const orgMembershipTypes: ReadonlySet<string> = new Set(['enterprise', 'team'])

function isoDate(value: unknown): Instant | undefined {
  const text = asString(value)
  return text === undefined ? undefined : OpenUsageISO8601.date(text)
}

function onDemandSpendCents(spendLimitUsage: JSONObject, limit: number, remaining: number): number {
  const reported = [
    ProviderParse.number(spendLimitUsage.individualUsed),
    ProviderParse.number(spendLimitUsage.pooledUsed),
    ProviderParse.number(spendLimitUsage.totalSpend)
  ].filter((value): value is number => value !== undefined)
  const positive = reported.find((value) => value > 0)
  if (positive !== undefined) {
    return positive
  }
  const inferred = Math.max(0, limit - remaining)
  return inferred > 0 ? inferred : (reported[0] ?? 0)
}

function appendCredits(creditGrants: JSONObject | undefined, stripeBalanceCents: number, lines: MetricLine[]): void {
  const hasCreditGrants = asBool(creditGrants?.hasCreditGrants) === true
  const grantTotalCents = hasCreditGrants ? (ProviderParse.number(creditGrants?.totalCents) ?? 0) : 0
  const grantUsedCents = hasCreditGrants ? (ProviderParse.number(creditGrants?.usedCents) ?? 0) : 0
  const hasValidGrantData = hasCreditGrants && grantTotalCents > 0
  const combinedTotalCents = (hasValidGrantData ? grantTotalCents : 0) + stripeBalanceCents
  const remainingCents = Math.max(0, combinedTotalCents - (hasValidGrantData ? grantUsedCents : 0))

  if (!(creditGrants !== undefined || combinedTotalCents > 0)) return
  lines.push(MetricLine.values('Credits', [metricValue(ProviderParse.centsToDollars(remainingCents), 'dollars')]))
}

function billingCycle(usage: JSONObject): { resetsAt?: Instant; periodDurationMs: number } {
  const cycleStart = ProviderParse.number(usage.billingCycleStart)
  const cycleEnd = ProviderParse.number(usage.billingCycleEnd)
  const periodMs = cycleStart !== undefined && cycleEnd !== undefined && cycleEnd > cycleStart ? ProviderParse.int(cycleEnd - cycleStart) : undefined
  if (cycleStart === undefined || cycleEnd === undefined || !(cycleEnd > cycleStart) || periodMs === undefined) {
    return cycleEnd === undefined ? { periodDurationMs: billingPeriodMs } : { resetsAt: cycleEnd, periodDurationMs: billingPeriodMs }
  }
  return { resetsAt: cycleEnd, periodDurationMs: periodMs }
}

function normalizedMembership(value: string | undefined): string | undefined {
  return nilIfEmpty(value?.trim().toLowerCase())
}

function planLabel(value: string | undefined): string | undefined {
  if (value === undefined) return undefined
  const trimmed = value.trim()
  if (trimmed.length === 0) return undefined
  return titleCased(trimmed, isWhitespace)
}

export const CursorUsageMapper = {
  billingPeriodMs,

  /**
   * Grok Bot is Cursor's "Sand" product, with its own weekly allowance and reset window. Pooled
   * enterprise accounts and accounts without an included allowance have no separate personal meter.
   */
  mapGrokBotUsage(usage: JSONObject): MetricLine | undefined {
    const percent = ProviderParse.number(usage.usagePercent)
    if (
      asBool(usage.usesPooledEnterpriseAllowance) === true ||
      asBool(usage.hasNonZeroIncludedLimit) === false ||
      asBool(usage.includedLimitZero) === true ||
      percent === undefined ||
      !(percent >= 0)
    ) {
      return undefined
    }

    const reset = isoDate(usage.nextResetTimestampUtc)
    const start = isoDate(usage.currentPeriodStart)
    let periodDurationMs: number
    if (start !== undefined && reset !== undefined && reset > start) {
      periodDurationMs = Math.trunc(reset - start)
    } else {
      periodDurationMs = MetricPeriod.weekMs
    }

    return MetricLine.percent('Grok Bot usage', ProviderParse.clampPercent(percent), reset, periodDurationMs)
  },

  mapUsage(usage: JSONObject, planName: string | undefined, creditGrants: JSONObject | undefined, stripeBalanceCents: number): ProviderUsage {
    const facts = new CursorPlanUsageFacts(usage)
    const planUsage = asObject(usage.planUsage)
    if (!facts.isEnabled || !planUsage) {
      throw ProviderError.unavailable('No active Cursor subscription.')
    }

    const normalizedPlan = planName?.trim().toLowerCase() ?? ''

    if (!(facts.hasLimit || facts.hasTotalUsagePercent || facts.hasModelPools)) {
      throw ProviderError.unavailable('Total usage limit missing from API response.')
    }

    const lines: MetricLine[] = []
    const lineTitles: Record<string, string> = {}
    appendCredits(creditGrants, stripeBalanceCents, lines)

    const planUsedCents = ProviderParse.number(planUsage.totalSpend) ?? (facts.limit ?? 0) - (ProviderParse.number(planUsage.remaining) ?? 0)
    const computedPercentUsed = (facts.limit !== undefined && facts.limit > 0 ? (planUsedCents / facts.limit) * 100 : undefined) ?? 0
    const totalUsagePercent = facts.totalPercentUsed ?? computedPercentUsed

    const cycle = billingCycle(usage)
    const spendLimitUsage = asObject(usage.spendLimitUsage)
    const isTeamAccount = normalizedPlan === 'team' || facts.isTeamByShape

    if (isTeamAccount && facts.hasModelPools) {
      // Modern Teams seats still report the old $20 allowance. Structured pool data wins;
      // never synthesize a total from stale dollars when Cursor omits totalPercentUsed.
      if (facts.totalPercentUsed !== undefined) {
        lines.push(MetricLine.percent('Total usage', facts.totalPercentUsed, cycle.resetsAt, cycle.periodDurationMs))
      }
    } else if (isTeamAccount) {
      if (facts.limit !== undefined) {
        lines.push(
          MetricLine.progress(
            'Total usage',
            ProviderParse.centsToDollars(planUsedCents),
            ProviderParse.centsToDollars(facts.limit),
            ProgressFormat.dollars,
            cycle.resetsAt,
            cycle.periodDurationMs
          )
        )
      } else if (facts.totalPercentUsed !== undefined) {
        lines.push(MetricLine.percent('Total usage', facts.totalPercentUsed, cycle.resetsAt, cycle.periodDurationMs))
      } else {
        throw ProviderError.unavailable('Cursor request-based usage data unavailable. Try again later.')
      }
    } else {
      lines.push(MetricLine.percent('Total usage', totalUsagePercent, cycle.resetsAt, cycle.periodDurationMs))
    }

    const autoPercentUsed = ProviderParse.number(planUsage.autoPercentUsed)
    if (autoPercentUsed !== undefined) {
      lines.push(MetricLine.percent('Cursor Models', autoPercentUsed, cycle.resetsAt, cycle.periodDurationMs))
    }

    const apiPercentUsed = ProviderParse.number(planUsage.apiPercentUsed)
    if (apiPercentUsed !== undefined) {
      lines.push(MetricLine.percent('Other Models', apiPercentUsed, cycle.resetsAt, cycle.periodDurationMs))
    }

    if (spendLimitUsage) {
      const individualLimit = ProviderParse.number(spendLimitUsage.individualLimit)
      const limit = individualLimit ?? ProviderParse.number(spendLimitUsage.pooledLimit) ?? 0
      const remaining = ProviderParse.number(spendLimitUsage.individualRemaining) ?? ProviderParse.number(spendLimitUsage.pooledRemaining) ?? 0
      const spent = onDemandSpendCents(spendLimitUsage, limit, remaining)
      if (limit > 0) {
        lines.push(
          MetricLine.progress(
            'On-demand',
            ProviderParse.centsToDollars(spent),
            ProviderParse.centsToDollars(limit),
            ProgressFormat.dollars,
            cycle.resetsAt,
            cycle.periodDurationMs
          )
        )
      } else if (spent > 0) {
        lines.push(MetricLine.values('On-demand', [metricValue(ProviderParse.centsToDollars(spent), 'dollars')]))
      }
      if (individualLimit === undefined && facts.isTeamByShape && (limit > 0 || spent > 0)) {
        lineTitles['On-demand'] = 'Team Spend'
      }
    }

    const mapped: ProviderUsage = { lines, lineTitles }
    const plan = planLabel(planName)
    if (plan !== undefined) mapped.plan = plan
    return mapped
  },

  shouldUseRequestBasedFallback(facts: CursorPlanUsageFacts, planName: string | undefined): { shouldFallback: boolean; message: string } {
    if (!facts.isEnabled) {
      return { shouldFallback: false, message: '' }
    }

    const normalizedPlan = planName?.trim().toLowerCase() ?? ''

    if (facts.planUsageUnusable && !facts.hasTotalUsagePercent && normalizedPlan === 'enterprise') {
      return { shouldFallback: true, message: 'Enterprise usage data unavailable. Try again later.' }
    }
    if (facts.planUsageUnusable && !facts.hasTotalUsagePercent && normalizedPlan === 'team') {
      return { shouldFallback: true, message: 'Team request-based usage data unavailable. Try again later.' }
    }
    if (facts.planUsageUnusable && !facts.hasTotalUsagePercent && normalizedPlan.length === 0 && planName === undefined) {
      return { shouldFallback: true, message: 'Cursor request-based usage data unavailable. Try again later.' }
    }

    if (facts.isTeamByShape && facts.planUsageLimitMissing && !facts.hasModelPools) {
      return { shouldFallback: true, message: 'Cursor request-based usage data unavailable. Try again later.' }
    }

    return { shouldFallback: false, message: '' }
  },

  stripeBalanceCents(body: JSONObject | undefined): number {
    if (!body) return 0
    const balance = ProviderParse.number(body.customerBalance)
    if (balance === undefined || !(balance < 0)) {
      return 0
    }
    return Math.abs(balance)
  },

  orgMembershipTypes,

  membershipType(summary: JSONObject | undefined): string | undefined {
    return normalizedMembership(asString(summary?.membershipType))
  },

  /** Badge / display plan. Prefer org billing membership over GetPlanInfo when it still says Pro. */
  resolvedPlanName(planInfoName: string | undefined, membershipType: string | undefined): string | undefined {
    const membership = normalizedMembership(membershipType)
    const planInfo = nilIfEmpty(planInfoName?.trim())
    if (
      membership !== undefined &&
      orgMembershipTypes.has(membership) &&
      (planInfo === undefined || ['pro', 'pro plan'].includes(planInfo.toLowerCase()))
    ) {
      return membership
    }
    return planInfo ?? membership
  },

  resolvedPlanLabel(planInfoName: string | undefined, membershipType: string | undefined): string | undefined {
    return planLabel(CursorUsageMapper.resolvedPlanName(planInfoName, membershipType))
  }
}
