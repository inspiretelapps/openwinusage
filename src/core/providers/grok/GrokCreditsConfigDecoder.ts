import { OpenUsageISO8601 } from '../../support/OpenUsageISO8601'
import { rounded } from '../../support/numbers'
import { asObject, asString, ProviderParse } from '../../support/ProviderParse'
import type { Instant } from '../../support/time'
import { ProviderError } from '../ProviderError'

export interface GrokCreditsConfig {
  periodType: string
  usedPercent: number
  periodStart: Instant
  periodEnd: Instant
  onDemandCap: number
}

export const GrokCreditsConfig = {
  periodDurationMs(config: GrokCreditsConfig): number {
    return rounded(config.periodEnd - config.periodStart)
  }
}

function date(value: unknown): Instant | undefined {
  const raw = asString(value)?.trim()
  if (raw === undefined || raw.length === 0) return undefined
  return OpenUsageISO8601.date(raw)
}

export const GrokCreditsConfigDecoder = {
  weeklyPeriodType: 'USAGE_PERIOD_TYPE_WEEKLY',

  decode(responseBody: Uint8Array | string): GrokCreditsConfig {
    const body = ProviderParse.jsonObject(responseBody)
    const config = asObject(body?.config)
    const period = asObject(config?.currentPeriod)
    const periodType = asString(period?.type)?.trim()
    const start = date(period?.start)
    const end = date(period?.end)
    if (
      !config ||
      !period ||
      periodType === undefined ||
      periodType.length === 0 ||
      start === undefined ||
      end === undefined ||
      !(end > start)
    ) {
      throw ProviderError.invalidResponse
    }

    // proto-JSON omits zero values, so an absent percent is a genuine 0% — but a present,
    // non-numeric or non-finite value is a schema change and must throw, not clamp to 0.
    let percent: number
    const raw = config.creditUsagePercent
    if (raw !== undefined) {
      const number = ProviderParse.number(raw)
      if (number === undefined || !Number.isFinite(number)) {
        throw ProviderError.invalidResponse
      }
      percent = number
    } else {
      percent = 0
    }

    let onDemandCap: number
    const capObject = config.onDemandCap
    if (capObject !== undefined) {
      const object = asObject(capObject)
      if (!object) {
        throw ProviderError.invalidResponse
      }
      const cap = ProviderParse.number(object.val === undefined ? 0 : object.val)
      if (cap === undefined || ProviderParse.int(cap) === undefined) {
        throw ProviderError.invalidResponse
      }
      onDemandCap = cap
    } else {
      onDemandCap = 0
    }

    return { periodType, usedPercent: percent, periodStart: start, periodEnd: end, onDemandCap }
  }
}
