import { useEffect, useRef, type ReactNode } from 'react'
import type { RenameEdit } from '../../state/AccountRenameStore'
import { useRenaming } from '../../state/context'
import './accounts.css'

/**
 * An account's name as a field, in place of the name: Return saves, Esc cancels, and leaving the
 * field (a click anywhere else, or the panel closing) saves. It draws 4 by 1 points outside its
 * layout box, so the text does not move when the field replaces the name.
 */
export function InlineRenameField({ edit, alignment }: { edit: RenameEdit; alignment?: 'leading' | 'center' }): ReactNode {
  const renaming = useRenaming()
  const field = useRef<HTMLInputElement>(null)

  useEffect(() => {
    field.current?.focus()
    field.current?.select()
  }, [])

  return (
    <input
      ref={field}
      className="inline-rename-field"
      type="text"
      value={renaming.draft}
      placeholder="Account Name"
      aria-label="Account Name"
      spellCheck={false}
      autoComplete="off"
      style={{ textAlign: alignment === 'center' ? 'center' : undefined }}
      onChange={(event) => (renaming.draft = event.target.value)}
      onBlur={() => renaming.commit(edit)}
      onKeyDown={(event) => {
        if (event.key === 'Enter') {
          event.preventDefault()
          event.stopPropagation()
          renaming.commit(edit)
        } else if (event.key === 'Escape') {
          event.preventDefault()
          event.stopPropagation()
          renaming.cancel(edit)
        }
      }}
      onPointerDown={(event) => event.stopPropagation()}
      onDoubleClick={(event) => event.stopPropagation()}
    />
  )
}
