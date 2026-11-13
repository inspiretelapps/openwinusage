import type { ReactNode } from 'react'
import { CLIProxyHub } from '@core/models/CLIProxyHub'
import type { HubSyncStatus } from '@core/stores/CLIProxyHubSync'
import { ProviderIcon } from '../../components/ProviderIcon'
import { useStores } from '../../state/context'
import type { Stores } from '../../state/stores'
import { RowChevron } from './AccountListRow'
import { NoticeTriangle } from './ErrorText'
import './accounts.css'

/** "1 account", "3 logins" (upstream's `CLIProxyHub.count`). */
export function hubCount(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`
}

/** What a hub's last read came to (`CLIProxyHubSync.status(of:)`). */
export function hubStatus(stores: Stores, hubID: string): HubSyncStatus {
  if (!CLIProxyHub.isEnabled) return { type: 'failed', message: CLIProxyHub.offMessage }
  return stores.state.hubStatuses[hubID] ?? { type: 'checking' }
}

/**
 * A connected CLIProxyAPI hub in Accounts, laid out like an account's row: its host, how many accounts
 * it mirrors, and a warning when its last read failed. It opens the hub's page.
 */
export function CLIProxyHubRow(props: { hub: CLIProxyHub; onOpen: () => void }): ReactNode {
  const stores = useStores()
  const { hub } = props
  const host = CLIProxyHub.host(hub)
  const status = hubStatus(stores, hub.id)
  const accountCount = stores.accounts.filter((account) => account.hub?.hubID === hub.id).length
  return (
    <div className="account-row">
      <div className="account-row-main" onClick={props.onOpen}>
        <ProviderIcon id={CLIProxyHub.markID} side={18} />
        <span className="truncate hub-row-host">{host}</span>
        <span className="secondary hub-row-count">{hubCount(accountCount, 'account')}</span>
        {status.type === 'failed' ? <NoticeTriangle size={10} label={status.message} style={{ color: 'var(--orange)' }} /> : null}
      </div>
      <RowChevron label={`Open the CLIProxyAPI Hub at ${host}`} onOpen={props.onOpen} />
    </div>
  )
}
