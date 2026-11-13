import type { Seconds } from '../support/time'

const timedOut: unique symbol = Symbol('timedOut')
export type TimedOut = typeof timedOut

/**
 * Runs one provider's `refresh()` or hourly reads under a hard deadline, answering `timedOut` when the
 * deadline wins.
 *
 * A provider that never returns used to hold the store's in-flight entry forever, so the dashboard
 * spinner turned for the rest of the session. What the deadline guarantees is that the *store* stops
 * waiting; the abandoned read's result, if it ever comes, is dropped.
 */
export const ProviderRefreshDeadline = {
  timedOut: timedOut as TimedOut,

  async run<T>(timeout: Seconds, operation: () => Promise<T>): Promise<T | TimedOut> {
    let timer: ReturnType<typeof setTimeout> | undefined
    const deadline = new Promise<TimedOut>((resolve) => {
      timer = setTimeout(() => resolve(timedOut), timeout * 1000)
    })
    try {
      return await Promise.race([operation(), deadline])
    } finally {
      if (timer !== undefined) clearTimeout(timer)
    }
  }
}
