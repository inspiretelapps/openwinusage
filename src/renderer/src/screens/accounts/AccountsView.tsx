import { useEffect, useState, type ReactNode } from 'react'
import { usePopover, useReduceAnimations } from '../../state/context'
import { AccountDetailView } from './AccountDetailView'
import { AccountListView } from './AccountListView'
import { DialogSpaceContext } from './dialogSpace'
import { HubDetailView } from './HubDetailView'
import './accounts.css'

/** Motion.navigation */
const navigationMs = 250

type Level = { type: 'list' } | { type: 'account'; providerID: string } | { type: 'hub'; hubID: string }

function levelKey(level: Level): string {
  return level.type === 'account' ? `account:${level.providerID}` : level.type === 'hub' ? `hub:${level.hubID}` : 'list'
}

function LevelView({ level }: { level: Level }): ReactNode {
  if (level.type === 'account') return <AccountDetailView providerID={level.providerID} />
  if (level.type === 'hub') return <HubDetailView hubID={level.hubID} />
  return <AccountListView />
}

/**
 * The Accounts screen: the account list, an account's page, or a hub's page. A page moves in from
 * the trailing edge and the list from the leading one, as upstream's transitions do.
 */
export function AccountsView(): ReactNode {
  const popover = usePopover()
  const reduceAnimations = useReduceAnimations()
  const [dialogSpace, setDialogSpace] = useState<number | undefined>(undefined)

  const level: Level =
    popover.customizeProviderID !== undefined
      ? { type: 'account', providerID: popover.customizeProviderID }
      : popover.customizeHubID !== undefined
        ? { type: 'hub', hubID: popover.customizeHubID }
        : { type: 'list' }
  const key = levelKey(level)

  const [shown, setShown] = useState<Level>(level)
  const [leaving, setLeaving] = useState<Level | undefined>(undefined)
  if (levelKey(shown) !== key) {
    setLeaving(reduceAnimations ? undefined : shown)
    setShown(level)
  }
  useEffect(() => {
    if (!leaving) return
    const timer = setTimeout(() => setLeaving(undefined), navigationMs)
    return () => clearTimeout(timer)
  }, [leaving, key])

  const isDetail = level.type !== 'list'
  const edge = (which: Level): string => (which.type === 'list' ? 'leading' : 'trailing')

  return (
    <DialogSpaceContext.Provider value={setDialogSpace}>
      <div className="accounts-view" style={{ paddingBottom: isDetail ? 'var(--margin)' : 0, minHeight: dialogSpace }}>
        <div className="accounts-levels">
          {leaving ? (
            <div key={levelKey(leaving)} className={`accounts-level is-leaving to-${edge(leaving)}`} aria-hidden>
              <LevelView level={leaving} />
            </div>
          ) : null}
          <div key={key} className={`accounts-level${leaving ? ` is-entering from-${edge(level)}` : ''}`}>
            <LevelView level={level} />
          </div>
        </div>
      </div>
    </DialogSpaceContext.Provider>
  )
}
