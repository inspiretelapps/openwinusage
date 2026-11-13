import { PaceNotificationLogic } from '../support/PaceNotificationLogic'
import type { Instant } from '../support/time'
import { DashboardLine } from './DashboardFamilies'
import type { WidgetData } from './WidgetData'

/**
 * Lists a limit that is on pace to run out before it resets, however much it has left. Once a limit is
 * burning fast it stays so until its pace eases to 90% of the limit, so a pace that hovers right at the
 * limit doesn't flicker in and out between readings. The Will Run Out alert re-arms at the same point.
 */
export class BurningFast {
  /** The limits that were burning fast at their last reading, with the reset of the window they were burning in. */
  latched: Map<string, Instant>

  constructor(latched: Map<string, Instant> = new Map()) {
    this.latched = latched
  }

  contains(line: DashboardLine, now: Instant): boolean {
    return BurningFast.isBurning(line.data, now, this.wasBurning(DashboardLine.id(line), line.data))
  }

  /** A new window starts afresh, whatever the last one did. */
  wasBurning(id: string, data: WidgetData): boolean {
    const reset = this.latched.get(id)
    if (reset === undefined) return false
    return !PaceNotificationLogic.resetWindowAdvanced(data.resetsAt, reset)
  }

  static isBurning(data: WidgetData, now: Instant, wasBurning: boolean): boolean {
    switch (data.meterState(now)) {
      case 'runningOut':
        return true
      case 'closeToLimit':
        return wasBurning
      case 'noData':
      case 'spent':
      case 'healthy':
      case 'unpaced':
        return false
    }
  }

  equals(other: BurningFast): boolean {
    if (this.latched.size !== other.latched.size) return false
    for (const [id, reset] of this.latched) if (other.latched.get(id) !== reset) return false
    return true
  }
}
