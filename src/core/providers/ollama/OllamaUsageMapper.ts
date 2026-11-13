import { MetricLine, ProgressFormat } from '../../models/MetricLine'
import { metricValue } from '../../models/MetricValue'
import { MetricPeriod } from '../../support/MetricPeriod'
import { OpenUsageISO8601 } from '../../support/OpenUsageISO8601'
import { asObject, asString, nilIfEmpty, ProviderParse, type JSONObject } from '../../support/ProviderParse'
import type { Instant } from '../../support/time'
import { ProviderError } from '../ProviderError'
import { ProviderUsage } from '../ProviderRuntime'

export const OllamaUsageMapper = {
  map(balanceBody: Uint8Array | string, accountBody: Uint8Array | string | undefined): ProviderUsage {
    return ProviderUsage.make(accountBody === undefined ? undefined : OllamaUsageMapper.plan(accountBody), OllamaUsageMapper.balanceLines(balanceBody))
  },

  balanceLines(body: Uint8Array | string): MetricLine[] {
    const root = ProviderParse.jsonObject(body)
    const included = asObject(root?.included)
    if (!root || !included) throw ProviderError.invalidResponse

    const lines: MetricLine[] = []
    const session = legacyLine(included.session, 'Session', MetricPeriod.sessionMs)
    if (session) lines.push(session)
    const weekly = legacyLine(included.weekly, 'Weekly', MetricPeriod.weekMs)
    if (weekly) lines.push(weekly)
    const monthly = monthlyLine(included)
    if (monthly) lines.push(monthly)
    if (lines.length === 0) throw ProviderError.invalidResponse

    const purchased = purchasedLine(root.purchased)
    if (purchased) lines.push(purchased)
    return lines
  },

  /**
   * The account's plan, title-cased for the header badge ("pro" → "Pro"), or `undefined` when the body is
   * not an account or names no plan. Called directly, ollama.com capitalizes its JSON keys (`Plan`);
   * the local Ollama server lowercases them when it proxies the same response, so both spellings
   * are accepted.
   */
  plan(body: Uint8Array | string): string | undefined {
    const root = ProviderParse.jsonObject(body)
    if (!root) return undefined
    const text = asString(root.Plan !== undefined ? root.Plan : root.plan)
    if (text === undefined) return undefined
    const name = nilIfEmpty(text.trim())
    return name === undefined ? undefined : capitalized(name)
  },

  email(body: Uint8Array | string): string | undefined {
    const root = ProviderParse.jsonObject(body)
    if (!root) return undefined
    const text = asString(root.Email !== undefined ? root.Email : root.email)
    return text === undefined ? undefined : nilIfEmpty(text.trim())
  }
}

/** Swift's `String.capitalized`: each word's first letter uppercased and the rest lowercased. */
function capitalized(text: string): string {
  return text.toLowerCase().replace(/(^|[^\p{L}\p{N}\p{M}_'’])(\p{L})/gu, (_, before: string, first: string) => before + first.toUpperCase())
}

function legacyLine(entry: unknown, label: string, periodMs: number): MetricLine | undefined {
  const object = asObject(entry)
  if (!object) return undefined
  const remaining = ProviderParse.number(object.remaining_percent)
  if (remaining === undefined) return undefined
  const resetsAt = date(object.resets_at)
  const used = ProviderParse.clampPercent(100 - remaining)
  return MetricLine.percent(label, used, resetsAt, resetsAt === undefined ? undefined : periodMs)
}

function monthlyLine(included: JSONObject): MetricLine | undefined {
  const allowance = ProviderParse.number(included.allowance_usd)
  if (allowance === undefined || !(allowance > 0)) return undefined
  const balance = ProviderParse.number(included.balance_usd)
  if (balance === undefined) return undefined
  const period = asObject(included.period)
  const from = date(period?.from)
  const until = date(period?.until)
  let periodMs: number | undefined
  if (from !== undefined && until !== undefined && until > from) {
    periodMs = Math.trunc(until - from)
  }
  return MetricLine.progress('Monthly', Math.min(allowance, Math.max(0, allowance - balance)), allowance, ProgressFormat.dollars, until, periodMs)
}

function purchasedLine(purchased: unknown): MetricLine | undefined {
  const object = asObject(purchased)
  if (!object) return undefined
  const balance = ProviderParse.number(object.balance_usd)
  if (balance === undefined) return undefined
  return MetricLine.values('Purchased Credits', [metricValue(Math.max(0, balance), 'dollars')])
}

function date(value: unknown): Instant | undefined {
  const text = asString(value)
  return text === undefined ? undefined : OpenUsageISO8601.date(text)
}
