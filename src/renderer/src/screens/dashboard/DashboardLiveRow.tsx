import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { DashboardLine } from '@core/models/DashboardFamilies'
import { DashboardRowModel } from '@core/models/DashboardRowModel'
import type { Provider } from '@core/models/Provider'
import type { ModelFigure, UsageBreakdown } from '@core/models/UsageHistory'
import { ResetClaimOutcome } from '@core/services/ResetClaimService'
import type { Instant } from '@core/support/time'
import type { ResetClaimInfo } from '@shared/ipc'
import { api } from '../../bridge'
import { useObservable, usePopover, useReduceAnimations } from '../../state/context'
import { DashboardMetricRow } from './DashboardMetricRow'
import type { AccountStatus } from './DashboardProviderSection'
import { HoverPopoverState } from './HoverPopoverState'
import { MotionAwareHoverPopover } from './MotionAwareHoverPopover'
import { RateLimitResetsDetail } from './RateLimitResetsDetail'
import { UsageBreakdownDetail } from './UsageBreakdownDetail'

/** A row of the live dashboard: its amount and reset can be clicked, and its figure may open a detail. */
export function DashboardLiveRow(props: {
  line: DashboardLine
  now: Instant
  /** What the account can do with its rate-limit resets, when it has any to spend. */
  resetClaim?: ResetClaimInfo
  breakdown?: UsageBreakdown
  accountStatus: AccountStatus
  snapshotDate?: Instant
  modelFigure: ModelFigure
  onPickModelFigure: (figure: ModelFigure) => void
  onCopyBreakdown: (provider: Provider, breakdown: UsageBreakdown, figure: ModelFigure) => Promise<boolean>
  onToggleMeterStyle?: () => void
  onToggleResetDisplay?: () => void
}): ReactNode {
  const { line, now, resetClaim } = props
  const { data, descriptor } = line
  const reduceAnimations = useReduceAnimations()
  const provider: Provider = { id: descriptor.providerID, kind: descriptor.providerKind }
  const historyRow = descriptor.historyRow

  let figure: ((figure: ReactNode) => ReactNode) | undefined
  if (data.showsResetExpiries) {
    const providerID = descriptor.providerID
    figure = (inline) => (
      <HoverTrigger
        figure={inline}
        detail={(hover) => (
          <RateLimitResetsDetail
            count={data.resetCreditCount}
            expiries={data.expiriesAt}
            showsActions={hover.openedExplicitly}
            onPinChange={(pinned) => hover.setPinned(pinned)}
            claim={
              resetClaim?.isClaimable
                ? (expiry, redeemRequestID) => api.resetClaim(providerID, expiry, redeemRequestID).catch(() => ResetClaimOutcome.failed('refused'))
                : undefined
            }
            confirmDetail={resetClaim?.confirmDetail}
            windowResets={resetClaim?.windowResets ?? []}
            claimWindowReset={
              resetClaim
                ? (reset, requestID) => api.resetClaimWindow(providerID, reset, requestID).catch(() => ResetClaimOutcome.failed('refused'))
                : undefined
            }
          />
        )}
      />
    )
  } else if (historyRow?.type === 'window') {
    const window = historyRow.window
    figure = (inline) => (
      <HoverTrigger
        figure={inline}
        detail={() => (
          <UsageBreakdownDetail
            content={
              props.breakdown
                ? { type: 'reported', breakdown: props.breakdown }
                : { type: 'saved', window, figures: data.unboundedFigures, status: props.accountStatus, date: props.snapshotDate }
            }
            provider={provider}
            animates={!reduceAnimations}
            figure={props.modelFigure}
            onPickFigure={props.onPickModelFigure}
            onCopy={(breakdown, shown) => props.onCopyBreakdown(provider, breakdown, shown)}
          />
        )}
      />
    )
  }

  return (
    <DashboardMetricRow
      model={DashboardRowModel.make(data, now)}
      onToggleMeterStyle={data.hasMeterStyleToggle ? props.onToggleMeterStyle : undefined}
      onToggleResetDisplay={props.onToggleResetDisplay}
      paceTooltip={data.paceTooltip(now)}
      valueTooltip={DashboardRowModel.meterStyleTooltip(data)}
      resetTooltip={DashboardRowModel.resetTooltip(data, now)}
      figure={figure}
    />
  )
}

/**
 * A figure that previews its detail on hover and keeps it open on a click, or on Space while it has
 * the keyboard focus.
 */
function HoverTrigger(props: { figure: ReactNode; detail: (hover: HoverPopoverState) => ReactNode }): ReactNode {
  const [state] = useState(() => new HoverPopoverState())
  const hover = useObservable(state)
  const popover = usePopover()
  const anchor = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    hover.attach()
    return () => hover.detach()
  }, [hover])
  // The dashboard outlives its panel being hidden, so closing the panel must close the detail too.
  const panelShown = popover.popoverShown
  useEffect(() => {
    if (!panelShown) hover.dismiss()
  }, [panelShown, hover])
  const lit = hover.overInline || hover.isPresented
  return (
    <>
      <button
        ref={anchor}
        type="button"
        className={`plain-button hover-highlight db-figure-trigger${lit ? ' is-lit' : ''}`}
        aria-description="Show details"
        aria-expanded={hover.isPresented}
        onClick={() => hover.openDetails()}
        onPointerEnter={() => hover.inlineHover(true)}
        onPointerLeave={() => hover.inlineHover(false)}
      >
        {props.figure}
      </button>
      {hover.isPresented ? (
        <MotionAwareHoverPopover anchor={anchor} onDismiss={() => hover.dismiss()} onHoverChange={(inside) => hover.detailHover(inside)}>
          {props.detail(hover)}
        </MotionAwareHoverPopover>
      ) : null}
    </>
  )
}
