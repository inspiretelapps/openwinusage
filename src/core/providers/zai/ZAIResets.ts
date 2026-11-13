import { MetricLine } from '../../models/MetricLine'
import { metricValue } from '../../models/MetricValue'
import type { HTTPResponse } from '../../services/HTTPClient'
import { ResetClaimOutcome } from '../../services/ResetClaimService'
import { asObject, asString, isJSONObject, ProviderParse } from '../../support/ProviderParse'
import type { Instant } from '../../support/time'
import { ProviderError } from '../ProviderError'

/** A banked Z.ai reset refills one window: the five-hour Session or the Weekly. The values are Z.ai's own names. */
export type ZAIResetWindow = 'FIVE_HOUR' | 'WEEK'

export const ZAIResetWindow = {
  fiveHour: 'FIVE_HOUR',
  week: 'WEEK',

  allCases: ['FIVE_HOUR', 'WEEK'],

  title(window: ZAIResetWindow): string {
    switch (window) {
      case 'FIVE_HOUR':
        return 'Session'
      case 'WEEK':
        return 'Weekly'
    }
  },

  confirmDetail(window: ZAIResetWindow): string {
    return `Refills your ${ZAIResetWindow.title(window).toLowerCase()} limit now. This can't be undone.`
  }
} as const satisfies {
  fiveHour: ZAIResetWindow
  week: ZAIResetWindow
  allCases: readonly ZAIResetWindow[]
  title(window: ZAIResetWindow): string
  confirmDetail(window: ZAIResetWindow): string
}

function listKey(window: ZAIResetWindow): string {
  switch (window) {
    case 'FIVE_HOUR':
      return 'fiveHourResets'
    case 'WEEK':
      return 'weekResets'
  }
}

/** One available reset record. A claim names its record exactly: two resets can share an expiry. */
export interface ZAIReset {
  readonly window: ZAIResetWindow
  readonly recordID: number
  readonly expiresAt: Instant
  readonly grantType: string
}

export const ZAIReset = {
  make(window: ZAIResetWindow, recordID: number, expiresAt: Instant, grantType: string): ZAIReset {
    return { window, recordID, expiresAt, grantType }
  },

  equal(a: ZAIReset | undefined, b: ZAIReset | undefined): boolean {
    if (a === undefined || b === undefined) return a === b
    return a.window === b.window && a.recordID === b.recordID && a.expiresAt === b.expiresAt && a.grantType === b.grantType
  }
}

const expiryText = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/
const expiryOffsetMs = 8 * 60 * 60 * 1000

export const ZAIResetsMapper = {
  /** The available, unexpired resets of both windows, earliest first. */
  resets(body: Uint8Array | string, now: Instant): ZAIReset[] {
    const root = ProviderParse.jsonObject(body)
    const data = asObject(root?.data)
    if (!root || root.success === false || !data) throw ProviderError.invalidResponse
    const resets: ZAIReset[] = []
    for (const window of ZAIResetWindow.allCases) {
      const records = data[listKey(window)]
      if (records === undefined) continue
      if (!Array.isArray(records) || !records.every(isJSONObject)) throw ProviderError.invalidResponse
      for (const record of records) {
        if (record.available !== true) continue
        const id = record.recordId
        const expireTime = asString(record.expireTime)
        const expiresAt = expireTime === undefined ? undefined : ZAIResetsMapper.expiry(expireTime)
        const grantType = asString(record.grantType)
        if (typeof id !== 'number' || !Number.isInteger(id) || expiresAt === undefined || grantType === undefined || grantType.length === 0) {
          throw ProviderError.invalidResponse
        }
        if (expiresAt > now) {
          resets.push({ window, recordID: id, expiresAt, grantType })
        }
      }
    }
    return resets.sort((a, b) => (a.expiresAt !== b.expiresAt ? a.expiresAt - b.expiresAt : a.recordID - b.recordID))
  },

  line(resets: ZAIReset[]): MetricLine {
    return MetricLine.values(
      'Rate Limit Resets',
      [metricValue(resets.length, 'count', 'available')],
      resets.map((reset) => reset.expiresAt)
    )
  },

  /** Only a successful status with `success: true` spent the reset. */
  claimOutcome(response: HTTPResponse): ResetClaimOutcome {
    if (ProviderError.isAuthFailure(response)) return ResetClaimOutcome.failed('signInExpired')
    if (!(response.statusCode >= 200 && response.statusCode < 300) || ProviderParse.jsonObject(response.body)?.success !== true) {
      return ResetClaimOutcome.failed('refused')
    }
    return ResetClaimOutcome.success
  },

  /** Z.ai writes expiries as `yyyy-MM-dd HH:mm:ss` in its own time zone, UTC+8. */
  expiry(text: string): Instant | undefined {
    const match = expiryText.exec(text)
    if (!match) return undefined
    const [year, month, day, hour, minute, second] = match.slice(1).map(Number)
    const wallClock = new Date(0)
    wallClock.setUTCFullYear(year, month - 1, day)
    wallClock.setUTCHours(hour, minute, second, 0)
    // A date the calendar doesn't have (month 13, hour 24) rolls over, and so doesn't read back as written.
    const pad = (value: number, width = 2): string => String(value).padStart(width, '0')
    const written =
      `${pad(wallClock.getUTCFullYear(), 4)}-${pad(wallClock.getUTCMonth() + 1)}-${pad(wallClock.getUTCDate())} ` +
      `${pad(wallClock.getUTCHours())}:${pad(wallClock.getUTCMinutes())}:${pad(wallClock.getUTCSeconds())}`
    if (written !== text) return undefined
    return wallClock.getTime() - expiryOffsetMs
  }
}
