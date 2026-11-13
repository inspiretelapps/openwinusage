import { useId, type ReactNode } from 'react'
import { DashboardLine } from '@core/models/DashboardFamilies'
import { DashboardRowModel } from '@core/models/DashboardRowModel'
import { PriorityItem, PriorityReason, type PriorityAccountNotice, type PriorityBoard } from '@core/models/PriorityBoard'
import { Provider } from '@core/models/Provider'
import { ResetDisplayMode } from '@core/models/ResetDisplayMode'
import type { MeterSeverity, WidgetData } from '@core/models/WidgetData'
import { WidgetDisplayMode } from '@core/models/WidgetDisplayMode'
import { DisplaySettingKeys } from '@core/stores/WidgetDataStore'
import type { Instant } from '@core/support/time'
import { api } from '../../bridge'
import { Button } from '../../components/Controls'
import { Icon } from '../../components/Icon'
import { ProviderIcon } from '../../components/ProviderIcon'
import { useNow, usePopover, useStores } from '../../state/context'
import { TruncatedText, concealingAccountName } from '../AccountNameConcealment'
import { DashboardMenus, showDashboardMenu, type DashboardCommand } from './DashboardMenus'
import './dashboard.css'

/** The Priority tab: only what needs the user, most urgent first. Its countdowns and ranking follow the clock. */
export function PriorityDashboardView(): ReactNode {
  const stores = useStores()
  const popover = usePopover()
  const now = useNow(30)
  const { layout, data } = stores
  return (
    <PriorityBoardList
      board={data.priorityBoard(layout.displayGroups, layout.state.priorityPinIDs, now)}
      now={now}
      onToggleMeterStyle={() => void api.setSetting(DisplaySettingKeys.meterStyle, WidgetDisplayMode.toggled(data.meterStyle))}
      onToggleResetDisplay={() => void api.setSetting(DisplaySettingKeys.resetDisplayMode, ResetDisplayMode.toggled(data.resetDisplayMode))}
      onShowAllUsage={() => (popover.dashboardTab = 'allUsage')}
      onFixAccount={(providerID) => popover.openAccounts(providerID)}
      onMetricCommand={(command) => {
        if (command.type === 'setPinned') void api.layoutSetMetricPinned(command.metricID, command.pinned)
        else if (command.type === 'hide') void api.layoutSetMetricShown(command.metricID, false)
      }}
    />
  )
}

const gaugeSide = 32

/** The board's sections. Every handler is left out where nothing can be clicked, as in a picture. */
export function PriorityBoardList(props: {
  board: PriorityBoard
  now: Instant
  onToggleMeterStyle?: () => void
  onToggleResetDisplay?: () => void
  onShowAllUsage?: () => void
  onFixAccount?: (providerID: string) => void
  onMetricCommand?: (command: DashboardCommand) => void
}): ReactNode {
  const { board, now, onMetricCommand } = props

  const metricMenu = (metricID: string, pinned: boolean): ((event: React.MouseEvent) => void) | undefined => {
    if (!onMetricCommand) return undefined
    return (event) => {
      event.preventDefault()
      event.stopPropagation()
      void showDashboardMenu([DashboardMenus.metric(metricID, pinned)], onMetricCommand)
    }
  }

  const sectionLabel = (title: string): ReactNode => (
    <div className="pr-section-label" role="heading" aria-level={2}>
      {title}
    </div>
  )

  /** Flips a reading the way a click on it does in All Usage. */
  const toggling = (action: (() => void) | undefined, label: ReactNode): ReactNode =>
    action ? (
      <button type="button" className="plain-button" onClick={action}>
        {label}
      </button>
    ) : (
      label
    )

  const accountName = (provider: Provider, className: string): ReactNode => (
    <span className={`${className} ${concealingAccountName(provider)}`}>
      <TruncatedText text={Provider.accountName(provider)} mode={Provider.isNamedByEmail(provider) ? 'middle' : 'tail'} title={Provider.fullName(provider)} />
    </span>
  )

  /**
   * `callout` takes the reset's place: when a limit listed only for burning fast runs out, or when one
   * listed to use it or lose it resets.
   */
  const limitRow = (
    key: string,
    provider: Provider,
    data: WidgetData,
    severity: MeterSeverity,
    menu: ((event: React.MouseEvent) => void) | undefined,
    callout?: { text: string; color: string }
  ): ReactNode => {
    const reset = callout ? undefined : DashboardRowModel.compactResetText(data, now)
    return (
      <div key={key} className="pr-limit-row" onContextMenu={menu}>
        <PriorityGauge fraction={data.fraction} severity={severity} icon={Provider.icon(provider)} paceMark={data.paceMark(now)} />
        <div className="pr-titles">
          <span className="pr-title truncate">{data.title}</span>
          {accountName(provider, 'pr-account')}
        </div>
        <span className="pr-spacer" />
        <div className="pr-trailing">
          {toggling(data.hasMeterStyleToggle ? props.onToggleMeterStyle : undefined, <span className="pr-amount mono-digits">{DashboardRowModel.amountText(data)}</span>)}
          {callout ? (
            <span className="pr-callout mono-digits" style={{ color: callout.color }}>
              {callout.text}
            </span>
          ) : reset !== undefined ? (
            toggling(props.onToggleResetDisplay, <span className="pr-reset mono-digits">{reset}</span>)
          ) : null}
        </div>
      </div>
    )
  }

  const usedUpRow = (item: PriorityItem): ReactNode => {
    const data = PriorityItem.data(item)
    const note = PriorityItem.usedUpNote(item, now)
    return (
      <div key={PriorityItem.id(item)} className="pr-compact-row" onContextMenu={metricMenu(PriorityItem.id(item), item.isPinned)}>
        <span className="pr-compact-icon">
          <ProviderIcon id={Provider.icon(item.provider)} side={15} inset={0.04} />
        </span>
        <div className="pr-compact-titles">
          <span className="pr-compact-title">{data.title}</span>
          {accountName(item.provider, 'pr-account')}
        </div>
        <span className="pr-spacer" />
        {note !== undefined
          ? toggling(data.resetsAt === undefined ? undefined : props.onToggleResetDisplay, <span className="pr-note mono-digits">{note}</span>)
          : null}
      </div>
    )
  }

  const noticeRow = (notice: PriorityAccountNotice): ReactNode => {
    const account = Provider.labelBesideName(notice.provider)
    const { onFixAccount } = props
    return (
      <div key={notice.provider.id} className="pr-compact-row" role="group" aria-description={notice.message}>
        <span className="pr-compact-icon">
          <ProviderIcon id={Provider.icon(notice.provider)} side={15} inset={0.04} />
        </span>
        <div className="pr-compact-titles">
          <span className="pr-notice-name">{Provider.displayName(notice.provider)}</span>
          {account !== undefined ? (
            <span className={`pr-account ${concealingAccountName(notice.provider)}`}>
              <TruncatedText text={account} mode={Provider.isNamedByEmail(notice.provider) ? 'middle' : 'tail'} />
            </span>
          ) : null}
        </div>
        <span className="pr-spacer" />
        {onFixAccount ? (
          <Button size="small" onClick={() => onFixAccount(notice.provider.id)}>
            Fix
          </Button>
        ) : null}
      </div>
    )
  }

  const accountNotices = (
    <div className="pr-section">
      <div className="pr-notices-label">
        {sectionLabel('Needs Attention')}
        <Icon name="exclamationmark.triangle.fill" size={10} weight="semibold" filled className="db-symbol-knockout pr-notices-glyph" />
      </div>
      {board.notices.map(noticeRow)}
    </div>
  )

  const clearRow = (
    <div className="pr-limit-row" role="group">
      <span className="pr-clear-mark" aria-hidden>
        <Icon name="checkmark" size={13} weight="semibold" />
      </span>
      <div className="pr-titles">
        <span className="pr-title">All Clear</span>
        <span className="pr-account">Nothing is running out.</span>
      </div>
    </div>
  )

  let summary: ReactNode = null
  switch (board.summary) {
    case 'waitingForUsage':
      break
    case 'noReportedLimits':
      summary = (
        <div className="pr-no-limits">
          <span className="pr-title">No Reported Limits</span>
          {props.onShowAllUsage ? (
            <button type="button" className="plain-button pr-link" onClick={props.onShowAllUsage}>
              View All Usage
            </button>
          ) : null}
        </div>
      )
      break
    case 'unavailable':
      summary = accountNotices
      break
    case 'allClear':
    case 'listed':
      summary = (
        <div className="pr-list">
          {board.attention.length > 0 || board.showsClearRow ? (
            <div className="pr-section">
              {sectionLabel('Running Out')}
              {board.attention.length === 0 ? clearRow : null}
              {board.attention.map((item) => {
                const runOut = PriorityItem.runOutText(item, now)
                return limitRow(
                  PriorityItem.id(item),
                  item.provider,
                  PriorityItem.data(item),
                  PriorityReason.severity(item.reason),
                  metricMenu(PriorityItem.id(item), item.isPinned),
                  runOut !== undefined ? { text: runOut, color: 'var(--orange-text)' } : undefined
                )
              })}
            </div>
          ) : null}
          {board.useItOrLoseIt.length > 0 ? (
            <div className="pr-section">
              {sectionLabel('Use It or Lose It')}
              {board.useItOrLoseIt.map((item) => {
                const resetsIn = PriorityItem.resetsInText(item, now)
                return limitRow(
                  PriorityItem.id(item),
                  item.provider,
                  PriorityItem.data(item),
                  PriorityReason.severity(item.reason),
                  metricMenu(PriorityItem.id(item), item.isPinned),
                  resetsIn !== undefined ? { text: resetsIn, color: 'var(--blue)' } : undefined
                )
              })}
            </div>
          ) : null}
          {board.notices.length > 0 ? accountNotices : null}
        </div>
      )
      break
  }

  return (
    <div className="pr-list">
      {board.pinned.length > 0 ? (
        <div className="pr-section">
          {sectionLabel('Pinned')}
          {board.pinned.map((pin) => {
            const id = DashboardLine.id(pin.line)
            return limitRow(id, pin.provider, pin.line.data, 'normal', metricMenu(id, true))
          })}
        </div>
      ) : null}
      {summary}
      {board.waiting.length > 0 ? (
        // One row per account still waiting, shaped like the rows that replace it. The gauge is a plain
        // disc, since nothing says yet which limit will show there.
        <div className="pr-section">
          {board.waiting.map((provider) => (
            <div key={provider.id} className="pr-limit-row skeleton" role="img" aria-label="Waiting for Usage" aria-description={Provider.fullName(provider)}>
              <span className="skeleton-shape" style={{ width: gaugeSide, height: gaugeSide, borderRadius: '50%', flex: 'none' }} />
              <div className="pr-skeleton-lines">
                <span className="skeleton-shape db-capsule" style={{ width: 84, height: 9 }} />
                <span className="skeleton-shape db-capsule" style={{ width: 56, height: 7 }} />
              </div>
              <span className="pr-spacer" />
              <div className="pr-skeleton-lines is-trailing">
                <span className="skeleton-shape db-capsule" style={{ width: 48, height: 9 }} />
                <span className="skeleton-shape db-capsule" style={{ width: 32, height: 7 }} />
              </div>
            </div>
          ))}
        </div>
      ) : null}
      {board.usedUp.length > 0 ? (
        <div className="pr-section" style={{ opacity: 0.5 }}>
          {sectionLabel('Used Up')}
          {board.usedUp.map(usedUpRow)}
        </div>
      ) : null}
    </div>
  )
}

const lineWidth = 3

/**
 * A limit's bar as a ring around its provider's mark, filling the same way under Used or Left, with a
 * tick where it would be at an even pace.
 */
function PriorityGauge(props: { fraction: number; severity: MeterSeverity; icon: string; paceMark?: number }): ReactNode {
  const maskID = useId()
  const center = gaugeSide / 2
  const radius = center - lineWidth / 2
  const circumference = 2 * Math.PI * radius
  const fraction = Math.min(Math.max(props.fraction, 0), 1)
  // A short stroke across the ring's track, clockwise from 12 o'clock by `paceMark` of a turn.
  let tick: { x1: number; y1: number; x2: number; y2: number } | undefined
  if (props.paceMark !== undefined) {
    const angle = props.paceMark * 2 * Math.PI
    const point = (distance: number): { x: number; y: number } => ({ x: center + distance * Math.sin(angle), y: center - distance * Math.cos(angle) })
    const inner = point(center - 4.25)
    const outer = point(center + 0.75)
    tick = { x1: inner.x, y1: inner.y, x2: outer.x, y2: outer.y }
  }
  return (
    <span className="pr-gauge" aria-hidden>
      <svg width={gaugeSide} height={gaugeSide} viewBox={`0 0 ${gaugeSide} ${gaugeSide}`} style={{ overflow: 'visible' }}>
        {tick ? (
          <mask id={maskID} maskUnits="userSpaceOnUse" x={-2} y={-2} width={gaugeSide + 4} height={gaugeSide + 4}>
            <rect x={-2} y={-2} width={gaugeSide + 4} height={gaugeSide + 4} fill="#fff" />
            <line {...tick} stroke="#000" strokeWidth={3.5} strokeLinecap="round" />
          </mask>
        ) : null}
        <g mask={tick ? `url(#${maskID})` : undefined} fill="none" strokeWidth={lineWidth}>
          <circle cx={center} cy={center} r={radius} stroke="var(--meter-track)" />
          {fraction > 0 ? (
            <circle
              cx={center}
              cy={center}
              r={radius}
              className={`pr-gauge-fill is-${props.severity}`}
              strokeLinecap="round"
              strokeDasharray={`${circumference * fraction} ${circumference}`}
              transform={`rotate(-90 ${center} ${center})`}
            />
          ) : null}
        </g>
        {tick ? <line {...tick} stroke="var(--pace-mark)" strokeWidth={1.5} strokeLinecap="round" /> : null}
      </svg>
      <ProviderIcon id={props.icon} side={16} inset={0.04} style={{ position: 'absolute', left: 8, top: 8 }} />
    </span>
  )
}
