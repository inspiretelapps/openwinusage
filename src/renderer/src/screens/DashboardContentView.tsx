import { useEffect, type ReactNode, type RefObject } from 'react'
import { api } from '../bridge'
import { Button } from '../components/Controls'
import { Icon } from '../components/Icon'
import { AppIcon } from '../components/ProviderIcon'
import { usePopover, useStores } from '../state/context'
import { PriorityDashboardView } from './dashboard/PriorityDashboardView'
import { WidgetGroupedListView } from './dashboard/WidgetGroupedListView'

function EmptyDashboardView({ addAccount }: { addAccount: () => void }): ReactNode {
  const name = useStores().state.app.name
  return (
    <div className="empty-dashboard">
      <div style={{ marginBottom: 14 }}>
        <AppIcon side={56} />
      </div>
      <div style={{ fontSize: 19, fontWeight: 600, marginBottom: 7 }}>Add an Account</div>
      <div className="secondary" style={{ fontSize: 12, maxWidth: 230, marginBottom: 20, textWrap: 'balance' }}>
        {name} tracks however many accounts you'd like to monitor. Just add them and they'll show right up, even multiple of the same provider!
      </div>
      <Button variant="prominent" size="large" onClick={addAccount} style={{ fontSize: 12, fontWeight: 600, padding: '9px 24px' }}>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
          <Icon name="plus" size={11} weight="bold" /> Add Account
        </span>
      </Button>
    </div>
  )
}

function UpdateBannerCard({ version }: { version: string }): ReactNode {
  const name = useStores().state.app.name
  return (
    <div className="card update-banner">
      <span className="secondary" style={{ width: 20, height: 20, display: 'grid', placeItems: 'center' }}>
        <Icon name="arrow.down.circle" size={15} weight="semibold" />
      </span>
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 4, alignItems: 'flex-start' }}>
        <span style={{ fontSize: 'var(--font-subheadline)', fontWeight: 600 }}>Update Available</span>
        <span className="secondary" style={{ fontSize: 'var(--font-caption)' }}>
          {name} {version} is ready to download.
        </span>
        <Button size="small" style={{ marginTop: 2 }} onClick={() => void api.updaterInstall()}>
          Install Update
        </Button>
      </div>
      <button type="button" className="plain-button secondary" aria-label="Dismiss" style={{ width: 16, height: 16, display: 'grid', placeItems: 'center' }} onClick={() => void api.updaterDismiss()}>
        <Icon name="xmark" size={10} weight="semibold" />
      </button>
    </div>
  )
}

/** The dashboard page: the update banner, then the chosen tab, or what to do when there is nothing to show. */
export function DashboardContentView({ scrollRef }: { scrollRef: RefObject<HTMLDivElement | null> }): ReactNode {
  const stores = useStores()
  const popover = usePopover()
  const tab = popover.dashboardTab
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: 0 })
  }, [tab, scrollRef])

  let content: ReactNode
  if (stores.registry.providers.length === 0) {
    content = <EmptyDashboardView addAccount={() => (popover.isAddingAccount = true)} />
  } else if (stores.layout.displayGroups.length === 0) {
    content = (
      <div className="secondary" style={{ fontSize: 12, textAlign: 'center', padding: '22px 0' }}>
        Every metric is hidden. Turn them back on in Accounts.
      </div>
    )
  } else {
    content = tab === 'priority' ? <PriorityDashboardView /> : <WidgetGroupedListView />
  }
  const update = stores.state.updater.availableUpdateVersion
  return (
    <div className="dashboard-content">
      {update !== undefined ? <UpdateBannerCard version={update} /> : null}
      {content}
    </div>
  )
}
