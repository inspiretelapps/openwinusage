import { MetricLine, ProgressFormat } from '../../models/MetricLine'
import { metricValue } from '../../models/MetricValue'
import type { HTTPResponse } from '../../services/HTTPClient'
import { ResetClaimOutcome } from '../../services/ResetClaimService'
import { MetricPeriod } from '../../support/MetricPeriod'
import { OpenUsageISO8601 } from '../../support/OpenUsageISO8601'
import { asArray, asObject, asString, ProviderParse, titleCased } from '../../support/ProviderParse'
import { rounded } from '../../support/numbers'
import type { Instant } from '../../support/time'
import { ProviderError } from '../ProviderError'
import { ClaudeResetGrantStatus } from './ClaudeResetGrantStatus'
import type { ClaudeAccountProfile } from './ClaudeUsageClient'

function appendUsageWindow(value: unknown, label: string, periodDurationMs: number, lines: MetricLine[]): void {
  const object = asObject(value)
  const used = ProviderParse.number(object?.utilization)
  if (!object || used === undefined) return
  lines.push(MetricLine.percent(label, used, ClaudeUsageMapper.resetDate(object.resets_at), periodDurationMs))
}

/**
 * A model-scoped weekly limit from the `limits` array — `kind: "weekly_scoped"` with
 * `scope.model.display_name` naming the model (e.g. "Fable"). Anthropic moved the per-model
 * weekly windows off the legacy top-level `seven_day_<model>` keys (which now come back null)
 * and into this array, so each scoped row is read by display name. `percent` is 0–100.
 */
function appendScopedWeeklyLimit(limits: unknown, modelName: string, label: string, lines: MetricLine[]): void {
  const array = asArray(limits)
  if (!array) return
  for (const entry of array) {
    const object = asObject(entry)
    if (!object || object.kind !== 'weekly_scoped') continue
    const model = asObject(asObject(object.scope)?.model)
    const used = ProviderParse.number(object.percent)
    if (!model || model.display_name !== modelName || used === undefined) continue
    lines.push(MetricLine.percent(label, used, ClaudeUsageMapper.resetDate(object.resets_at), MetricPeriod.weekMs))
    return
  }
}

function appendExtraUsage(value: unknown, lines: MetricLine[]): void {
  const object = asObject(value)
  if (!object || object.is_enabled !== true) return

  const currency = asString(object.currency) ?? 'USD'
  const minorUnits = Math.pow(10, ProviderParse.number(object.decimal_places) ?? 2)
  const used = rounded(ProviderParse.number(object.used_credits) ?? 0) / minorUnits
  const limitMinor = ProviderParse.number(object.monthly_limit)
  if (limitMinor !== undefined && limitMinor > 0) {
    lines.push(MetricLine.progress('Extra usage spent', used, rounded(limitMinor) / minorUnits, ProgressFormat.currency(currency)))
  } else {
    lines.push(MetricLine.values('Extra usage spent', [metricValue(used, 'dollars', undefined, currency)]))
  }
}

export const ClaudeUsageMapper = {
  mapUsageResponse(response: HTTPResponse): MetricLine[] {
    const body = ProviderError.requireSuccessJSON(response, 'claude')

    const lines: MetricLine[] = []
    appendUsageWindow(body.five_hour, 'Session', MetricPeriod.sessionMs, lines)
    appendUsageWindow(body.seven_day, 'Weekly', MetricPeriod.weekMs, lines)
    appendUsageWindow(body.seven_day_sonnet, 'Sonnet', MetricPeriod.weekMs, lines)
    appendScopedWeeklyLimit(body.limits, 'Fable', 'Fable', lines)
    appendExtraUsage(body.extra_usage, lines)
    return lines
  },

  mapResetGrantStatus(response: HTTPResponse): ClaudeResetGrantStatus | undefined {
    const body = ProviderError.requireSuccessJSON(response, 'claude')
    return ClaudeResetGrantStatus.parse(body.cedar_ember)
  },

  resetClaimOutcome(response: HTTPResponse): ResetClaimOutcome {
    // Anthropic answers a token whose scopes don't cover an endpoint with a 403 whose message reads
    // "OAuth token does not meet scope requirement …"; that is the sign-in's grant, not an expiry.
    if (response.statusCode === 403 && response.text.includes('scope requirement')) {
      return ResetClaimOutcome.failed('notPermitted')
    }
    if (ProviderError.isAuthFailure(response)) return ResetClaimOutcome.failed('signInExpired')
    const body = response.statusCode >= 200 && response.statusCode < 300 ? ProviderParse.jsonObject(response.body) : undefined
    const result = asString(body?.result)
    if (!body || result === undefined) return ResetClaimOutcome.failed('refused')
    const cooldownUntil = ClaudeUsageMapper.resetDate(body.cooldown_until)
    const outcome = (code: string): ResetClaimOutcome | undefined => {
      switch (code) {
        case 'reset':
        case 'already_used':
          return ResetClaimOutcome.success
        case 'not_limited':
          return ResetClaimOutcome.nothingToReset
        case 'ineligible':
        case 'no_grant':
        case 'unknown_grant':
        case 'not_next_grant':
          return ResetClaimOutcome.noCredit
        case 'reset_unconfirmed':
        case 'stamp_indeterminate':
          return ResetClaimOutcome.unconfirmed
        case 'cooldown':
        case 'paused':
        case 'low_priority_active':
          return ResetClaimOutcome.unavailableNow(cooldownUntil)
        default:
          return undefined
      }
    }
    if (result === 'unavailable') {
      const reason = asString(body.reason)
      return (reason === undefined ? undefined : outcome(reason)) ?? ResetClaimOutcome.failed('refused')
    }
    return outcome(result) ?? ResetClaimOutcome.failed('refused')
  },

  formatLivePlan(profile: ClaudeAccountProfile): string | undefined {
    const organization = profile.organization
    const type = organization?.organizationType
    if (!organization || type === undefined) return undefined
    const raw = (type.startsWith('claude_') ? type.slice('claude_'.length) : type).trim()
    if (raw.length === 0) return undefined
    const base = titleCased(raw, (char) => char === ' ', true)
    const tier = organization.rateLimitTier ?? ''
    if (base === 'Ultra' || (base === 'Max' && (tier.includes('ultra') || tier.includes('20x')))) return 'Ultra'
    if (base === 'Max') return base

    const match = /\d+x/.exec(tier)
    if (!match) return base
    return `${base} ${match[0]}`
  },

  /**
   * An Enterprise organization (`organization_type` `claude_enterprise`) is billed by what it spends, so its
   * Extra Usage is the whole monthly bill, not usage beyond a plan.
   */
  lineTitles(plan: string | undefined): Record<string, string> {
    return plan?.startsWith('Enterprise') === true ? { 'Extra usage spent': 'Spend' } : {}
  },

  resetDate(value: unknown): Instant | undefined {
    const text = asString(value)?.trim()
    if (text !== undefined && text.length > 0) {
      const date = OpenUsageISO8601.date(text)
      if (date !== undefined) return date
    }
    const number = ProviderParse.number(value)
    if (number === undefined || !Number.isFinite(number)) return undefined
    // Seconds below 1e10, milliseconds from there up.
    return Math.abs(number) < 1e10 ? number * 1000 : number
  }
}
