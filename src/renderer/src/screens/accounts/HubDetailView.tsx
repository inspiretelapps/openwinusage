import { useEffect, useState, type ReactNode } from 'react'
import { CLIProxyHub } from '@core/models/CLIProxyHub'
import { Account } from '@core/models/Account'
import { api } from '../../bridge'
import { ConfirmDialog } from '../../components/ConfirmDialog'
import { usePopover, useStores } from '../../state/context'
import { ProblemCard, ReplaceKeyRow } from './AccountDetailView'
import { AccountListRow } from './AccountListRow'
import { hubCount, hubStatus } from './CLIProxyHubRow'
import { useDialogSpace } from './dialogSpace'
import './accounts.css'

/**
 * A CLIProxyAPI hub's page in Accounts: why its last read failed, the accounts it mirrors, the logins
 * the app can't show yet, and the hub's own key and removal. Each account opens its usual page.
 */
export function HubDetailView({ hubID }: { hubID: string }): ReactNode {
  const stores = useStores()
  const popover = usePopover()
  const reserveDialogSpace = useDialogSpace()
  const [isConfirmingRemoval, setIsConfirmingRemoval] = useState(false)
  const [isRemoving, setIsRemoving] = useState(false)

  const hub = stores.hubs.find((candidate) => candidate.id === hubID)

  // Once the app has dropped the hub, its page has nothing to show.
  const isGone = isRemoving && hub === undefined
  useEffect(() => {
    if (isGone && popover.customizeHubID === hubID) popover.customizeHubID = undefined
  }, [isGone, popover, hubID])

  if (!hub) return null

  const host = CLIProxyHub.host(hub)
  const status = hubStatus(stores, hubID)
  const unsupported = status.type === 'synced' ? status.unsupported : 0
  const mirrored = new Set(stores.accounts.filter((account) => account.hub?.hubID === hubID).map((account) => Account.cardID(account)))
  const providers = stores.layout.orderedProviders().filter((provider) => mirrored.has(provider.id))
  const accountCount = mirrored.size

  return (
    <div className="accounts-sections">
      {status.type === 'failed' ? <ProblemCard message={status.message} /> : null}
      {providers.length > 0 || unsupported > 0 ? (
        <div className="hub-accounts">
          {providers.length > 0 ? (
            <div className="card">
              {providers.map((provider) => (
                <AccountListRow key={provider.id} provider={provider} onOpen={() => (popover.customizeProviderID = provider.id)} />
              ))}
            </div>
          ) : null}
          {unsupported > 0 ? (
            <div className="secondary hub-unsupported">
              {hubCount(unsupported, 'login')} {stores.state.app.name} doesn’t support yet
            </div>
          ) : null}
        </div>
      ) : null}
      <div className="card">
        <ReplaceKeyRow field="Management Key" commit={(key) => api.hubReplaceKey(hubID, key)} />
        <button type="button" className="plain-button card-action is-destructive" onClick={() => setIsConfirmingRemoval(true)}>
          Remove Hub…
        </button>
      </div>
      {isConfirmingRemoval ? (
        <ConfirmDialog
          title={`Remove the Hub at ${host}?`}
          message={`Its ${hubCount(accountCount, 'account')} and its management key are deleted from this PC. Nothing changes on the hub.`}
          confirmTitle={`Remove Hub and ${hubCount(accountCount, 'Account')}`}
          destructive
          onHeight={reserveDialogSpace}
          onCancel={() => setIsConfirmingRemoval(false)}
          onConfirm={() => {
            setIsConfirmingRemoval(false)
            setIsRemoving(true)
            api.hubRemove(hubID).catch(() => setIsRemoving(false))
          }}
        />
      ) : null}
    </div>
  )
}
