import { MetricLine } from '../../models/MetricLine'
import { metricValue } from '../../models/MetricValue'
import type { HTTPResponse } from '../../services/HTTPClient'
import { MetricPeriod } from '../../support/MetricPeriod'
import { OpenUsageISO8601 } from '../../support/OpenUsageISO8601'
import { asObject, asString, ProviderParse, titleCased, type JSONObject } from '../../support/ProviderParse'
import type { Instant } from '../../support/time'
import { ProviderError } from '../ProviderError'
import { ProviderUsage } from '../ProviderRuntime'

const periodMs = MetricPeriod.monthMs

function snapshotLine(label: string, raw: unknown, resetsAt: Instant | undefined): MetricLine | undefined {
  const snapshot = asObject(raw)
  if (!snapshot) return undefined

  const entitlement = ProviderParse.number(snapshot.entitlement)
  const remaining = ProviderParse.number(snapshot.remaining)

  // Unlimited: the explicit flag, or GitHub's `-1` sentinel on entitlement/remaining. Suppress.
  if (ProviderParse.bool(snapshot.unlimited) === true || entitlement === -1 || remaining === -1) {
    return undefined
  }
  if (entitlement === 0) return undefined

  let usedPercent: number
  const percentRemaining = ProviderParse.number(snapshot.percent_remaining)
  if (percentRemaining !== undefined) {
    usedPercent = ProviderParse.clampPercent(100 - percentRemaining)
  } else if (entitlement !== undefined && entitlement > 0 && remaining !== undefined) {
    usedPercent = ProviderParse.clampPercent(100 - (remaining / entitlement) * 100)
  } else {
    return undefined
  }

  return MetricLine.percent(label, usedPercent, resetsAt, periodMs)
}

function personalCreditsLines(raw: unknown): MetricLine[] {
  const snapshot = asObject(raw)
  const creditsUsed = snapshot ? ProviderParse.number(snapshot.credits_used) : undefined
  if (creditsUsed === undefined || !(creditsUsed > 0)) return []
  return [MetricLine.values('Credits', [metricValue(creditsUsed, 'count')])]
}

function overageLine(raw: unknown): MetricLine | undefined {
  const snapshot = asObject(raw)
  if (!snapshot || ProviderParse.bool(snapshot.overage_permitted) !== true) return undefined
  const overage = Math.max(0, ProviderParse.number(snapshot.overage_count) ?? 0)
  return MetricLine.values('Extra Usage', [metricValue(overage, 'count')])
}

function limitedLine(label: string, remainingRaw: unknown, totalRaw: unknown, resetsAt: Instant | undefined): MetricLine | undefined {
  const total = ProviderParse.number(totalRaw)
  if (total === undefined || !(total > 0)) return undefined
  const remaining = ProviderParse.number(remainingRaw)
  if (remaining === undefined) return undefined
  const used = Math.max(0, total - remaining)
  return MetricLine.percent(label, ProviderParse.clampPercent((used / total) * 100), resetsAt, periodMs)
}

function appendIfPresent(lines: MetricLine[], line: MetricLine | undefined): void {
  if (line) lines.push(line)
}

function planLabel(value: unknown): string | undefined {
  const raw = asString(value)?.trim()
  if (raw === undefined || raw.length === 0) return undefined
  return titleCased(raw, (char) => char === '_' || char === ' ' || char === '-', true)
}

/** A day with no time, `yyyy-MM-dd`, read as midnight UTC. */
function dayOnly(raw: string): Instant | undefined {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw)
  if (!match) return undefined
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  const date = new Date(0)
  date.setUTCFullYear(year, month - 1, day)
  // Reject dates the calendar doesn't have (month 13, day 32), which would roll over.
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return undefined
  return date.getTime()
}

function parseResetDate(value: unknown): Instant | undefined {
  const raw = asString(value)?.trim()
  if (raw === undefined || raw.length === 0) return undefined
  return OpenUsageISO8601.date(raw) ?? dayOnly(raw)
}

export const CopilotUsageMapper = {
  periodMs,

  /** `map(_:)`: maps the usage response. */
  map(response: HTTPResponse): ProviderUsage {
    const body = ProviderParse.jsonObject(response.body)
    if (!body) throw ProviderError.invalidResponse
    return CopilotUsageMapper.mapBody(body)
  },

  /** `map(body:)` */
  mapBody(body: JSONObject): ProviderUsage {
    const plan = planLabel(body.copilot_plan)
    const resetsAt = parseResetDate(body.quota_reset_date) ?? parseResetDate(body.limited_user_reset_date)

    const lines: MetricLine[] = []

    const snapshots = asObject(body.quota_snapshots)
    const premium = snapshots?.premium_interactions
    const creditsLine = snapshotLine('Credits', premium, resetsAt)
    appendIfPresent(lines, creditsLine)
    if (creditsLine !== undefined) {
      appendIfPresent(lines, overageLine(premium))
    }

    appendIfPresent(lines, snapshotLine('Chat', snapshots?.chat, resetsAt))
    appendIfPresent(lines, snapshotLine('Completions', snapshots?.completions, resetsAt))

    if (lines.length === 0) {
      const limited = asObject(body.limited_user_quotas)
      const monthly = asObject(body.monthly_quotas)
      appendIfPresent(lines, limitedLine('Chat', limited?.chat, monthly?.chat, resetsAt))
      appendIfPresent(lines, limitedLine('Completions', limited?.completions, monthly?.completions, resetsAt))
    }

    if (lines.length === 0) {
      if (ProviderParse.bool(body.token_based_billing) !== true) {
        throw ProviderError.unavailable('Copilot usage data is unavailable for this account.')
      }
      return ProviderUsage.make(plan, personalCreditsLines(premium))
    }

    return ProviderUsage.make(plan, lines)
  }
}
