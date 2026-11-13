import { MetricLine, ProgressFormat } from '../../models/MetricLine'
import { metricValue } from '../../models/MetricValue'
import { OpenUsageISO8601 } from '../../support/OpenUsageISO8601'
import { asObject, asString, ProviderParse, type JSONObject } from '../../support/ProviderParse'
import type { Instant } from '../../support/time'
import { ProviderError } from '../ProviderError'
import type { ProviderUsage } from '../ProviderRuntime'
import { asBool } from './CursorUsageEvents'
import { CursorUsageMapper } from './CursorUsageMapper'

interface BillingCycle {
  resetsAt?: Instant
  periodDurationMs: number
}

interface DollarMeter {
  used: number
  limit: number
}

function isoDate(value: unknown): Instant | undefined {
  const text = asString(value)
  return text === undefined ? undefined : OpenUsageISO8601.date(text)
}

function appendRequests(usage: JSONObject | undefined, cycle: BillingCycle, lines: MetricLine[]): boolean {
  const requests = asObject(usage?.['gpt-4'])
  const limit = requests ? ProviderParse.number(requests.maxRequestUsage) : undefined
  if (!requests || limit === undefined || !(limit > 0)) {
    return false
  }
  const used = Math.max(0, ProviderParse.number(requests.numRequests) ?? ProviderParse.number(requests.numRequestsTotal) ?? 0)
  for (const label of ['Total usage', 'Requests']) {
    lines.push(MetricLine.progress(label, used, limit, ProgressFormat.count('requests'), cycle.resetsAt, cycle.periodDurationMs))
  }
  return true
}

function appendSummaryTotal(summary: JSONObject | undefined, cycle: BillingCycle, lines: MetricLine[]): void {
  const individual = asObject(summary?.individualUsage)
  const team = asObject(summary?.teamUsage)
  const limitType = asString(summary?.limitType)?.toLowerCase()

  if (limitType === 'team') {
    const pooled = dollarMeter(team?.pooled)
    if (pooled) {
      appendDollarProgress(pooled, 'Total usage', cycle, lines)
      return
    }
  }
  const percent = ProviderParse.number(asObject(individual?.plan)?.totalPercentUsed)
  if (percent !== undefined) {
    lines.push(MetricLine.percent('Total usage', percent, cycle.resetsAt, cycle.periodDurationMs))
    return
  }
  const overall = dollarMeter(individual?.overall)
  if (overall) {
    appendDollarProgress(overall, 'Total usage', cycle, lines)
    return
  }
  const pooled = dollarMeter(team?.pooled)
  if (pooled) {
    appendDollarProgress(pooled, 'Total usage', cycle, lines)
  }
}

function appendStructuredPercentages(summary: JSONObject | undefined, cycle: BillingCycle, lines: MetricLine[]): void {
  const plan = asObject(asObject(summary?.individualUsage)?.plan)
  for (const [key, label] of [
    ['autoPercentUsed', 'Cursor Models'],
    ['apiPercentUsed', 'Other Models']
  ]) {
    const percent = ProviderParse.number(plan?.[key])
    if (percent === undefined) continue
    lines.push(MetricLine.percent(label, percent, cycle.resetsAt, cycle.periodDurationMs))
  }
}

function appendOnDemand(summary: JSONObject | undefined, cycle: BillingCycle, lines: MetricLine[]): void {
  const individual = asObject(summary?.individualUsage)
  const team = asObject(summary?.teamUsage)
  if (appendOnDemandBucket(individual?.onDemand, cycle, lines)) {
    return
  }
  appendOnDemandBucket(team?.onDemand, cycle, lines)
}

/**
 * Returns whether a usable row was emitted. An Enterprise response can include an individual
 * placeholder bucket (`enabled: false` or a zero limit) alongside a valid team bucket, so merely
 * finding the individual dictionary must not suppress the fallback.
 */
function appendOnDemandBucket(value: unknown, cycle: BillingCycle, lines: MetricLine[]): boolean {
  const bucket = asObject(value)
  if (!bucket || asBool(bucket.enabled) === false) {
    return false
  }
  const meter = dollarMeter(bucket)
  if (meter) {
    appendDollarProgress(meter, 'On-demand', cycle, lines)
    return true
  }
  const usedCents = ProviderParse.number(bucket.used)
  if (usedCents !== undefined && usedCents > 0) {
    lines.push(MetricLine.values('On-demand', [metricValue(ProviderParse.centsToDollars(usedCents), 'dollars')]))
    return true
  }
  return false
}

function dollarMeter(value: unknown): DollarMeter | undefined {
  const bucket = asObject(value)
  if (!bucket || asBool(bucket.enabled) === false) return undefined
  const limit = ProviderParse.number(bucket.limit)
  if (limit === undefined || !(limit > 0)) {
    return undefined
  }
  const reportedUsed = ProviderParse.number(bucket.used)
  const inferredUsed = Math.max(0, limit - (ProviderParse.number(bucket.remaining) ?? limit))
  const used = (reportedUsed !== undefined && reportedUsed > 0 ? reportedUsed : undefined) ?? inferredUsed
  return { used: Math.max(0, used), limit }
}

function usableDollarBucket(value: unknown): boolean {
  const bucket = asObject(value)
  if (!bucket || asBool(bucket.enabled) === false) {
    return false
  }
  return dollarMeter(bucket) !== undefined || (ProviderParse.number(bucket.used) ?? 0) > 0
}

function appendDollarProgress(meter: DollarMeter, label: string, cycle: BillingCycle, lines: MetricLine[]): void {
  lines.push(
    MetricLine.progress(
      label,
      ProviderParse.centsToDollars(meter.used),
      ProviderParse.centsToDollars(meter.limit),
      ProgressFormat.dollars,
      cycle.resetsAt,
      cycle.periodDurationMs
    )
  )
}

function billingCycle(summary: JSONObject | undefined, requestUsage: JSONObject | undefined): BillingCycle {
  const start = isoDate(summary?.billingCycleStart)
  const end = isoDate(summary?.billingCycleEnd)
  if (start !== undefined && end !== undefined && end > start) {
    return { resetsAt: end, periodDurationMs: Math.trunc(end - start) }
  }

  const requestStart = isoDate(requestUsage?.startOfMonth)
  const cycle: BillingCycle = { periodDurationMs: CursorUsageMapper.billingPeriodMs }
  if (requestStart !== undefined) cycle.resetsAt = requestStart + CursorUsageMapper.billingPeriodMs
  return cycle
}

export const CursorUsageSummaryMapper = {
  hasUsableSummaryPayload(summary: JSONObject): boolean {
    const start = isoDate(summary.billingCycleStart)
    const end = isoDate(summary.billingCycleEnd)
    if (start !== undefined && end !== undefined && end > start) {
      return true
    }

    const individual = asObject(summary.individualUsage)
    const team = asObject(summary.teamUsage)
    const plan = asObject(individual?.plan)
    if (['totalPercentUsed', 'autoPercentUsed', 'apiPercentUsed'].some((key) => ProviderParse.number(plan?.[key]) !== undefined)) {
      return true
    }
    return [individual?.onDemand, individual?.overall, team?.onDemand, team?.pooled].some(usableDollarBucket)
  },

  map(
    summary: JSONObject | undefined,
    requestUsage: JSONObject | undefined,
    planName: string | undefined,
    unavailableMessage: string
  ): ProviderUsage {
    const cycle = billingCycle(summary, requestUsage)
    const lines: MetricLine[] = []

    const hasRequests = appendRequests(requestUsage, cycle, lines)
    if (!hasRequests) {
      appendSummaryTotal(summary, cycle, lines)
    }
    appendStructuredPercentages(summary, cycle, lines)
    appendOnDemand(summary, cycle, lines)

    if (lines.length === 0) {
      throw ProviderError.unavailable(unavailableMessage)
    }

    const mapped: ProviderUsage = { lines }
    const plan = CursorUsageMapper.resolvedPlanLabel(planName, asString(summary?.membershipType))
    if (plan !== undefined) mapped.plan = plan
    return mapped
  },

  appendMissingOnDemand(summary: JSONObject, lines: MetricLine[]): void {
    if (lines.some((line) => line.label === 'On-demand')) return
    appendOnDemand(summary, billingCycle(summary, undefined), lines)
  }
}
