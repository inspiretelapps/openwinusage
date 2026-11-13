import { useEffect, useState, type ReactNode } from 'react'
import { CLIProxyHub } from '@core/models/CLIProxyHub'
import { DashboardAccount, type DashboardFamily } from '@core/models/DashboardFamilies'
import { DashboardRowModel } from '@core/models/DashboardRowModel'
import { Provider } from '@core/models/Provider'
import { Spinner } from '../../components/Controls'
import { Icon } from '../../components/Icon'
import { ProviderIcon } from '../../components/ProviderIcon'
import { Tooltip } from '../../components/Tooltip'
import type { AccountRenameStore } from '../../state/AccountRenameStore'
import { InlineRenameField } from '../accounts/InlineRenameField'
import { TruncatedText, concealingAccountName } from '../AccountNameConcealment'
import { CopyFeedbackButton } from './CopyFeedbackButton'
import { DashboardGrid, DashboardLineStack } from './DashboardGrid'
import { DashboardMetricRow } from './DashboardMetricRow'

type PointerDown = (event: React.PointerEvent<HTMLElement>) => void
type ContextMenu = (event: React.MouseEvent<HTMLElement>) => void

/** A provider's card: its name and mark over every account of that kind. */
export function DashboardProviderSection(props: {
  family: DashboardFamily
  /** The card's header; the plain one when left out, as in a picture. */
  header?: (isHovered: boolean) => ReactNode
  account: (account: DashboardAccount) => ReactNode
  /** Whether the panel is on-screen. A panel that closes under the pointer gets no leave event. */
  panelShown?: boolean
  reorderID?: string
  isLifted?: boolean
  onContextMenu?: ContextMenu
}): ReactNode {
  const { family } = props
  const [isHovered, setHovered] = useState(false)
  useEffect(() => {
    if (props.panelShown === false) setHovered(false)
  }, [props.panelShown])
  return (
    <section
      className="db-section"
      data-reorder-id={props.reorderID}
      style={props.isLifted ? { opacity: 0 } : undefined}
      aria-label={Provider.displayName(family.provider)}
      onPointerEnter={() => setHovered(true)}
      onPointerLeave={() => setHovered(false)}
      onContextMenu={props.onContextMenu}
    >
      {props.header ? props.header(isHovered) : <DashboardProviderHeader family={family} />}
      <div className="db-card card">{family.accounts.map((account) => props.account(account))}</div>
    </section>
  )
}

export function DashboardProviderHeader(props: {
  family: DashboardFamily
  isRevealed?: boolean
  onCopyScreenshot?: () => Promise<boolean>
  onPointerDown?: PointerDown
}): ReactNode {
  const [copied, setCopied] = useState(false)
  const provider = props.family.provider
  const name = Provider.displayName(provider)
  return (
    <div className="db-header" onPointerDown={props.onPointerDown}>
      <span className="db-header-title truncate">{name}</span>
      <span className="db-header-spacer" />
      {props.onCopyScreenshot ? (
        <span className="db-header-copy">
          <CopyFeedbackButton
            accessibilityLabel={`Copy ${name} Screenshot`}
            isRevealed={props.isRevealed ?? false}
            copied={copied}
            setCopied={setCopied}
            action={props.onCopyScreenshot}
          />
        </span>
      ) : null}
      <ProviderIcon id={Provider.icon(provider)} side={DashboardGrid.iconSize} inset={0.04} />
    </div>
  )
}

/** What an account is doing or what is wrong with it, shown after its name. */
export interface AccountStatus {
  refreshing: boolean
  notice?: string
  staleness?: string
  /** Opens the account's page, the same as Fix on Priority. */
  onFix?: () => void
}

export const AccountStatus = {
  none: { refreshing: false } as AccountStatus,

  isShowing(status: AccountStatus): boolean {
    return status.refreshing || status.notice !== undefined || status.staleness !== undefined
  }
}

export function AccountStatusGlyph({ status }: { status: AccountStatus }): ReactNode {
  if (status.refreshing) {
    return (
      <span className="db-status-glyph" role="img" aria-label="Refreshing">
        <Spinner size={10} />
      </span>
    )
  }
  if (status.notice !== undefined) {
    return (
      <Tooltip text={status.notice}>
        <button
          type="button"
          className="plain-button db-status-glyph is-notice"
          aria-label={status.notice}
          disabled={status.onFix === undefined}
          onPointerDown={(event) => event.stopPropagation()}
          onClick={() => status.onFix?.()}
        >
          <Icon name="exclamationmark.triangle.fill" size={10} weight="semibold" filled className="db-symbol-knockout" />
        </button>
      </Tooltip>
    )
  }
  if (status.staleness !== undefined) {
    return (
      <Tooltip text={status.staleness}>
        <span className="db-status-glyph tertiary" role="img" aria-label={status.staleness}>
          <Icon name="clock" size={10} weight="medium" />
        </span>
      </Tooltip>
    )
  }
  return null
}

/** The line over an account's rows: its name, sign-in domain, status, and plan. Nothing at all when it has none of them. */
export function DashboardAccountCaption(props: {
  account: DashboardAccount
  plan?: string
  status?: AccountStatus
  hasSiblingAccounts?: boolean
  /** Left out where nothing can be renamed, as in a picture. */
  renaming?: AccountRenameStore
  onPointerDown?: PointerDown
}): ReactNode {
  const { account, plan, renaming } = props
  const status = props.status ?? AccountStatus.none
  const id = DashboardAccount.id(account)
  // A sole default-named account sits under its provider's name. Siblings need separate drag handles.
  const showsName =
    (props.hasSiblingAccounts ?? false) || Provider.labelBesideName(account.provider) !== undefined || renaming?.edit?.providerID === id
  const domain = account.provider.domain
  if (!showsName && domain === undefined && plan === undefined && !AccountStatus.isShowing(status)) return null
  return (
    <div className="db-caption" onPointerDown={props.onPointerDown}>
      {showsName ? (
        <span className="db-caption-name">
          <AccountNameLabel account={account} renaming={renaming} />
        </span>
      ) : null}
      {domain !== undefined ? <TruncatedText text={domain} mode="middle" className="db-caption-domain" /> : null}
      <AccountStatusGlyph status={status} />
      <span className="db-header-spacer" />
      {plan !== undefined ? <PlanBadge plan={plan} /> : null}
    </div>
  )
}

function PlanBadge({ plan }: { plan: string }): ReactNode {
  return <span className="db-plan">{plan}</span>
}

/** An account's name, marked when it's mirrored from a CLIProxyAPI hub. */
export function AccountNameLabel(props: { account: DashboardAccount; renaming?: AccountRenameStore }): ReactNode {
  return (
    <>
      <AccountName account={props.account} renaming={props.renaming} />
      {props.account.provider.hubHost !== undefined ? (
        <ProviderIcon
          id={CLIProxyHub.markID}
          side={DashboardGrid.planCapHeight}
          inset={0}
          style={{ marginLeft: 3, color: 'currentColor', alignSelf: 'center' }}
        />
      ) : null}
    </>
  )
}

export function AccountName(props: { account: DashboardAccount; renaming?: AccountRenameStore }): ReactNode {
  const { account, renaming } = props
  const id = DashboardAccount.id(account)
  const edit = renaming?.edit
  if (renaming && edit && edit.providerID === id) {
    return (
      <span className="db-rename" onPointerDown={(event) => event.stopPropagation()}>
        <InlineRenameField edit={edit} />
      </span>
    )
  }
  return (
    <span className={`db-account-name ${concealingAccountName(account.provider)}`} onDoubleClick={() => renaming?.begin(id)}>
      <TruncatedText text={DashboardAccount.name(account)} mode={Provider.isNamedByEmail(account.provider) ? 'middle' : 'tail'} />
    </span>
  )
}

/** An account as a picture or a lifted preview shows it: its caption and rows, with nothing to click. */
export function DashboardAccountRows(props: { account: DashboardAccount; plan?: string; hasSiblingAccounts?: boolean; now?: number }): ReactNode {
  return (
    <div className="db-account">
      <DashboardAccountCaption account={props.account} plan={props.plan} hasSiblingAccounts={props.hasSiblingAccounts} />
      <DashboardLineStack
        account={props.account}
        row={(line) => <DashboardMetricRow key={line.descriptor.id} model={DashboardRowModel.make(line.data, props.now)} />}
      />
    </div>
  )
}
