import { useEffect, useRef, type ReactNode } from 'react'
import { Icon } from '../../components/Icon'

/**
 * A copy glyph that turns into a checkmark for a moment once `action` reports a copy. `isRevealed`
 * hides it until its card is hovered; it stays visible while it shows the checkmark.
 */
export function CopyFeedbackButton(props: {
  accessibilityLabel: string
  isRevealed?: boolean
  copied: boolean
  setCopied: (copied: boolean) => void
  action: () => boolean | Promise<boolean>
}): ReactNode {
  const resetTask = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const { copied, setCopied } = props
  const isShown = (props.isRevealed ?? true) || copied
  useEffect(
    () => () => {
      if (resetTask.current !== undefined) clearTimeout(resetTask.current)
      resetTask.current = undefined
    },
    []
  )
  const run = async (): Promise<void> => {
    let didCopy = false
    try {
      didCopy = await props.action()
    } catch {
      didCopy = false
    }
    if (!didCopy) return
    setCopied(true)
    if (resetTask.current !== undefined) clearTimeout(resetTask.current)
    resetTask.current = setTimeout(() => {
      resetTask.current = undefined
      setCopied(false)
    }, 1400)
  }
  return (
    <button
      type="button"
      className={`plain-button db-copy-button${isShown ? ' is-revealed' : ''}${copied ? ' is-copied' : ''}`}
      aria-label={props.accessibilityLabel}
      tabIndex={isShown ? 0 : -1}
      onPointerDown={(event) => event.stopPropagation()}
      onClick={(event) => {
        event.stopPropagation()
        void run()
      }}
    >
      <Icon key={copied ? 'copied' : 'copy'} name={copied ? 'checkmark' : 'doc.on.doc'} size={11} weight="semibold" className="db-copy-glyph" />
    </button>
  )
}
