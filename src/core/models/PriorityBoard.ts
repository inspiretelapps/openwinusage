import { Formatters } from '../support/Formatters'
import { PaceNotificationLogic } from '../support/PaceNotificationLogic'
import { secondsBetween, type Instant, type Seconds } from '../support/time'
import type { BurningFast } from './BurningFast'
import { DashboardLine, type DashboardAccount } from './DashboardFamilies'
import { DashboardRowModel } from './DashboardRowModel'
import type { Provider } from './Provider'
import type { MeterSeverity, WidgetData } from './WidgetData'

/** Why a limit is on the board. */
export type PriorityReason =
  /** Listed for what's left, the same rule that colors its bar. */
  | { type: 'low'; severity: MeterSeverity; remaining: number; runway?: Seconds }
  /** Listed with plenty left because it would run out before it resets at the current pace. */
  | { type: 'burningFast'; runway: Seconds }
  | { type: 'usedUp'; resetsAt?: Instant }
  | { type: 'emptyBalance' }
  /** Listed with over half left because it resets within a day, the same rule as the Use It or Lose It alert. */
  | { type: 'useItOrLoseIt'; resetsAt: Instant }

export type PrioritySection = 'runningOut' | 'usedUp' | 'useItOrLoseIt'

export const PriorityReason = {
  /**
   * `burningFast` is undefined while Settings leaves limits burning fast off the list, and `useItOrLoseIt` is
   * false while it leaves limits about to reset unused off.
   */
  make(line: DashboardLine, now: Instant, burningFast: BurningFast | undefined, useItOrLoseIt: boolean): PriorityReason | undefined {
    const data = line.data
    if (line.descriptor.balance(data)?.number === 0) return { type: 'emptyBalance' }
    if (!data.hasData || !data.isBounded) return undefined
    if (data.meterState(now) === 'spent') return { type: 'usedUp', resetsAt: data.resetsAt }
    if (data.severity !== 'normal') {
      return { type: 'low', severity: data.severity, remaining: data.remainingFraction, runway: data.runway(now) }
    }
    if (burningFast?.contains(line, now) === true) {
      const runway = data.runway(now)
      if (runway !== undefined) return { type: 'burningFast', runway }
    }
    if (!useItOrLoseIt || !PaceNotificationLogic.isUnusedNearReset(data, now) || data.resetsAt === undefined) return undefined
    return { type: 'useItOrLoseIt', resetsAt: data.resetsAt }
  },

  severity(reason: PriorityReason): MeterSeverity {
    switch (reason.type) {
      case 'low':
        return reason.severity
      case 'burningFast':
      case 'useItOrLoseIt':
        return 'normal'
      case 'usedUp':
      case 'emptyBalance':
        return 'critical'
    }
  },

  section(reason: PriorityReason): PrioritySection {
    switch (reason.type) {
      case 'low':
      case 'burningFast':
        return 'runningOut'
      case 'usedUp':
      case 'emptyBalance':
        return 'usedUp'
      case 'useItOrLoseIt':
        return 'useItOrLoseIt'
    }
  },

  /** Sorts ascending: what runs out soonest first, then what has no pace to tell by, by what's left. */
  rank(reason: PriorityReason): { tier: number; closeness: number } {
    switch (reason.type) {
      case 'low':
        return reason.runway !== undefined ? { tier: 0, closeness: reason.runway } : { tier: 1, closeness: reason.remaining }
      case 'burningFast':
        return { tier: 0, closeness: reason.runway }
      case 'usedUp':
        return { tier: 2, closeness: reason.resetsAt ?? Infinity }
      case 'emptyBalance':
        return { tier: 2, closeness: Infinity }
      case 'useItOrLoseIt':
        return { tier: 3, closeness: reason.resetsAt }
    }
  }
}

/** A limit on the board and why it is there. */
export interface PriorityItem {
  readonly provider: Provider
  readonly line: DashboardLine
  readonly reason: PriorityReason
  /** The user pinned it. A pinned item is listed under Running Out, Used Up, or Use It or Lose It instead of Pinned. */
  readonly isPinned: boolean
}

export const PriorityItem = {
  id(item: PriorityItem): string {
    return DashboardLine.id(item.line)
  },

  data(item: PriorityItem): WidgetData {
    return item.line.data
  },

  /**
   * The line under the amount of a limit listed only for burning fast, in place of its reset. A limit still
   * listed while its pace eases would run out after its reset, so it shows the reset instead.
   */
  runOutText(item: PriorityItem, now: Instant): string | undefined {
    const resetsAt = item.line.data.resetsAt
    if (item.reason.type !== 'burningFast' || resetsAt === undefined) return undefined
    if (!(item.reason.runway < secondsBetween(resetsAt, now))) return undefined
    const duration = Formatters.compactDuration(item.reason.runway)
    return duration === undefined ? undefined : `Out in ${duration}`
  },

  /** The line under the amount of a limit listed to use before it resets, in place of its reset. */
  resetsInText(item: PriorityItem, now: Instant): string | undefined {
    if (item.reason.type !== 'useItOrLoseIt') return undefined
    const duration = Formatters.compactDuration(secondsBetween(item.reason.resetsAt, now))
    return duration === undefined ? undefined : `Resets in ${duration}`
  },

  /** The trailing text of a Used Up row: the time until it resets, or for a balance, which has no reset, its amount. */
  usedUpNote(item: PriorityItem, now: Instant): string | undefined {
    if (item.reason.type !== 'emptyBalance') return DashboardRowModel.compactResetText(item.line.data, now)
    return item.line.data.unboundedDetail
  }
}

/** A metric the user pinned to the top of Priority, listed there while no other section lists it. */
export interface PinnedMetric {
  readonly provider: Provider
  readonly line: DashboardLine
}

export type PrioritySummary = 'waitingForUsage' | 'noReportedLimits' | 'unavailable' | 'allClear' | 'listed'

export type PriorityReadStatus = { type: 'waiting' } | { type: 'current' } | { type: 'unavailable'; message: string }

export interface PriorityAccountNotice {
  readonly provider: Provider
  readonly message: string
}

/** The limits that need the user, most urgent first, for the tray and the Priority tab. */
export interface PriorityBoard {
  /** In dashboard order. A pinned metric another section lists is listed only there, and comes back here once it isn't. */
  readonly pinned: PinnedMetric[]
  readonly attention: PriorityItem[]
  readonly usedUp: PriorityItem[]
  /** Limits with over half left that reset within a day, soonest reset first. On the tray only with Always Show on. */
  readonly useItOrLoseIt: PriorityItem[]
  readonly notices: PriorityAccountNotice[]
  /** Accounts with no first reading yet, in dashboard order. Each shows as a skeleton row under the rest. */
  readonly waiting: Provider[]
  readonly summary: PrioritySummary
  /** Every account reported and nothing, pinned or not, is running out. */
  readonly showsClearRow: boolean
}

export const PriorityBoard = {
  /**
   * Multiple running-low limits can change places as their windows age, even without a new reading, and a
   * limit burning fast can slow off the list.
   */
  requiresRankingClock(board: PriorityBoard, now: Instant): boolean {
    if (board.attention.some((item) => item.reason.type === 'burningFast')) return true
    return (
      board.attention.length > 1 &&
      board.attention.some((item) => {
        const { resetsAt, periodDurationMs } = item.line.data
        if (resetsAt === undefined || periodDurationMs === undefined) return false
        return resetsAt > now && periodDurationMs > 0
      })
    )
  },

  /**
   * `accounts` is in the user's saved order, which breaks every tie. `burningFast` is undefined while Settings
   * leaves limits burning fast off the list, and `useItOrLoseIt` is false while it leaves that section off.
   */
  make(options: {
    accounts: DashboardAccount[]
    pinned?: Set<string>
    burningFast?: BurningFast
    useItOrLoseIt?: boolean
    now: Instant
    status?: (account: DashboardAccount) => PriorityReadStatus
  }): PriorityBoard {
    const { accounts, now } = options
    const pinnedIDs = options.pinned ?? new Set<string>()
    const status =
      options.status ??
      ((account: DashboardAccount): PriorityReadStatus =>
        account.lines.some((line) => line.data.hasData) ? { type: 'current' } : { type: 'waiting' })

    const lines = accounts.flatMap((account) => account.lines.map((line) => ({ provider: account.provider, line })))
    const items: PriorityItem[] = []
    for (const { provider, line } of lines) {
      const reason = PriorityReason.make(line, now, options.burningFast, options.useItOrLoseIt ?? false)
      if (reason) items.push({ provider, line, reason, isPinned: pinnedIDs.has(DashboardLine.id(line)) })
    }
    const ranked = items
      .map((element, offset) => ({ element, offset, rank: PriorityReason.rank(element.reason) }))
      .sort((lhs, rhs) => lhs.rank.tier - rhs.rank.tier || compare(lhs.rank.closeness, rhs.rank.closeness) || lhs.offset - rhs.offset)
      .map((entry) => entry.element)

    const waiting: Provider[] = []
    const notices: PriorityAccountNotice[] = []
    for (const account of accounts) {
      const read = status(account)
      if (read.type === 'waiting') waiting.push(account.provider)
      else if (read.type === 'unavailable') notices.push({ provider: account.provider, message: read.message })
    }
    const awaitingUsage = accounts.length === 0 || waiting.length > 0
    let summary: PrioritySummary
    if (ranked.length > 0) summary = 'listed'
    else if (notices.length > 0) summary = 'unavailable'
    else if (awaitingUsage) summary = 'waitingForUsage'
    else if (lines.some(({ line }) => line.data.hasData && line.data.isBounded)) summary = 'allClear'
    else summary = 'noReportedLimits'

    const listed = new Set(ranked.map(PriorityItem.id))
    const inSection = (section: PrioritySection): PriorityItem[] => ranked.filter((item) => PriorityReason.section(item.reason) === section)
    return {
      pinned: lines.filter(({ line }) => pinnedIDs.has(DashboardLine.id(line)) && !listed.has(DashboardLine.id(line))),
      attention: inSection('runningOut'),
      usedUp: inSection('usedUp'),
      useItOrLoseIt: inSection('useItOrLoseIt'),
      notices,
      waiting,
      summary,
      showsClearRow: !awaitingUsage && notices.length === 0 && !ranked.some((item) => PriorityReason.section(item.reason) === 'runningOut')
    }
  },

  /** Whether the tab lists anything, pinned or not, worth copying as a picture. */
  hasRows(board: PriorityBoard): boolean {
    return board.summary === 'listed' || board.pinned.length > 0
  }
}

/** Ascending order that treats two infinities as equal, where subtraction would give NaN. */
function compare(a: number, b: number): number {
  if (a === b) return 0
  return a < b ? -1 : 1
}
