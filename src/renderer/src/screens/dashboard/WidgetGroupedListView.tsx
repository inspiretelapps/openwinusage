import { useEffect, useRef, useState, type ReactNode } from 'react'
import { flushSync } from 'react-dom'
import { DashboardAccount, DashboardLine, type DashboardFamily } from '@core/models/DashboardFamilies'
import { DashboardRowModel } from '@core/models/DashboardRowModel'
import type { Provider } from '@core/models/Provider'
import { ResetDisplayMode } from '@core/models/ResetDisplayMode'
import { ModelFigure, type UsageBreakdown } from '@core/models/UsageHistory'
import { WidgetDisplayMode } from '@core/models/WidgetDisplayMode'
import { LayoutStore } from '@core/stores/LayoutStore'
import { LayoutState } from '@core/stores/LayoutStoreModels'
import { DisplaySettingKeys } from '@core/stores/WidgetDataStore'
import { MemoryDefaults, defaultsEnum } from '@core/support/Defaults'
import { api } from '../../bridge'
import { useNow, usePopover, useRenaming, useStores } from '../../state/context'
import type { Stores } from '../../state/stores'
import { DashboardGrid, DashboardLineStack } from './DashboardGrid'
import { DashboardLiveRow } from './DashboardLiveRow'
import { DashboardMenus, showDashboardMenu, type DashboardCommand, type DashboardMenuSections } from './DashboardMenus'
import { DashboardMetricRow } from './DashboardMetricRow'
import { AccountStatus, DashboardAccountCaption, DashboardAccountRows, DashboardProviderHeader, DashboardProviderSection } from './DashboardProviderSection'
import { ReorderLiftPreview, beginReorderDrag, useReorderAnimation, type ReorderLift } from './ReorderGeometry'
import { copyProviderShareCard, copyUsageBreakdownShareCard } from './share'
import './dashboard.css'

function familyFrameID(familyID: string): string {
  return `family:${familyID}`
}

/**
 * The layout as the list shows it. A drag moves things here at once, with the app's own reorder code
 * on a private copy of the layout, and sends the same move to the app; the copy is dropped once the
 * app's state has caught up.
 */
function useOptimisticLayout(stores: Stores): {
  layout: LayoutStore
  move: (change: (layout: LayoutStore) => boolean, commit: () => Promise<unknown>) => boolean
} {
  const current = useRef(stores)
  const ahead = useRef<LayoutStore | undefined>(undefined)
  const pending = useRef(0)
  const giveUp = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const [, setTick] = useState(0)

  if (current.current !== stores) {
    current.current = stores
    if (ahead.current && (pending.current === 0 || LayoutState.equal(ahead.current.state, stores.layout.state))) ahead.current = undefined
  }
  useEffect(
    () => () => {
      if (giveUp.current !== undefined) clearTimeout(giveUp.current)
    },
    []
  )

  const settle = (): void => {
    pending.current -= 1
    if (pending.current > 0 || !ahead.current) return
    const drop = (): void => {
      giveUp.current = undefined
      if (pending.current > 0) return
      ahead.current = undefined
      setTick((tick) => tick + 1)
    }
    if (LayoutState.equal(ahead.current.state, current.current.layout.state)) drop()
    else giveUp.current = setTimeout(drop, 1500)
  }

  const move = (change: (layout: LayoutStore) => boolean, commit: () => Promise<unknown>): boolean => {
    const live = current.current
    const layout = ahead.current ?? new LayoutStore(live.registry, new MemoryDefaults(live.state.defaults))
    if (!change(layout)) return false
    ahead.current = layout
    pending.current += 1
    if (giveUp.current !== undefined) clearTimeout(giveUp.current)
    giveUp.current = undefined
    // The drag reads the new order and the rows' new frames on its very next pointer move.
    flushSync(() => setTick((tick) => tick + 1))
    void commit()
      .catch(() => undefined)
      .then(settle)
    return true
  }

  return { layout: ahead.current ?? stores.layout, move }
}

/** The All Usage tab: one card per provider, each account's metrics inside, all of it reorderable by dragging. */
export function WidgetGroupedListView(): ReactNode {
  const stores = useStores()
  const popover = usePopover()
  const renaming = useRenaming()
  const now = useNow(30)
  const { data, state } = stores
  const { layout, move } = useOptimisticLayout(stores)

  const root = useRef<HTMLDivElement>(null)
  const [reorderLift, setReorderLift] = useState<ReorderLift | undefined>(undefined)
  const [activeMetricID, setActiveMetricID] = useState<string | undefined>(undefined)
  const [activeAccountID, setActiveAccountID] = useState<string | undefined>(undefined)
  const [activeFamilyID, setActiveFamilyID] = useState<string | undefined>(undefined)
  const [modelFigure, setModelFigure] = useState<ModelFigure>(() => defaultsEnum(stores.defaults, ModelFigure.key, ModelFigure.allCases, 'cost'))

  const families = data.families(layout.displayGroups)
  /** What the drag in flight reads: the order as of the latest render. */
  const liveFamilies = useRef(families)
  liveFamilies.current = families
  const liveLayout = useRef(layout)
  liveLayout.current = layout

  useReorderAnimation(
    root,
    families.flatMap((family) => [
      familyFrameID(family.id),
      ...family.accounts.flatMap((account) => [DashboardAccount.id(account), ...account.lines.map(DashboardLine.id)])
    ])
  )

  // A lift never outlives the screen it started on.
  const panelShown = popover.popoverShown
  useEffect(() => {
    if (!panelShown) setReorderLift(undefined)
  }, [panelShown])

  const plans = (family: DashboardFamily): Record<string, string> => {
    const result: Record<string, string> = {}
    for (const account of family.accounts) {
      const plan = data.plan(DashboardAccount.id(account))
      if (plan !== undefined) result[DashboardAccount.id(account)] = plan
    }
    return result
  }

  const status = (accountID: string): AccountStatus => ({
    refreshing: state.refreshingProviderIDs.includes(accountID),
    notice: data.notice(accountID),
    staleness: data.stalenessHint(accountID),
    onFix: () => popover.openAccounts(accountID)
  })

  const shareScreenshot = async (accountIDs: string[]): Promise<boolean> => {
    const copied = await copyProviderShareCard(stores, accountIDs, liveLayout.current.displayGroups)
    if (copied) popover.shareNotice.present(true)
    return copied
  }

  const perform = (command: DashboardCommand): void => {
    switch (command.type) {
      case 'refresh':
        void api.refreshProviders(command.accountIDs)
        break
      case 'manageAccounts':
        popover.openAccounts(undefined)
        break
      case 'open':
        void api.openExternal(command.url)
        break
      case 'rename':
        renaming.begin(command.accountID)
        break
      case 'editAccount':
        popover.openAccounts(command.accountID)
        break
      case 'shareScreenshot':
        void shareScreenshot(command.accountIDs)
        break
      case 'setPinned':
        void api.layoutSetMetricPinned(command.metricID, command.pinned)
        break
      case 'hide':
        void api.layoutSetMetricShown(command.metricID, false)
        break
    }
  }

  /** The innermost menu wins: a metric's, then its account's, then the provider's. */
  const contextMenu = (sections: () => DashboardMenuSections) => (event: React.MouseEvent<HTMLElement>) => {
    event.preventDefault()
    event.stopPropagation()
    void showDashboardMenu(sections(), perform)
  }

  const copyBreakdown = (provider: Provider, breakdown: UsageBreakdown, figure: ModelFigure, name: string): Promise<boolean> =>
    copyUsageBreakdownShareCard(stores, provider, breakdown, figure, name)

  const pickModelFigure = (figure: ModelFigure): void => {
    setModelFigure(figure)
    void api.setSetting(ModelFigure.key, figure).catch(() => undefined)
  }

  const visibleLineIDs = (accountID: string): string[] =>
    liveFamilies.current
      .flatMap((family) => family.accounts)
      .find((account) => DashboardAccount.id(account) === accountID)
      ?.lines.map(DashboardLine.id) ?? []

  const metricDrag = (line: DashboardLine, accountID: string) => (event: React.PointerEvent<HTMLElement>) => {
    const id = DashboardLine.id(line)
    beginReorderDrag(event, {
      id,
      root: root.current,
      setActive: setActiveMetricID,
      setLift: setReorderLift,
      makePreview: () => (
        <div className="card db-lifted-row" style={{ padding: `0 ${DashboardGrid.cardPadding}px` }}>
          <DashboardMetricRow model={DashboardRowModel.make(line.data)} />
        </div>
      ),
      orderedIDs: () => visibleLineIDs(accountID),
      reorder: (target) =>
        move(
          (ahead) => ahead.reorderMetric(id, target, accountID),
          () => api.layoutReorderMetric(id, target, accountID)
        )
    })
  }

  const accountDrag = (account: DashboardAccount, family: DashboardFamily) => (event: React.PointerEvent<HTMLElement>) => {
    const id = DashboardAccount.id(account)
    beginReorderDrag(event, {
      id,
      root: root.current,
      setActive: setActiveAccountID,
      setLift: setReorderLift,
      makePreview: () => (
        <div className="card db-lifted-row" style={{ padding: DashboardGrid.cardPadding }}>
          <DashboardAccountRows account={account} plan={data.plan(id)} hasSiblingAccounts={family.accounts.length > 1} />
        </div>
      ),
      orderedIDs: () => liveFamilies.current.find((candidate) => candidate.id === family.id)?.accounts.map(DashboardAccount.id) ?? [],
      reorder: (target) =>
        move(
          (ahead) => ahead.reorderProvider(id, target),
          () => api.layoutReorderProvider(id, target)
        )
    })
  }

  const familyDrag = (family: DashboardFamily) => (event: React.PointerEvent<HTMLElement>) => {
    const frameID = familyFrameID(family.id)
    beginReorderDrag(event, {
      id: frameID,
      root: root.current,
      setActive: setActiveFamilyID,
      setLift: setReorderLift,
      makePreview: () => {
        const familyPlans = plans(family)
        return (
          <DashboardProviderSection
            family={family}
            account={(account) => (
              <DashboardAccountRows
                key={DashboardAccount.id(account)}
                account={account}
                plan={familyPlans[DashboardAccount.id(account)]}
                hasSiblingAccounts={family.accounts.length > 1}
              />
            )}
          />
        )
      },
      orderedIDs: () => liveFamilies.current.map((candidate) => familyFrameID(candidate.id)),
      reorder: (target) => {
        const targetID = target.slice('family:'.length)
        return move(
          (ahead) => ahead.reorderFamily(family.id, targetID),
          () => api.layoutReorderFamily(family.id, targetID)
        )
      }
    })
  }

  const rows = (account: DashboardAccount, accountStatus: AccountStatus): ReactNode => {
    const accountID = DashboardAccount.id(account)
    const statusText = accountStatus.notice ?? accountStatus.staleness
    return (
      <DashboardLineStack
        account={account}
        row={(line) => {
          const id = DashboardLine.id(line)
          return (
            <div
              key={id}
              className="db-live-row"
              data-reorder-id={id}
              style={activeMetricID === id ? { opacity: 0 } : undefined}
              onPointerDown={metricDrag(line, accountID)}
              onContextMenu={contextMenu(() => [DashboardMenus.metric(id, layout.isMetricPinned(id)), ...DashboardMenus.account(account, statusText)])}
            >
              <DashboardLiveRow
                line={line}
                now={now}
                resetClaim={state.resetClaims[accountID]}
                breakdown={data.usageBreakdown(line.descriptor)}
                accountStatus={accountStatus}
                snapshotDate={data.snapshots[accountID]?.refreshedAt}
                modelFigure={modelFigure}
                onPickModelFigure={pickModelFigure}
                onCopyBreakdown={(provider, breakdown, figure) => copyBreakdown(provider, breakdown, figure, id)}
                onToggleMeterStyle={() => void api.setSetting(DisplaySettingKeys.meterStyle, WidgetDisplayMode.toggled(data.meterStyle))}
                onToggleResetDisplay={() => void api.setSetting(DisplaySettingKeys.resetDisplayMode, ResetDisplayMode.toggled(data.resetDisplayMode))}
              />
            </div>
          )
        }}
      />
    )
  }

  const accountSection = (account: DashboardAccount, family: DashboardFamily): ReactNode => {
    const id = DashboardAccount.id(account)
    const accountStatus = status(id)
    return (
      <div
        key={id}
        className="db-account"
        data-reorder-id={id}
        style={activeAccountID === id ? { opacity: 0 } : undefined}
        onContextMenu={contextMenu(() => DashboardMenus.account(account, accountStatus.notice ?? accountStatus.staleness))}
      >
        <DashboardAccountCaption
          account={account}
          plan={data.plan(id)}
          status={accountStatus}
          hasSiblingAccounts={family.accounts.length > 1}
          renaming={renaming}
          onPointerDown={accountDrag(account, family)}
        />
        {rows(account, accountStatus)}
      </div>
    )
  }

  const host = root.current?.closest<HTMLElement>('.panel') ?? undefined
  return (
    <div ref={root} className="db-list">
      {families.map((family) => (
        <DashboardProviderSection
          key={family.id}
          family={family}
          panelShown={panelShown}
          reorderID={familyFrameID(family.id)}
          isLifted={activeFamilyID === familyFrameID(family.id)}
          onContextMenu={contextMenu(() => DashboardMenus.provider(family))}
          header={(isHovered) => (
            <DashboardProviderHeader
              family={family}
              isRevealed={isHovered}
              onCopyScreenshot={() => shareScreenshot(family.accounts.map(DashboardAccount.id))}
              onPointerDown={familyDrag(family)}
            />
          )}
          account={(account) => accountSection(account, family)}
        />
      ))}
      {reorderLift && host ? <ReorderLiftPreview lift={reorderLift} host={host} /> : null}
    </div>
  )
}
