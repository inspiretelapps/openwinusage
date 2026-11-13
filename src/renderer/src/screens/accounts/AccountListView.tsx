import type { ReactNode } from 'react'
import type { Provider } from '@core/models/Provider'
import { api } from '../../bridge'
import { Icon } from '../../components/Icon'
import { usePopover, useStores } from '../../state/context'
import { AccountListRow, ReorderGrip } from './AccountListRow'
import { CLIProxyHubRow } from './CLIProxyHubRow'
import { useReorder } from './reorder'
import './accounts.css'

/** The accounts added directly, in the user's order with a grip to reorder them, then the connected hubs. */
export function AccountListView(): ReactNode {
  const stores = useStores()
  const popover = usePopover()
  // A hub's accounts are listed on its page, not here.
  const providers = stores.layout.orderedProviders().filter((provider) => provider.hubHost === undefined)
  const hubs = stores.hubs
  const byID = new Map(providers.map((provider): [string, Provider] => [provider.id, provider]))

  const reorder = useReorder({
    orderedIDs: providers.map((provider) => provider.id),
    reorder: (dragged, target) => api.layoutReorderProvider(dragged, target),
    preview: (id) => {
      const provider = byID.get(id)
      return provider ? <AccountListRow provider={provider} grip={<ReorderGrip />} /> : null
    }
  })

  return (
    <div className="accounts-sections">
      {providers.length === 0 && hubs.length === 0 ? (
        <div className="content-unavailable">
          <Icon name="person.crop.circle" size={36} className="secondary" />
          <span>No Accounts</span>
        </div>
      ) : providers.length > 0 ? (
        <div className="card reorder-rows">
          {providers.map((provider) => (
            <div key={provider.id} ref={reorder.row(provider.id)} style={reorder.rowStyle(provider.id)}>
              <AccountListRow
                provider={provider}
                grip={<ReorderGrip onPointerDown={reorder.grip(provider.id)} />}
                onOpen={() => (popover.customizeProviderID = provider.id)}
              />
            </div>
          ))}
        </div>
      ) : null}
      {hubs.length > 0 ? (
        <div className="card">
          {hubs.map((hub) => (
            <CLIProxyHubRow key={hub.id} hub={hub} onOpen={() => (popover.customizeHubID = hub.id)} />
          ))}
        </div>
      ) : null}
      {reorder.lift}
    </div>
  )
}
