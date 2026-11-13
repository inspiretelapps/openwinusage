import { useState, type ReactNode } from 'react'
import { Provider } from '@core/models/Provider'
import { Tooltip } from '../../components/Tooltip'
import { useRenaming } from '../../state/context'
import { ConcealedName } from './AccountNameConcealment'
import { InlineRenameField } from './InlineRenameField'
import './accounts.css'

/** An account's name as the title of its page. A click renames it in place. */
export function AccountTitle({ provider }: { provider: Provider }): ReactNode {
  const renaming = useRenaming()
  const [isHovered, setIsHovered] = useState(false)
  const edit = renaming.edit
  if (edit && edit.providerID === provider.id) {
    return (
      <div className="account-title-field">
        <InlineRenameField edit={edit} alignment="center" />
      </div>
    )
  }
  return (
    <Tooltip text="Rename Account">
      <button
        type="button"
        className="plain-button account-title"
        aria-label={`${Provider.fullName(provider)}, Rename Account`}
        onClick={() => renaming.begin(provider.id)}
        onMouseEnter={() => setIsHovered(true)}
        onMouseLeave={() => setIsHovered(false)}
      >
        <span className={`hover-highlight account-title-chip${isHovered ? ' is-lit' : ''}`}>
          <ConcealedName provider={provider} className="truncate account-title-name">
            {Provider.accountName(provider)}
          </ConcealedName>
        </span>
      </button>
    </Tooltip>
  )
}
