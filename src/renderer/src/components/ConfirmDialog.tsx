import { useEffect, useLayoutEffect, useRef, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { Button } from './Controls'
import { AppIcon } from './ProviderIcon'
import './ConfirmDialog.css'

/**
 * A small dialog over the panel that asks before something is done (SwiftUI's `confirmationDialog`
 * and `alert`, which macOS draws as an alert): the app's mark, a title, a message, the action, and
 * Cancel. Esc and a click outside cancel.
 *
 * The panel is as tall as its page, which can be shorter than the dialog. `onHeight` reports the
 * dialog's height while it is open (undefined once it closes) so the page can make room.
 */
export function ConfirmDialog(props: {
  title: string
  message?: string
  confirmTitle: string
  /** Draws the action in red, for something that deletes. */
  destructive?: boolean
  cancelTitle?: string
  onConfirm: () => void
  onCancel: () => void
  onHeight?: (height: number | undefined) => void
}): ReactNode {
  const box = useRef<HTMLDivElement>(null)
  const cancel = useRef(props.onCancel)
  cancel.current = props.onCancel
  const { onHeight } = props

  useLayoutEffect(() => {
    if (!onHeight) return
    onHeight(box.current?.offsetHeight)
    return () => onHeight(undefined)
  }, [onHeight])

  useEffect(() => {
    box.current?.querySelector<HTMLButtonElement>('.confirm-buttons > button:last-child')?.focus()
    // Ahead of the panel's own keys: Esc closes the dialog, not the page under it.
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopImmediatePropagation()
        cancel.current()
      } else if (event.key === 'Enter' && (event.target as HTMLElement | null)?.tagName !== 'BUTTON') {
        event.preventDefault()
        event.stopImmediatePropagation()
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [])

  return createPortal(
    <div
      className="confirm-backdrop"
      onPointerDown={(event) => {
        if (event.target === event.currentTarget) props.onCancel()
      }}
    >
      <div ref={box} className="confirm-dialog" role="alertdialog" aria-modal aria-label={props.title}>
        <AppIcon side={48} />
        <div className="confirm-title">{props.title}</div>
        {props.message !== undefined ? <div className="confirm-message">{props.message}</div> : null}
        <div className="confirm-buttons">
          <Button variant={props.destructive ? 'destructive' : 'prominent'} size="large" fullWidth onClick={props.onConfirm}>
            {props.confirmTitle}
          </Button>
          <Button size="large" fullWidth onClick={props.onCancel}>
            {props.cancelTitle ?? 'Cancel'}
          </Button>
        </div>
      </div>
    </div>,
    document.querySelector('.panel') ?? document.body
  )
}
