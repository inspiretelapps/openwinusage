import type { RefreshFailure } from '../models/ProviderSnapshot'
import { addSeconds, type Instant, type Seconds } from '../support/time'
import { RefreshSetting } from './RefreshSetting'

/** How long a failed account waits before its next try. */
export interface RefreshBackoff {
  failures: number
  retryAt: Instant
  providerAsked: boolean
  message: string
}

export const RefreshBackoff = {
  /** A wait the provider asked for holds even for a forced refresh. */
  holds(backoff: RefreshBackoff, now: Instant, forced: boolean): boolean {
    return now < backoff.retryAt && (backoff.providerAsked || !forced)
  },

  after(failure: RefreshFailure, previous: RefreshBackoff | undefined, now: Instant): RefreshBackoff {
    const failures = previous?.failures ?? 0
    switch (failure.kind.type) {
      case 'unreachable':
        return { failures, retryAt: addSeconds(now, RefreshSetting.failureBackoffBase), providerAsked: false, message: failure.message }
      case 'refused':
        return {
          failures: failures + 1,
          retryAt: addSeconds(now, RefreshBackoff.delay(failures + 1)),
          providerAsked: false,
          message: failure.message
        }
      case 'rateLimited': {
        const wait = failure.kind.retryAfter ?? RefreshBackoff.delay(failures + 1)
        return { failures: failures + 1, retryAt: addSeconds(now, wait), providerAsked: true, message: failure.message }
      }
    }
  },

  delay(failures: number): Seconds {
    const doublings = Math.min(Math.max(failures - 1, 0), 16)
    return Math.min(RefreshSetting.failureBackoffBase * Math.pow(2, doublings), RefreshSetting.failureBackoffCap)
  }
}
