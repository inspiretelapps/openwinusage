import type { PointerEvent as ReactPointerEvent, ReactNode } from 'react'
import { Provider } from '@core/models/Provider'
import { Icon } from '../../components/Icon'
import { ProviderIcon } from '../../components/ProviderIcon'
import { ConcealedName } from './AccountNameConcealment'
import './accounts.css'

/** The handle a row is dragged by. Without `onPointerDown` it is the inert one a lifted row shows. */
export function ReorderGrip(props: { onPointerDown?: (event: ReactPointerEvent<HTMLElement>) => void }): ReactNode {
  return (
    <span className="reorder-grip" aria-hidden onPointerDown={props.onPointerDown}>
      <Icon name="line.3.horizontal" size={12} weight="semibold" />
    </span>
  )
}

/** The chevron at the trailing edge of a row that opens a page. */
export function RowChevron(props: { label: string; onOpen?: () => void }): ReactNode {
  return (
    <button type="button" className="plain-button row-chevron" aria-label={props.label} onClick={props.onOpen}>
      <Icon name="chevron.right" size={12} weight="semibold" />
    </button>
  )
}

/** An account in a list: its provider's mark and name, the account's own name beside it, and a chevron. It opens the account's page. */
export function AccountListRow(props: { provider: Provider; grip?: ReactNode; onOpen?: () => void }): ReactNode {
  const { provider } = props
  const accountLabel = Provider.labelBesideName(provider)
  return (
    <div className="account-row">
      {props.grip}
      <div className="account-row-main" onClick={props.onOpen}>
        <ProviderIcon id={Provider.icon(provider)} side={18} />
        <span className="account-row-name">{Provider.displayName(provider)}</span>
        {accountLabel !== undefined ? (
          <ConcealedName provider={provider} className="truncate secondary">
            {accountLabel}
          </ConcealedName>
        ) : null}
      </div>
      <RowChevron label={`Open ${Provider.fullName(provider)}`} onOpen={props.onOpen} />
    </div>
  )
}
