import { MetricLine, ProgressFormat } from '../../models/MetricLine'
import { metricValue, type MetricValue } from '../../models/MetricValue'
import type { HTTPResponse } from '../../services/HTTPClient'
import { ResetClaimOutcome } from '../../services/ResetClaimService'
import { MetricPeriod } from '../../support/MetricPeriod'
import { OpenUsageISO8601 } from '../../support/OpenUsageISO8601'
import { asArray, asObject, asString, isJSONObject, ProviderParse, titleCased, type JSONObject } from '../../support/ProviderParse'
import { addSeconds, fromUnixSeconds, secondsBetween, type Instant } from '../../support/time'
import { ProviderError } from '../ProviderError'
import { ProviderUsage } from '../ProviderRuntime'

/** OpenAI sells ChatGPT credits at 4¢ each; the usage API reports only the count. */
const creditUSDRate = 0.04

interface WindowSlot {
  window: JSONObject
  usedPercent: number | undefined
}

/**
 * Codex normally returns the five-hour window as `primary_window` and the weekly window as
 * `secondary_window`, but it can move a temporarily sole weekly limit into the primary slot. Each
 * meter takes the window whose explicit duration is its own; failing that, the window in its own slot
 * when that window's duration is absent or unfamiliar. A slot known only from its header percent is a
 * window with no fields. The meter keeps the percentage Codex reported and the window's own period,
 * falling back to the meter's; a chosen window without a percentage shows nothing.
 */
function windowLines(
  rateLimit: JSONObject | undefined,
  labels: { session: string; weekly: string },
  headerPercents: { primary?: number; secondary?: number },
  now: Instant
): MetricLine[] {
  const slots = (
    [
      [rateLimit?.primary_window, headerPercents.primary],
      [rateLimit?.secondary_window, headerPercents.secondary]
    ] as [unknown, number | undefined][]
  ).map(([value, headerPercent]): WindowSlot | undefined => {
    const window = asObject(value) ?? (headerPercent === undefined ? undefined : {})
    if (!window) return undefined
    return { window, usedPercent: ProviderParse.number(window.used_percent) ?? headerPercent }
  })
  const meters = [
    { label: labels.session, periodMs: MetricPeriod.sessionMs },
    { label: labels.weekly, periodMs: MetricPeriod.weekMs }
  ]
  const familiarPeriods = meters.map((meter) => meter.periodMs)
  return meters.flatMap((meter, slot): MetricLine[] => {
    const exact = slots.find((candidate) => candidate !== undefined && readPeriodMs(candidate.window) === meter.periodMs)
    const own = slots[slot]
    const ownPeriodMs = own === undefined ? undefined : readPeriodMs(own.window)
    const fallback = ownPeriodMs !== undefined && familiarPeriods.includes(ownPeriodMs) ? undefined : own
    const candidate = exact ?? fallback
    if (!candidate || candidate.usedPercent === undefined) return []
    const periodMs = readPeriodMs(candidate.window) ?? meter.periodMs
    return [MetricLine.percent(meter.label, candidate.usedPercent, resetDate(candidate.window, now), periodMs)]
  })
}

function sparkLines(body: JSONObject, now: Instant): MetricLine[] {
  const rawEntries = asArray(body.additional_rate_limits)
  if (!rawEntries) return []
  const spark = rawEntries.filter(isJSONObject).find(isSparkEntry)
  const rateLimit = asObject(spark?.rate_limit)
  if (!rateLimit) return []

  return windowLines(rateLimit, { session: 'Spark', weekly: 'Spark Weekly' }, {}, now)
}

function isSparkEntry(entry: JSONObject): boolean {
  return [entry.limit_name, entry.metered_feature].some((value) => typeof value === 'string' && value.toLowerCase().includes('spark'))
}

function resetDate(window: JSONObject | undefined, now: Instant): Instant | undefined {
  if (!window) return undefined
  const resetAt = ProviderParse.number(window.reset_at)
  if (resetAt !== undefined) return fromUnixSeconds(resetAt)
  const resetAfter = ProviderParse.number(window.reset_after_seconds)
  if (resetAfter !== undefined) return addSeconds(now, resetAfter)
  return undefined
}

function readPeriodMs(window: JSONObject | undefined): number | undefined {
  if (!window) return undefined
  const seconds = ProviderParse.number(window.limit_window_seconds)
  if (seconds === undefined) return undefined
  return ProviderParse.int(seconds * 1000)
}

/** `ProviderParse.number` because a JSON `null` is not a count, which a bare undefined-check would accept. */
function availableCount(source: JSONObject): number | undefined {
  const count = ProviderParse.number(source.available_count)
  if (count === undefined || !(count >= 0)) return undefined
  return ProviderParse.int(Math.floor(count))
}

function availableResetCredits(source: JSONObject): { id?: string; expiry?: Instant }[] {
  const credits = asArray(source.credits)
  if (!credits || !credits.every(isJSONObject)) return []
  return credits
    .filter((credit) => {
      const status = asString(credit.status)
      if (status === undefined) return true
      return status === 'available'
    })
    .map((credit) => {
      const entry: { id?: string; expiry?: Instant } = {}
      const id = asString(credit.id)
      if (id !== undefined) entry.id = id
      const expiry = parseExpiry(credit.expires_at)
      if (expiry !== undefined) entry.expiry = expiry
      return entry
    })
}

function sortedExpiries(source: JSONObject): Instant[] {
  return availableResetCredits(source)
    .flatMap((credit) => (credit.expiry === undefined ? [] : [credit.expiry]))
    .sort((a, b) => a - b)
}

function parseExpiry(value: unknown): Instant | undefined {
  if (typeof value === 'string') {
    const date = OpenUsageISO8601.date(value)
    if (date !== undefined) return date
  }
  const seconds = ProviderParse.number(value)
  if (seconds !== undefined) return fromUnixSeconds(seconds)
  return undefined
}

/** The credit limit a workspace sets on the member; ChatGPT sends its numbers as decimal strings. */
function creditLimitLine(body: JSONObject): MetricLine | undefined {
  const limit = asObject(asObject(body.spend_control)?.individual_limit)
  const used = ProviderParse.number(limit?.used)
  const cap = ProviderParse.number(limit?.limit)
  if (!limit || used === undefined || !(used >= 0) || cap === undefined || !(cap >= 0)) return undefined
  const resetAt = ProviderParse.number(limit.reset_at)
  return MetricLine.progress('Credit Limit', used, cap, ProgressFormat.count('credits'), resetAt === undefined ? undefined : fromUnixSeconds(resetAt))
}

function readCreditsRemaining(response: HTTPResponse, body: JSONObject): number | undefined {
  const credits = asObject(body.credits)
  const hasCredits = ProviderParse.bool(credits?.has_credits) ?? ProviderParse.bool(response.header('x-codex-credits-has-credits'))
  if (hasCredits === false) return undefined
  return ProviderParse.number(credits?.balance) ?? ProviderParse.number(response.header('x-codex-credits-balance'))
}

export const CodexUsageMapper = {
  mapUsageResponse(response: HTTPResponse, resetCredits?: HTTPResponse, now: Instant = Date.now()): ProviderUsage {
    const body = ProviderError.requireSuccessJSON(response, 'codex')

    const lines: MetricLine[] = []
    const rateLimit = asObject(body.rate_limit)
    const headerPercents: { primary?: number; secondary?: number } = {}
    const primary = ProviderParse.number(response.header('x-codex-primary-used-percent'))
    const secondary = ProviderParse.number(response.header('x-codex-secondary-used-percent'))
    if (primary !== undefined) headerPercents.primary = primary
    if (secondary !== undefined) headerPercents.secondary = secondary
    lines.push(...windowLines(rateLimit, { session: 'Session', weekly: 'Weekly' }, headerPercents, now))

    lines.push(...sparkLines(body, now))

    const resets = CodexUsageMapper.readResetCredits(body, resetCredits)
    if (resets) {
      lines.push(MetricLine.values('Rate Limit Resets', [metricValue(resets.count, 'count', 'available')], resets.expiries))
    }

    const remaining = readCreditsRemaining(response, body)
    if (remaining !== undefined && ProviderParse.int(remaining) !== undefined) {
      lines.push(MetricLine.values('Credits', CodexUsageMapper.creditValues(remaining)))
    }

    const creditLimit = creditLimitLine(body)
    if (creditLimit) {
      lines.push(creditLimit)
    }

    return ProviderUsage.make(CodexUsageMapper.formatCodexPlan(body.plan_type), lines)
  },

  creditValues(remaining: number): MetricValue[] {
    const credits = Math.max(0, Math.floor(remaining))
    return [metricValue(credits * creditUSDRate, 'dollars'), metricValue(credits, 'count', 'credits')]
  },

  /**
   * The count comes from the usage body of this pass; the dedicated list, read hourly, supplies the
   * count only when the usage body has none, and its expiry times only while it agrees with the count,
   * so an hour-old list never stands in for a reset spent or granted since.
   */
  readResetCredits(body: JSONObject, resetCredits: HTTPResponse | undefined): { count: number; expiries: Instant[] } | undefined {
    const embedded = asObject(body.rate_limit_reset_credits)
    let dedicated: JSONObject | undefined
    if (resetCredits) {
      const list = ProviderParse.jsonObject(resetCredits.body)
      if (list && availableCount(list) !== undefined) dedicated = list
    }
    const count = (embedded === undefined ? undefined : availableCount(embedded)) ?? (dedicated === undefined ? undefined : availableCount(dedicated))
    if (count === undefined) return undefined
    if (!(count > 0)) return { count: 0, expiries: [] }
    if (dedicated && availableCount(dedicated) === count) {
      return { count, expiries: sortedExpiries(dedicated) }
    }
    return { count, expiries: embedded === undefined ? [] : sortedExpiries(embedded) }
  },

  resetCreditID(body: JSONObject, expiry: Instant): string | undefined {
    return availableResetCredits(body).find((credit) => credit.expiry !== undefined && Math.abs(secondsBetween(credit.expiry, expiry)) < 1)?.id
  },

  /**
   * Collapses a consume response to the popover's outcome. Every protocol code arrives as HTTP 200 with
   * the outcome in the body's `code`; `already_redeemed` is the idempotency key absorbing a retry of a
   * claim that already landed, so it counts as success.
   */
  resetClaimOutcome(response: HTTPResponse): ResetClaimOutcome {
    if (ProviderError.isAuthFailure(response)) return ResetClaimOutcome.failed('signInExpired')
    const body = response.statusCode >= 200 && response.statusCode < 300 ? ProviderParse.jsonObject(response.body) : undefined
    const code = asString(body?.code)
    if (!body || code === undefined) {
      return ResetClaimOutcome.failed('refused')
    }
    switch (code) {
      case 'reset':
      case 'already_redeemed':
        return ResetClaimOutcome.success
      case 'nothing_to_reset':
        return ResetClaimOutcome.nothingToReset
      case 'no_credit':
        return ResetClaimOutcome.noCredit
      default:
        return ResetClaimOutcome.failed('refused')
    }
  },

  formatCodexPlan(value: unknown): string | undefined {
    const raw = asString(value)?.trim()
    if (raw === undefined || raw.length === 0) {
      return undefined
    }
    switch (raw.toLowerCase()) {
      case 'prolite':
        return 'Pro 100'
      case 'pro':
        return 'Pro 200'
      case 'promax':
        return 'Pro 500'
      case 'self_serve_business_prolite':
        return 'Business Premium'
      default:
        return titleCased(raw, (char) => char === '_')
    }
  }
}
