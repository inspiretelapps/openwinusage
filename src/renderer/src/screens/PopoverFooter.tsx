import type { ReactNode } from 'react'
import { RefreshSetting } from '@core/stores/RefreshSetting'
import { addSeconds, secondsBetween, type Instant } from '@core/support/time'
import { api } from '../bridge'
import { Button, RoundIconButton, Spinner, TransientPill, showMenu } from '../components/Controls'
import { Tooltip } from '../components/Tooltip'
import type { PopoverScreen } from '../state/PopoverState'
import { useNow, usePopover, useStores } from '../state/context'
import { copyPriorityShareCard } from './dashboard/share'

function updateStatusText(isUpdating: boolean, lastRefreshAt: Instant | undefined, now: Instant): string {
  if (isUpdating) return 'Updating…'
  const base = lastRefreshAt ?? now
  const remaining = Math.max(0, secondsBetween(addSeconds(base, RefreshSetting.interval), now))
  const totalSeconds = Math.ceil(remaining)
  if (totalSeconds >= 60) return `Next update in ${Math.ceil(totalSeconds / 60)}m`
  return `Next update in ${totalSeconds}s`
}

function NextUpdateButton(): ReactNode {
  const stores = useStores()
  const now = useNow(1)
  const isUpdating = stores.state.isRefreshingNow || stores.state.refreshingProviderIDs.length > 0
  return (
    <Tooltip text="Refresh now (Ctrl+R)">
      <button
        type="button"
        className="plain-button mono-digits"
        style={{ display: 'flex', alignItems: 'center', gap: 5 }}
        disabled={isUpdating}
        onClick={() => void api.refreshNow()}
      >
        <span>{updateStatusText(isUpdating, stores.data.lastRefreshAt, now)}</span>
        {isUpdating ? <Spinner size={10} /> : null}
      </button>
    </Tooltip>
  )
}

/** What sits under a page: the version, refresh countdown and Options menu on the dashboard; Add New Account on the account list. */
export function PopoverFooter({ screen }: { screen: PopoverScreen }): ReactNode {
  const stores = useStores()
  const popover = usePopover()
  const { app, updater, demo } = stores.state

  const openOptions = async (): Promise<void> => {
    const chosen = await showMenu([
      { id: 'accounts', label: 'Accounts', accelerator: 'Enter' },
      { id: 'settings', label: 'Settings', accelerator: 'Ctrl+,' },
      { type: 'separator' },
      { id: 'update', label: 'Check for Updates…', enabled: updater.canCheckForUpdates },
      { type: 'separator' },
      ...(app.issuesURL ? [{ id: 'issue', label: 'Report an Issue…' }] : []),
      { id: 'about', label: `About ${app.name}` },
      { id: 'quit', label: `Quit ${app.name}`, accelerator: 'Ctrl+Q' }
    ])
    if (chosen === 'accounts') popover.toggle('accounts')
    else if (chosen === 'settings') popover.toggle('settings')
    else if (chosen === 'update') void api.updaterCheck()
    else if (chosen === 'issue') void api.openExternal(app.issuesURL)
    else if (chosen === 'about') void api.showAbout()
    else if (chosen === 'quit') void api.quit()
  }

  let content: ReactNode = null
  if (screen === 'dashboard') {
    const board =
      popover.dashboardTab === 'priority'
        ? stores.data.priorityBoard(stores.layout.displayGroups, stores.layout.state.priorityPinIDs, Date.now(), !stores.state.privacyMode.isEnabled)
        : undefined
    const hasRows = board !== undefined && (board.summary === 'listed' || board.pinned.length > 0)
    content = (
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, width: '100%', padding: '0 4px' }}>
        <div className="footer-identity">
          <span>
            {app.name} {app.version}
          </span>
          {stores.layout.displayGroups.length > 0 ? <NextUpdateButton /> : null}
        </div>
        {demo ? <span style={{ fontSize: 10, fontWeight: 500, color: 'var(--text-secondary)' }}>Demo Data · {demo.seed}</span> : null}
        <span style={{ flex: 1, minWidth: 8 }} />
        {hasRows ? (
          <RoundIconButton
            icon="doc.on.doc"
            iconSize={12}
            label="Copy Priority Screenshot"
            onClick={() => {
              void copyPriorityShareCard(stores).then((copied) => {
                if (copied) popover.shareNotice.present(true)
              })
            }}
          />
        ) : null}
        <RoundIconButton icon="ellipsis" label="Options" onClick={() => void openOptions()} />
      </div>
    )
  } else if (screen === 'accounts' && popover.customizeProviderID === undefined && popover.customizeHubID === undefined) {
    content = (
      <Button variant="prominent" size="large" fullWidth onClick={() => (popover.isAddingAccount = true)}>
        Add New Account
      </Button>
    )
  }

  return (
    <div className="footer">
      {screen === 'dashboard' && popover.shareNotice.value ? (
        <div className="footer-share-pill" key={popover.shareNotice.trigger}>
          <TransientPill icon="checkmark.circle.fill" text="Copied to clipboard" />
        </div>
      ) : null}
      {content}
    </div>
  )
}
