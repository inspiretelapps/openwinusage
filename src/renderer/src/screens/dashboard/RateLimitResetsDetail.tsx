import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { ZAIResetWindow, type ZAIReset } from '@core/providers/zai/ZAIResets'
import { ResetClaimOutcome } from '@core/services/ResetClaimService'
import type { Instant } from '@core/support/time'
import { Button, Spinner } from '../../components/Controls'
import { Icon } from '../../components/Icon'
import { Tooltip } from '../../components/Tooltip'
import { ResetEntry, ResetsTimeline, type ResetsContent, type ResetsWindow } from './RateLimitResetsDetail+Timeline'

const nodeHeight = 30
const confirmCardPadding = 10

/** Whether a node's key names a window's record, which a flat timeline's never does. */
function isWindowKey(keyID: string): boolean {
  return keyID.split(':').length > 2
}

export interface ResetsBanner {
  readonly text: string
  readonly icon: string
  /** A CSS color. */
  readonly tint: string
}

export function resetsBanner(outcome: ResetClaimOutcome, now: Instant = Date.now()): ResetsBanner {
  const text = ResetClaimOutcome.message(outcome, now)
  switch (outcome.type) {
    case 'success':
      return { text, icon: 'checkmark.circle.fill', tint: 'var(--green)' }
    case 'nothingToReset':
      return { text, icon: 'info.circle.fill', tint: 'var(--blue)' }
    case 'unconfirmed':
      return { text, icon: 'clock.fill', tint: 'var(--blue)' }
    case 'noCredit':
    case 'unavailableNow':
      return { text, icon: 'exclamationmark.triangle.fill', tint: 'var(--orange)' }
    case 'failed':
      return { text, icon: 'xmark.circle.fill', tint: 'var(--red)' }
  }
}

/**
 * The Limit Resets row's detail: each reset on a timeline with when it expires.
 *
 * When a `claim` closure is supplied, each node also becomes claimable: hovering a node reveals a
 * "Use" affordance, clicking it expands that node in place into an inline confirm, and confirming runs
 * the claim and shows the outcome. `claim` is undefined for any non-claimable row, which renders exactly
 * the read-only timeline. Each credit's claim carries an idempotency key (a UUID minted the first time
 * that credit enters confirm and reused for any retry), so a retried claim can never double-spend.
 */
export function RateLimitResetsDetail(props: {
  count: number
  expiries: Instant[]
  /** The detail was opened by a click: every usable node shows Use without being hovered. */
  showsActions?: boolean
  onPinChange?: (pinned: boolean) => void
  claim?: (expiry: Instant, redeemRequestID: string) => Promise<ResetClaimOutcome>
  confirmDetail?: string
  /** Resets listed per window instead of on one timeline; only each window's earliest can be used. */
  windowResets?: ZAIReset[]
  claimWindowReset?: (reset: ZAIReset, requestID: string) => Promise<ResetClaimOutcome>
}): ReactNode {
  const { count, expiries, claim, claimWindowReset, onPinChange } = props
  const windowResets = props.windowResets ?? []
  const [claimedCounts, setClaimedCounts] = useState<ReadonlyMap<Instant, number>>(new Map())
  const [claimedRecords, setClaimedRecords] = useState<ReadonlySet<number>>(new Set())
  const [confirming, setConfirming] = useState<string | undefined>(undefined)
  const [claiming, setClaiming] = useState<string | undefined>(undefined)
  const [hovered, setHovered] = useState<string | undefined>(undefined)
  const [banner, setBanner] = useState<ResetsBanner | undefined>(undefined)
  const [nothingToReset, setNothingToReset] = useState(false)
  const expiriesVersion = useRef(0)
  const redeemRequestIDs = useRef(new Map<Instant, string>())
  const windowRequestIDs = useRef(new Map<number, string>())
  const isMounted = useRef(true)
  useEffect(
    () => () => {
      isMounted.current = false
    },
    []
  )

  const claimInProgress = confirming !== undefined || claiming !== undefined
  const claimedTotal = [...claimedCounts.values()].reduce((sum, value) => sum + value, 0)
  const content: ResetsContent = ResetsTimeline.content(count - claimedTotal, ResetsTimeline.visibleExpiries(expiries, claimedCounts))
  const windows: ResetsWindow[] = ResetsTimeline.windows(windowResets.filter((reset) => !claimedRecords.has(reset.recordID)))

  const cancelConfirm = (): void => {
    setConfirming(undefined)
    onPinChange?.(false)
  }

  // A fresh reading replaces what was marked as used here, and closes a confirm whose reset is gone.
  const confirmingNow = useRef(confirming)
  confirmingNow.current = confirming
  const expiriesKey = expiries.join(',')
  const seenExpiries = useRef(expiriesKey)
  useEffect(() => {
    if (seenExpiries.current === expiriesKey) return
    seenExpiries.current = expiriesKey
    expiriesVersion.current += 1
    setClaimedCounts(new Map())
    const current = confirmingNow.current
    if (current !== undefined && !isWindowKey(current) && !ResetsTimeline.entries(expiries).some((entry) => entry.keyID === current)) cancelConfirm()
  }, [expiriesKey])

  const windowsKey = windowResets.map((reset) => `${reset.window}:${reset.recordID}:${reset.expiresAt}:${reset.grantType}`).join(',')
  const seenWindows = useRef(windowsKey)
  useEffect(() => {
    if (seenWindows.current === windowsKey) return
    seenWindows.current = windowsKey
    expiriesVersion.current += 1
    setClaimedRecords(new Set())
    const current = confirmingNow.current
    if (
      current !== undefined &&
      isWindowKey(current) &&
      !ResetsTimeline.windows(windowResets).some((window) => window.entries.some((entry) => entry.keyID === current))
    ) {
      cancelConfirm()
    }
  }, [windowsKey])

  const canUse = (entry: ResetEntry): boolean => (entry.key.reset === undefined ? claim !== undefined : claimWindowReset !== undefined && entry.id === 0)

  const beginConfirm = (entry: ResetEntry): void => {
    const reset = entry.key.reset
    if (reset !== undefined) {
      if (!windowRequestIDs.current.has(reset.recordID)) windowRequestIDs.current.set(reset.recordID, crypto.randomUUID())
    } else if (!redeemRequestIDs.current.has(entry.date)) {
      redeemRequestIDs.current.set(entry.date, crypto.randomUUID())
    }
    setBanner(undefined)
    setHovered(undefined)
    setConfirming(entry.keyID)
    onPinChange?.(true)
  }

  const markClaimed = (date: Instant, record: number | undefined): void => {
    if (record !== undefined) setClaimedRecords((current) => new Set(current).add(record))
    else setClaimedCounts((current) => new Map(current).set(date, (current.get(date) ?? 0) + 1))
  }

  const apply = (outcome: ResetClaimOutcome, date: Instant, record: number | undefined, refreshed: boolean): void => {
    switch (outcome.type) {
      case 'success':
        if (!refreshed) markClaimed(date, record)
        if (record === undefined) setNothingToReset(true)
        break
      case 'nothingToReset':
        setNothingToReset(true)
        break
      case 'noCredit':
        if (!refreshed) markClaimed(date, record)
        break
      case 'unconfirmed':
      case 'unavailableNow':
      case 'failed':
        break
    }
    setBanner(resetsBanner(outcome))
  }

  const runClaim = (entry: ResetEntry): void => {
    const reset = entry.key.reset
    let send: () => Promise<ResetClaimOutcome>
    if (reset !== undefined && claimWindowReset) {
      const requestID = windowRequestIDs.current.get(reset.recordID) ?? crypto.randomUUID()
      send = () => claimWindowReset(reset, requestID)
    } else if (claim) {
      const redeemRequestID = redeemRequestIDs.current.get(entry.date) ?? crypto.randomUUID()
      send = () => claim(entry.date, redeemRequestID)
    } else {
      return
    }
    setConfirming(undefined)
    setClaiming(entry.keyID)
    const versionAtClaim = expiriesVersion.current
    void send()
      .catch((): ResetClaimOutcome => ResetClaimOutcome.failed('refused'))
      .then((outcome) => {
        if (isMounted.current) {
          setClaiming(undefined)
          apply(outcome, entry.date, reset?.recordID, expiriesVersion.current !== versionAtClaim)
        }
        onPinChange?.(false)
      })
  }

  const numberedDot = (entry: ResetEntry): ReactNode => (
    <span className={`rr-dot is-${entry.severity}`} aria-hidden>
      {entry.number}
    </span>
  )

  const trailing = (entry: ResetEntry): ReactNode => {
    if (canUse(entry) && ((props.showsActions ?? false) || hovered === entry.keyID) && !claimInProgress) {
      return (
        <Tooltip text={nothingToReset ? 'Nothing to reset right now' : undefined}>
          <span className="rr-use">
            <Button size="small" disabled={nothingToReset} onClick={() => beginConfirm(entry)}>
              Use
            </Button>
          </span>
        </Tooltip>
      )
    }
    if (entry.countdown !== undefined) return <span className="rr-countdown secondary mono-digits">{entry.countdown}</span>
    return null
  }

  const row = (entry: ResetEntry): ReactNode => (
    <div
      className="rr-row"
      role="group"
      aria-label={ResetEntry.accessibilityLabel(entry)}
      style={claimInProgress ? { opacity: 0.45, pointerEvents: 'none' } : undefined}
      onPointerEnter={() => setHovered(entry.keyID)}
      onPointerLeave={() => setHovered((current) => (current === entry.keyID ? undefined : current))}
    >
      <span className="rr-time truncate">{entry.time}</span>
      <span className="rr-spacer" />
      {trailing(entry)}
    </div>
  )

  const confirmRow = (entry: ResetEntry): ReactNode => (
    <div className="rr-confirm">
      <div className="rr-confirm-title">Use this reset?</div>
      <div className="rr-confirm-detail secondary">
        {entry.key.reset !== undefined
          ? ZAIResetWindow.confirmDetail(entry.key.reset.window)
          : (props.confirmDetail ?? "Immediately reset your usage limits. This can't be undone.")}
      </div>
      <div className="rr-confirm-buttons">
        <Button variant="prominent" size="small" fullWidth onClick={() => runClaim(entry)}>
          Reset
        </Button>
        <Button variant="bordered" size="small" fullWidth onClick={cancelConfirm}>
          Cancel
        </Button>
      </div>
    </div>
  )

  const claimingRow = (): ReactNode => (
    <div className="rr-row">
      <span className="rr-time secondary">Resetting your usage…</span>
      <span className="rr-spacer" />
      <Spinner size={16} />
    </div>
  )

  const node = (entry: ResetEntry): ReactNode => {
    if (confirming === entry.keyID) return confirmRow(entry)
    if (claiming === entry.keyID) return claimingRow()
    return row(entry)
  }

  const timeline = (entries: ResetEntry[]): ReactNode => (
    <div className="rr-timeline">
      {entries.map((entry) => {
        const isFirst = entry.id === 0
        const isLast = entry.id === entries.length - 1
        const dotCenterY = confirming === entry.keyID ? confirmCardPadding + 9 : nodeHeight / 2
        return (
          <div key={entry.keyID} className="rr-entry">
            {/* The connector rail runs unbroken through the dot and, on a tall confirm node, down to the next node. */}
            <div className="rr-rail" aria-hidden>
              <span className="rr-rail-line" style={{ height: dotCenterY, flex: 'none', opacity: isFirst ? 0 : 1 }} />
              <span className="rr-rail-line" style={{ flex: 1, opacity: isLast ? 0 : 1 }} />
              <span className="rr-dot-slot" style={{ top: dotCenterY - 9 }}>
                {numberedDot(entry)}
              </span>
            </div>
            <div className="rr-node">{node(entry)}</div>
          </div>
        )
      })}
    </div>
  )

  const emptyState = (
    <div className="rr-state">
      <Icon name="clock.badge.xmark" size={20} className="secondary" />
      <div className="rr-callout secondary">You have no rate limit resets</div>
    </div>
  )

  const unknownExpiriesState = (available: number): ReactNode => (
    <div className="rr-state">
      <Icon name="clock.badge.questionmark" size={20} className="secondary" />
      <div className="rr-callout">{available} available</div>
      <div className="secondary" style={{ fontSize: 11 }}>
        Expiry times unavailable
      </div>
    </div>
  )

  let body: ReactNode
  if (windowResets.length > 0) {
    const claimingIsListed = claiming !== undefined && windows.some((window) => window.entries.some((entry) => entry.keyID === claiming))
    body = (
      <>
        {claiming !== undefined && !claimingIsListed ? claimingRow() : null}
        {windows.map((window) => (
          <div key={window.window} className="rr-window">
            <div className="rr-window-title secondary">{ZAIResetWindow.title(window.window)}</div>
            {timeline(window.entries)}
          </div>
        ))}
      </>
    )
  } else if (claiming !== undefined && !ResetsTimeline.contentEntries(content).some((entry) => entry.keyID === claiming)) {
    body = (
      <>
        {claimingRow()}
        {content.type === 'timeline' ? timeline(content.entries) : null}
      </>
    )
  } else if (content.type === 'timeline') {
    body = timeline(content.entries)
  } else if (content.type === 'unknownExpiries') {
    body = unknownExpiriesState(content.count)
  } else {
    body = emptyState
  }

  return (
    <div className="rr-detail">
      {banner ? (
        <div className="rr-banner" style={{ color: banner.tint, background: `color-mix(in srgb, ${banner.tint} 12%, transparent)` }}>
          <Icon name={banner.icon} size={14} filled className="db-symbol-knockout" style={{ '--knockout': 'var(--popover)' } as CSSProperties} />
          <span>{banner.text}</span>
        </div>
      ) : null}
      {body}
    </div>
  )
}
