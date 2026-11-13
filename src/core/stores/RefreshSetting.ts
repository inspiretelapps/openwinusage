import type { Seconds } from '../support/time'

const interval: Seconds = 5 * 60

export const RefreshSetting = {
  interval,

  /**
   * A forced refresh lets the next pass skip an account, so working refreshes can leave its values
   * about two intervals old.
   */
  stalenessThreshold: interval * 2,

  failureBackoffBase: interval,
  failureBackoffCap: 60 * 60 as Seconds,

  secondaryReadInterval: 60 * 60 as Seconds,
  forcedResetGrantsMinimumAge: 15 * 60 as Seconds
}
