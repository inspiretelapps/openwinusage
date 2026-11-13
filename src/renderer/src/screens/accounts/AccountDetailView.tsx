import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Account } from '@core/models/Account'
import { CLIProxyHub } from '@core/models/CLIProxyHub'
import { Provider } from '@core/models/Provider'
import type { WidgetDescriptor } from '@core/models/WidgetDescriptor'
import { api, errorMessage } from '../../bridge'
import { ConfirmDialog } from '../../components/ConfirmDialog'
import { Button, Spinner, TextField, Toggle } from '../../components/Controls'
import { Icon } from '../../components/Icon'
import { ProviderIcon } from '../../components/ProviderIcon'
import { usePopover, useStores } from '../../state/context'
import { ReorderGrip } from './AccountListRow'
import { useDialogSpace } from './dialogSpace'
import { ErrorText, NoticeTriangle } from './ErrorText'
import { useReorder } from './reorder'
import './accounts.css'

/** How long the app's new state may trail the answer to a removal before the account counts as kept. */
const removalSettleMs = 400

/**
 * An account's page: why it needs the user, a switch, a pin, and a grip for each metric, where it
 * signs in, its key, and its removal. An account mirrored from a hub shows its metrics and the hub.
 */
export function AccountDetailView({ providerID }: { providerID: string }): ReactNode {
  const stores = useStores()
  const popover = usePopover()
  const reserveDialogSpace = useDialogSpace()
  const [isConfirmingRemoval, setIsConfirmingRemoval] = useState(false)
  const [removalError, setRemovalError] = useState<string | undefined>(undefined)
  const [isRemoving, setIsRemoving] = useState(false)
  const latest = useRef(stores)
  latest.current = stores

  const provider = stores.layout.provider(providerID)
  const account = stores.account(providerID)

  // Once the app has dropped the account, its page has nothing to show.
  const isGone = isRemoving && account === undefined
  useEffect(() => {
    if (isGone && popover.customizeProviderID === providerID) popover.customizeProviderID = undefined
  }, [isGone, popover, providerID])

  if (!provider) return null

  const removeAccount = async (): Promise<void> => {
    if (!latest.current.account(providerID)) return
    setRemovalError(undefined)
    setIsRemoving(true)
    try {
      await api.accountRemove(providerID)
    } catch (error) {
      setIsRemoving(false)
      setRemovalError(errorMessage(error))
      return
    }
    await new Promise((resolve) => setTimeout(resolve, removalSettleMs))
    if (latest.current.account(providerID) === undefined) return
    setIsRemoving(false)
    setRemovalError(latest.current.state.accountsLastError ?? 'The account could not be removed.')
  }

  const metrics = <MetricsCard providerID={providerID} />

  if (provider.hubHost !== undefined) {
    return (
      <div className="accounts-sections">
        {metrics}
        <InfoRow icon={CLIProxyHub.markID} text={`Managed by ${provider.hubHost}`} />
      </div>
    )
  }

  const problem = stores.data.problem(providerID)
  const authMethod = account ? Account.authMethod(account) : undefined
  const replacedField = authMethod?.type === 'apiKey' ? 'API Key' : authMethod?.type === 'organizationToken' ? 'Token' : undefined

  return (
    <div className="accounts-sections">
      {problem !== undefined ? <ProblemCard message={problem} /> : null}
      {problem !== undefined && authMethod?.type === 'oauth' ? (
        <div className="card">
          <button
            type="button"
            className="plain-button card-action is-tinted"
            onClick={() => {
              popover.signingInAgainProviderID = providerID
              popover.isAddingAccount = true
            }}
          >
            Sign In Again…
          </button>
        </div>
      ) : null}
      {metrics}
      {provider.domain !== undefined ? <InfoRow icon={Provider.icon(provider)} text={`Signed in at ${provider.domain}`} /> : null}
      <div className="card">
        {replacedField !== undefined ? <ReplaceKeyRow field={replacedField} commit={(key) => api.accountReplaceKey(providerID, key)} /> : null}
        <button type="button" className="plain-button card-action is-destructive" onClick={() => setIsConfirmingRemoval(true)}>
          Remove Account…
        </button>
      </div>
      {removalError !== undefined ? <ErrorText message={removalError} /> : null}
      {isConfirmingRemoval ? (
        <ConfirmDialog
          title={`Remove ${Provider.fullName(provider)}?`}
          message="Its sign-in is deleted from this PC. You can add the account again at any time."
          confirmTitle="Remove Account"
          destructive
          onHeight={reserveDialogSpace}
          onCancel={() => setIsConfirmingRemoval(false)}
          onConfirm={() => {
            setIsConfirmingRemoval(false)
            void removeAccount()
          }}
        />
      ) : null}
    </div>
  )
}

function MetricsCard({ providerID }: { providerID: string }): ReactNode {
  const stores = useStores()
  const { layout } = stores
  const metrics = layout.orderedSupportedMetrics(providerID)
  const byID = new Map(metrics.map((metric): [string, WidgetDescriptor] => [metric.id, metric]))

  const reorder = useReorder({
    orderedIDs: metrics.map((metric) => metric.id),
    reorder: (dragged, target) => api.layoutReorderMetric(dragged, target, providerID),
    preview: (id) => {
      const metric = byID.get(id)
      return metric ? (
        <AccountMetricRow title={metric.title} isShown={layout.isMetricShown(id)} isPinned={layout.isMetricPinned(id)} grip={<ReorderGrip />} />
      ) : null
    }
  })

  if (metrics.length === 0) return null
  return (
    <div className="card reorder-rows">
      {metrics.map((metric) => (
        <div key={metric.id} ref={reorder.row(metric.id)} style={reorder.rowStyle(metric.id)}>
          <AccountMetricRow
            title={metric.title}
            isShown={layout.isMetricShown(metric.id)}
            isPinned={layout.isMetricPinned(metric.id)}
            setShown={(shown) => void api.layoutSetMetricShown(metric.id, shown)}
            setPinned={(pinned) => void api.layoutSetMetricPinned(metric.id, pinned)}
            grip={<ReorderGrip onPointerDown={reorder.grip(metric.id)} />}
          />
        </div>
      ))}
      {reorder.lift}
    </div>
  )
}

/**
 * Where the account lives: a hub's login is added, signed in, and removed on the hub, so its page
 * offers none of that here, and a Copilot enterprise account names the GHE.com domain it signs in at.
 */
function InfoRow({ icon, text }: { icon: string; text: string }): ReactNode {
  return (
    <div className="card info-row">
      <ProviderIcon id={icon} side={16} inset={0} />
      <span className="truncate secondary">{text}</span>
    </div>
  )
}

/** Why an account or a hub needs the user, at the top of its page. */
export function ProblemCard({ message }: { message: string }): ReactNode {
  return (
    <div className="card problem-card">
      <NoticeTriangle size={13} style={{ color: 'var(--orange)', marginTop: 1 }} />
      <span>{message}</span>
    </div>
  )
}

/** One metric on an account's page: a grip, its title, a pin for Priority, and the switch that shows or hides it. */
export function AccountMetricRow(props: {
  title: string
  isShown: boolean
  isPinned: boolean
  setShown?: (shown: boolean) => void
  setPinned?: (pinned: boolean) => void
  grip: ReactNode
}): ReactNode {
  const { title, isShown, isPinned } = props
  return (
    <div className="metric-row">
      {props.grip}
      <span className="metric-row-title">{title}</span>
      <button
        type="button"
        className={`plain-button metric-row-pin${isPinned ? ' is-pinned' : ''}`}
        disabled={!isShown}
        aria-label={isPinned ? `Unpin ${title}` : `Pin ${title}`}
        aria-pressed={isPinned}
        onClick={() => props.setPinned?.(!isPinned)}
      >
        <Icon name={isPinned ? 'pin.fill' : 'pin'} size={12} weight="semibold" filled={isPinned} />
      </button>
      <Toggle isOn={isShown} onChange={(shown) => props.setShown?.(shown)} label={title} size="small" />
    </div>
  )
}

/** Replaces a key in place: the new key is kept only once `commit` accepts it. A rejection's message shows under the field. */
export function ReplaceKeyRow(props: { field: string; commit: (key: string) => Promise<unknown> }): ReactNode {
  const { field } = props
  const [isEditing, setIsEditing] = useState(false)
  const [key, setKey] = useState('')
  const [isSaving, setIsSaving] = useState(false)
  const [error, setError] = useState<string | undefined>(undefined)
  const isMounted = useRef(true)
  useEffect(() => {
    isMounted.current = true
    return () => {
      isMounted.current = false
    }
  }, [])

  const close = (): void => {
    setIsEditing(false)
    setKey('')
    setError(undefined)
  }

  if (!isEditing) {
    return (
      <button type="button" className="plain-button card-action is-tinted" onClick={() => setIsEditing(true)}>
        Replace {field}…
      </button>
    )
  }

  const canSave = !isSaving && key.trim().length > 0
  const save = (): void => {
    if (!canSave) return
    setIsSaving(true)
    setError(undefined)
    props.commit(key).then(
      () => {
        if (!isMounted.current) return
        close()
        setIsSaving(false)
      },
      (failure: unknown) => {
        if (!isMounted.current) return
        setError(errorMessage(failure))
        setIsSaving(false)
      }
    )
  }

  return (
    <div className="replace-key-editor" aria-busy={isSaving}>
      <TextField value={key} onChange={setKey} placeholder={`New ${field}`} label={field} secure autoFocus disabled={isSaving} onSubmit={save} onCancel={close} />
      {error !== undefined ? <ErrorText message={error} /> : null}
      <div className="replace-key-buttons">
        {isSaving ? <Spinner size={14} /> : null}
        <span style={{ flex: 1 }} />
        <Button onClick={close} disabled={isSaving}>
          Cancel
        </Button>
        <Button variant="prominent" onClick={save} disabled={!canSave}>
          Save
        </Button>
      </div>
    </div>
  )
}
