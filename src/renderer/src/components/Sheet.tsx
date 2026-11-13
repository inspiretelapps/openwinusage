import { useEffect, useRef, type ReactNode } from 'react'
import './components.css'

/**
 * A sheet attached to the top of the panel, dimming what is behind it (a macOS window sheet). Esc
 * calls `onDismiss`. `onHeight` reports the sheet's height so the panel can grow to hold it.
 */
export function Sheet(props: { children: ReactNode; onDismiss: () => void; onHeight?: (height: number | undefined) => void }): ReactNode {
  const ref = useRef<HTMLDivElement>(null)
  const { onHeight, onDismiss } = props
  useEffect(() => {
    const node = ref.current
    if (!node || !onHeight) return
    const observer = new ResizeObserver(() => onHeight(node.scrollHeight))
    observer.observe(node)
    onHeight(node.scrollHeight)
    return () => {
      observer.disconnect()
      onHeight(undefined)
    }
  }, [onHeight])
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      event.stopPropagation()
      event.preventDefault()
      onDismiss()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [onDismiss])
  return (
    <div className="sheet-backdrop">
      <div ref={ref} className="sheet" role="dialog" aria-modal>
        {props.children}
      </div>
    </div>
  )
}
