import { rounded } from './numbers'
import { MetricPeriod } from './MetricPeriod'
import { secondsBetween, type Instant, type Seconds } from './time'
import type { PriorityLimits } from '../models/PriorityLimits'
import type { MeterSeverity, MeterState, WidgetData } from '../models/WidgetData'

/** The raw values are the stored setting's. The two levels keep their old raw values, so a saved switch stays on or off through the renames. */
export type PaceMilestone = 'underTenPercent' | 'healthyToClose' | 'closeToRunningOut' | 'useItOrLoseIt'

export const PaceMilestone = {
  critical: 'underTenPercent' as PaceMilestone,
  warning: 'healthyToClose' as PaceMilestone,
  closeToRunningOut: 'closeToRunningOut' as PaceMilestone,
  useItOrLoseIt: 'useItOrLoseIt' as PaceMilestone,

  /** In declaration order: critical, warning, closeToRunningOut, useItOrLoseIt. */
  allCases: ['underTenPercent', 'healthyToClose', 'closeToRunningOut', 'useItOrLoseIt'] as const satisfies readonly PaceMilestone[],

  settingKey(milestone: PaceMilestone): string {
    return `openusage.notifications.${milestone}`
  },

  /** The two levels follow what's left, the same rule as Priority. Only this one follows the pace. */
  isPace(milestone: PaceMilestone): boolean {
    return milestone === 'closeToRunningOut'
  },

  isLevel(milestone: PaceMilestone): boolean {
    return milestone === 'underTenPercent' || milestone === 'healthyToClose'
  },

  settingSubtitle(milestone: PaceMilestone): string {
    switch (milestone) {
      case 'underTenPercent':
        return 'Alert when a limit drops critically low'
      case 'healthyToClose':
        return 'Alert when a limit requires your attention'
      case 'closeToRunningOut':
        return 'A limit may run out before its reset'
      case 'useItOrLoseIt':
        return 'Over 50% left a day before its reset'
    }
  },

  notificationTitle(milestone: PaceMilestone): string {
    switch (milestone) {
      case 'underTenPercent':
        return 'Critical'
      case 'healthyToClose':
        return 'Warning'
      case 'closeToRunningOut':
        return 'Will Run Out'
      case 'useItOrLoseIt':
        return 'Use It or Lose It'
    }
  },

  body(milestone: PaceMilestone, limits: PriorityLimits): string {
    switch (milestone) {
      case 'underTenPercent':
        return `${limits.critical}% or less left for this window.`
      case 'healthyToClose':
        return `${limits.warning}% or less left for this window.`
      case 'closeToRunningOut':
        return 'May run out before the limit resets.'
      case 'useItOrLoseIt':
        return 'Over 50% left, resets in under 24 hours.'
    }
  }
}

/** Ordered: untracked < healthy < close < runningOut. */
export const PaceBucket = {
  untracked: -1,
  healthy: 0,
  close: 1,
  runningOut: 2
} as const
export type PaceBucket = (typeof PaceBucket)[keyof typeof PaceBucket]

export interface NotificationState {
  resetsAt?: Instant
  firedMilestones: Set<PaceMilestone>
  previousBucket: PaceBucket
  previousSeverity: MeterSeverity
  primed: boolean
}

export const NotificationState = {
  initial(): NotificationState {
    return { firedMilestones: new Set(), previousBucket: PaceBucket.untracked, previousSeverity: 'normal', primed: false }
  },

  copy(state: NotificationState): NotificationState {
    return { ...state, firedMilestones: new Set(state.firedMilestones) }
  }
}

export interface PaceTransition {
  fire: PaceMilestone[]
  newState: NotificationState
}

export const PaceNotificationLogic = {
  useItOrLoseItLead: (24 * 60 * 60) as Seconds,
  resetWindowJitterTolerance: 1 as Seconds,

  bucket(state: MeterState): PaceBucket {
    switch (state) {
      case 'noData':
      case 'unpaced':
        return PaceBucket.untracked
      case 'healthy':
        return PaceBucket.healthy
      case 'closeToLimit':
        return PaceBucket.close
      case 'runningOut':
      case 'spent':
        return PaceBucket.runningOut
    }
  },

  transitions(input: {
    state: MeterState
    severity: MeterSeverity
    resetsAt: Instant | undefined
    unusedNearReset: boolean
    previous: NotificationState
  }): PaceTransition {
    const { state, severity, resetsAt, unusedNearReset, previous } = input
    const next = PaceNotificationLogic.carriedOver(previous, resetsAt)
    const currentBucket = PaceNotificationLogic.bucket(state)

    if (state === 'noData') return { fire: [], newState: next }

    if (!next.primed) {
      next.primed = true
      next.previousBucket = currentBucket
      next.previousSeverity = severity
      next.firedMilestones = new Set(unusedNearReset ? [PaceMilestone.useItOrLoseIt] : [])
      return { fire: [], newState: next }
    }

    const fire: PaceMilestone[] = []
    const candidate = (milestone: PaceMilestone): void => {
      if (!next.firedMilestones.has(milestone)) fire.push(milestone)
    }

    if (currentBucket !== PaceBucket.untracked) {
      const previousBucket = next.previousBucket
      if (currentBucket >= PaceBucket.runningOut && previousBucket < PaceBucket.runningOut) candidate(PaceMilestone.closeToRunningOut)
      // Re-arms only once the pace eases to 90% of the limit, where Priority stops listing it as burning fast.
      if (currentBucket === PaceBucket.healthy) next.firedMilestones.delete(PaceMilestone.closeToRunningOut)
      next.previousBucket = currentBucket
    }

    if (severity === 'critical' && next.previousSeverity !== 'critical') candidate(PaceMilestone.critical)
    if (severity !== 'normal' && next.previousSeverity === 'normal') candidate(PaceMilestone.warning)
    if (severity !== 'critical') next.firedMilestones.delete(PaceMilestone.critical)
    if (severity === 'normal') next.firedMilestones.delete(PaceMilestone.warning)
    next.previousSeverity = severity

    if (unusedNearReset) candidate(PaceMilestone.useItOrLoseIt)

    return { fire, newState: next }
  },

  carriedOver(previous: NotificationState, resetsAt: Instant | undefined): NotificationState {
    const next = NotificationState.copy(previous)
    if (PaceNotificationLogic.resetWindowAdvanced(resetsAt, previous.resetsAt)) {
      next.firedMilestones = new Set()
      next.previousSeverity = 'normal'
      next.previousBucket = PaceBucket.untracked
    }
    next.resetsAt = resetsAt ?? previous.resetsAt
    return next
  },

  /**
   * Only for windows longer than a day, from the provider's own reset and what's left. A session never qualifies,
   * and neither does a dollar limit: those are spending caps, where nothing is lost at the reset.
   */
  isUnusedNearReset(data: WidgetData, now: Instant): boolean {
    if (!data.hasData || data.kind === 'dollars' || data.resetsAt === undefined) return false
    if (data.periodDurationMs === undefined || !(data.periodDurationMs > MetricPeriod.dayMs)) return false
    const untilReset = secondsBetween(data.resetsAt, now)
    return untilReset > 0 && untilReset <= PaceNotificationLogic.useItOrLoseItLead && rounded(data.remainingFraction * 100) > 50
  },

  resetWindowAdvanced(resetsAt: Instant | undefined, previousReset: Instant | undefined): boolean {
    if (resetsAt === undefined) return false
    if (previousReset === undefined) return true
    return secondsBetween(resetsAt, previousReset) > PaceNotificationLogic.resetWindowJitterTolerance
  }
}
