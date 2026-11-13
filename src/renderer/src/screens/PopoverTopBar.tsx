import type { ReactNode } from 'react'
import { DashboardTab } from '@core/models/DashboardTab'
import { CLIProxyHub } from '@core/models/CLIProxyHub'
import { CapsuleSegments } from '../components/Controls'
import { Icon } from '../components/Icon'
import { AccountIcon, ProviderIcon } from '../components/ProviderIcon'
import { Tooltip } from '../components/Tooltip'
import { SettingsTab, type PopoverScreen } from '../state/PopoverState'
import { usePopover, useStores } from '../state/context'
import { AccountTitle } from './accounts/AccountTitle'

function BackButton({ action }: { action: () => void }): ReactNode {
  return (
    <Tooltip text="Back">
      <button type="button" className="plain-button back-button" aria-label="Back" onClick={action}>
        <Icon name="chevron.backward" size={15} weight="semibold" />
      </button>
    </Tooltip>
  )
}

function NavigationBar(props: { back: () => void; title: ReactNode; trailing?: ReactNode }): ReactNode {
  return (
    <div className="nav-bar">
      <div className="nav-bar-title">{props.title}</div>
      <div className="nav-bar-row">
        <BackButton action={props.back} />
        <span style={{ flex: 1, minWidth: 8 }} />
        {props.trailing}
      </div>
    </div>
  )
}

function SettingsTabBar(): ReactNode {
  const popover = usePopover()
  return (
    <div style={{ display: 'flex', gap: 2 }} role="tablist">
      {SettingsTab.allCases.map((tab) => {
        const isSelected = popover.settingsTab === tab
        return (
          <button
            key={tab}
            type="button"
            role="tab"
            aria-selected={isSelected}
            className={`plain-button settings-tab${isSelected ? ' is-selected' : ''}`}
            onClick={() => (popover.settingsTab = tab)}
          >
            <span style={{ height: 20, display: 'grid', placeItems: 'center' }}>
              <Icon name={SettingsTab.symbol(tab)} size={16} />
            </span>
            <span>{SettingsTab.title(tab)}</span>
          </button>
        )
      })}
    </div>
  )
}

/** What sits above a page: the tab switch on the dashboard, a title with a back button elsewhere. */
export function PopoverTopBar({ screen }: { screen: PopoverScreen }): ReactNode {
  const stores = useStores()
  const popover = usePopover()
  const back = (): void => void popover.back()

  if (screen === 'dashboard') {
    return (
      <div style={{ padding: 'var(--margin) var(--margin) var(--bar-gap)' }}>
        <CapsuleSegments
          options={DashboardTab.allCases.map((tab) => ({ value: tab, label: DashboardTab.label(tab) }))}
          selection={popover.dashboardTab}
          onSelect={(tab) => (popover.dashboardTab = tab)}
          selectsOnPress
        />
      </div>
    )
  }

  if (screen === 'accounts') {
    const provider = popover.customizeProviderID !== undefined ? stores.layout.provider(popover.customizeProviderID) : undefined
    if (provider) {
      return (
        <NavigationBar
          back={back}
          title={<AccountTitle provider={provider} />}
          trailing={
            <span style={{ width: 28, height: 28, display: 'grid', placeItems: 'center' }}>
              <AccountIcon provider={provider} side={22} inset={0.04} />
            </span>
          }
        />
      )
    }
    const hub = popover.customizeHubID !== undefined ? stores.hubs.find((candidate) => candidate.id === popover.customizeHubID) : undefined
    if (hub) {
      return (
        <NavigationBar
          back={back}
          title={<span className="truncate">{CLIProxyHub.host(hub)}</span>}
          trailing={
            <span style={{ width: 28, height: 28, display: 'grid', placeItems: 'center' }}>
              <ProviderIcon id={CLIProxyHub.markID} side={22} inset={0.04} />
            </span>
          }
        />
      )
    }
    return <NavigationBar back={back} title="Accounts" />
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10, padding: 'var(--margin) var(--margin) var(--bar-gap)' }}>
      <div style={{ position: 'relative', height: 28, display: 'flex', alignItems: 'center' }}>
        <BackButton action={back} />
        <span style={{ position: 'absolute', left: 40, right: 40, textAlign: 'center', fontSize: 'var(--font-headline)', fontWeight: 600 }}>Settings</span>
      </div>
      <SettingsTabBar />
    </div>
  )
}
