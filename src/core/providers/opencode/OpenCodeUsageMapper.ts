import { MetricLine } from '../../models/MetricLine'
import { HTTPResponse } from '../../services/HTTPClient'
import { MetricPeriod } from '../../support/MetricPeriod'
import { OpenUsageISO8601 } from '../../support/OpenUsageISO8601'
import { asObject, asString, ProviderParse, type JSONObject } from '../../support/ProviderParse'
import { secondsBetween, type Instant, type Seconds } from '../../support/time'
import { ProviderError } from '../ProviderError'

/**
 * Maximum distance from exactly one full period for a zero-usage rolling reset to count as the
 * untouched-window placeholder. OpenCode rounds `resetInSec` up to whole seconds and HTTP `Date`
 * headers carry whole-second precision, so two seconds covers both rounding steps. A session that
 * starts inside that narrow interval is indistinguishable in one response and can read "Not started"
 * until the next refresh; widening this tolerance would lengthen that unavoidable stale state.
 */
const placeholderResetTolerance: Seconds = 2

/**
 * The three meters of a usage answer. Given the response, its HTTP `Date` header is the capture time
 * when it has one; given the decoded body, `capturedAt` is.
 */
function meterLines(response: HTTPResponse, capturedAt?: Instant): MetricLine[]
function meterLines(body: JSONObject, capturedAt?: Instant): MetricLine[]
function meterLines(source: HTTPResponse | JSONObject, capturedAt: Instant = Date.now()): MetricLine[] {
  if (source instanceof HTTPResponse) {
    const body = ProviderParse.jsonObject(source.body)
    if (!body) throw ProviderError.invalidResponse
    return meterLines(body, source.date ?? capturedAt)
  }
  const usage = asObject(source.usage)
  if (!usage) throw ProviderError.invalidResponse
  return [
    window(usage.rolling, 'Session', MetricPeriod.sessionMs, capturedAt, true),
    window(usage.weekly, 'Weekly', MetricPeriod.weekMs, capturedAt),
    window(usage.monthly, 'Monthly', MetricPeriod.monthMs, capturedAt)
  ]
}

export const OpenCodeUsageMapper = {
  plan: 'Go',

  placeholderResetTolerance,

  meterLines,

  errorType(response: HTTPResponse): string | undefined {
    const body = ProviderParse.jsonObject(response.body)
    const error = asObject(body?.error)
    const type = asString(error?.type)?.trim()
    if (type === undefined || type.length === 0) return undefined
    return type
  }
}

/**
 * One window. `dropsPlaceholderReset` is for the rolling session only: with no calls inside the
 * window there is nothing to roll off, so the API answers `resetsAt = now + 5h` and re-derives it
 * on every request rather than reporting a real instant. That placeholder means "if you started
 * now", so it is dropped to `undefined` here and the Session row shows no reset. Doing it at capture time
 * is what makes it sound: the full-period comparison is exact only at the instant the snapshot is
 * taken, and drifts every second afterwards, so it must not be re-run at render time.
 *
 * A window with real usage anchors its reset to the oldest call, so it stays strictly inside the
 * period and keeps its countdown — including the sub-1% case, where the whole-percent `percent`
 * field rounds down to 0 and would otherwise read as an unstarted window. Weekly and monthly opt
 * out: their resets are calendar/billing instants that exist regardless of usage, and early in a
 * cycle one would sit a near-full period out and be dropped by mistake.
 */
function window(raw: unknown, label: string, periodMs: number, capturedAt: Instant, dropsPlaceholderReset = false): MetricLine {
  const object = asObject(raw)
  const percent = object ? ProviderParse.number(object.percent) : undefined
  const resetString = object ? asString(object.resetsAt) : undefined
  const reportedReset = resetString === undefined ? undefined : OpenUsageISO8601.date(resetString)
  if (percent === undefined || reportedReset === undefined) throw ProviderError.invalidResponse
  const used = ProviderParse.clampPercent(percent)
  let resetsAt: Instant | undefined = reportedReset
  if (dropsPlaceholderReset && used === 0) {
    const period: Seconds = periodMs / 1000
    const distanceFromFullPeriod = Math.abs(secondsBetween(reportedReset, capturedAt) - period)
    if (distanceFromFullPeriod <= placeholderResetTolerance) {
      resetsAt = undefined
    }
  }
  return MetricLine.percent(label, used, resetsAt, periodMs)
}
