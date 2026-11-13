import { MetricLine } from '../../models/MetricLine'
import type { HTTPResponse } from '../../services/HTTPClient'
import { rounded } from '../../support/numbers'
import { asString, ProviderParse } from '../../support/ProviderParse'
import { ProviderError } from '../ProviderError'
import { ProviderUsage } from '../ProviderRuntime'
import { GrokCreditsConfig, GrokCreditsConfigDecoder } from './GrokCreditsConfigDecoder'

function formatUnits(value: number): string {
  if (rounded(value) === value) {
    // `String(Int(value))`: every digit, where a JS number past 2^53 would print rounded.
    return BigInt(value).toString()
  }
  return String(value)
}

export const GrokUsageMapper = {
  mapCreditsConfig(response: HTTPResponse): ProviderUsage {
    if (
      response.statusCode === 412 &&
      asString(ProviderParse.jsonObject(response.body)?.error)?.toLowerCase().includes('no personal team') === true
    ) {
      return ProviderUsage.make(undefined, [], 'Grok team accounts have no personal quota.')
    }
    ProviderError.requireSuccess(response, 'grok')
    const config = GrokCreditsConfigDecoder.decode(response.body)

    const lines: MetricLine[] = []
    if (config.periodType === GrokCreditsConfigDecoder.weeklyPeriodType) {
      const used = ProviderParse.clampPercent(config.usedPercent)
      lines.push(MetricLine.percent('Weekly limit', used, config.periodEnd, GrokCreditsConfig.periodDurationMs(config)))
    }
    if (config.onDemandCap > 0) {
      lines.push(MetricLine.badge('Pay as you go', `${formatUnits(config.onDemandCap)} cap`))
    }
    return ProviderUsage.make(undefined, lines)
  },

  /** `planName(from:)` */
  planName(response: HTTPResponse): string | undefined {
    if (!(response.statusCode >= 200 && response.statusCode < 300)) return undefined
    const plan = asString(ProviderParse.jsonObject(response.body)?.subscription_tier_display)
    if (plan === undefined) return undefined
    const trimmed = plan.trim()
    return trimmed.length === 0 ? undefined : trimmed
  }
}
