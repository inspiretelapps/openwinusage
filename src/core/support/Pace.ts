import { addSeconds, secondsBetween, type Instant, type Seconds } from './time'

export type PaceStatus = 'ahead' | 'onTrack' | 'behind'

export interface PaceResult {
  status: PaceStatus
  projectedUsage: number
}

export const Pace = {
  evaluate(used: number, limit: number, resetsAt: Instant, periodDuration: Seconds, now: Instant = Date.now()): PaceResult | undefined {
    if (!(limit > 0) || !(used > 0)) return undefined
    const share = Pace.elapsedShare(resetsAt, periodDuration, now)
    if (share === undefined) return undefined

    const projected = used / share
    if (used >= limit) return { status: 'behind', projectedUsage: projected }

    let status: PaceStatus
    if (projected <= limit * 0.9) status = 'ahead'
    else if (projected <= limit) status = 'onTrack'
    else status = 'behind'
    return { status, projectedUsage: projected }
  },

  /** How much of the window has passed, or undefined until a minute and 1% of it have, and once it resets. */
  elapsedShare(resetsAt: Instant, periodDuration: Seconds, now: Instant): number | undefined {
    if (!(periodDuration > 0)) return undefined
    const elapsed = secondsBetween(now, addSeconds(resetsAt, -periodDuration))
    if (!(elapsed >= Math.max(60, periodDuration * 0.01)) || !(now < resetsAt)) return undefined
    return elapsed / periodDuration
  }
}
