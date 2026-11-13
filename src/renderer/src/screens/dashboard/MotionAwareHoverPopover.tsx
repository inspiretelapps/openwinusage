import { useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from 'react'
import { createPortal } from 'react-dom'

/** The space between the anchor and the popover, which the arrow fills. */
const arrowGap = 7
/** How close the popover may come to the panel's edge. */
const panelMargin = 6
const arrowInset = 16

interface Placement {
  left: number
  top: number
  edge: 'above' | 'below'
  arrowX: number
  maxHeight: number
}

/**
 * Upstream's `motionAwareHoverPopover`: the detail a figure shows on hover or click. A macOS popover
 * is its own window; this panel's window ends at the panel, so the detail is drawn over the panel,
 * attached to its figure: above it as upstream prefers, or below when only that side has the room.
 * A click anywhere else or Esc dismisses it, as a transient popover does.
 */
export function MotionAwareHoverPopover(props: {
  anchor: RefObject<HTMLElement | null>
  onDismiss: () => void
  onHoverChange?: (inside: boolean) => void
  children: ReactNode
}): ReactNode {
  const ref = useRef<HTMLDivElement>(null)
  const [placement, setPlacement] = useState<Placement | undefined>(undefined)
  const { anchor, onDismiss } = props
  const dismiss = useRef(onDismiss)
  dismiss.current = onDismiss
  const host = anchor.current?.closest<HTMLElement>('.panel') ?? document.body

  useLayoutEffect(() => {
    const node = ref.current
    if (!node) return
    const place = (): void => {
      const target = anchor.current
      if (!target || !target.isConnected) return
      const panel = host.getBoundingClientRect()
      const at = target.getBoundingClientRect()
      const width = node.offsetWidth
      const height = (node.firstElementChild as HTMLElement | null)?.scrollHeight ?? node.scrollHeight
      const roomAbove = at.top - panel.top - arrowGap - panelMargin
      const roomBelow = panel.bottom - at.bottom - arrowGap - panelMargin
      const edge: Placement['edge'] = roomAbove >= height || roomAbove >= roomBelow ? 'above' : 'below'
      const maxHeight = Math.max(80, edge === 'above' ? roomAbove : roomBelow)
      const shown = Math.min(height, maxHeight)
      const center = at.left + at.width / 2 - panel.left
      const left = Math.max(panelMargin, Math.min(center - width / 2, panel.width - width - panelMargin))
      const top = edge === 'above' ? at.top - panel.top - arrowGap - shown : at.bottom - panel.top + arrowGap
      const arrowX = Math.max(arrowInset, Math.min(center - left, width - arrowInset))
      setPlacement((current) =>
        current && current.left === left && current.top === top && current.edge === edge && current.arrowX === arrowX && current.maxHeight === maxHeight
          ? current
          : { left, top, edge, arrowX, maxHeight }
      )
    }
    place()
    const observer = new ResizeObserver(place)
    observer.observe(node)
    const content = node.firstElementChild
    if (content) observer.observe(content)
    observer.observe(host)
    window.addEventListener('scroll', place, true)
    window.addEventListener('resize', place)
    return () => {
      observer.disconnect()
      window.removeEventListener('scroll', place, true)
      window.removeEventListener('resize', place)
    }
  }, [anchor, host])

  useEffect(() => {
    const onPointerDown = (event: PointerEvent): void => {
      const target = event.target as Node | null
      if (target && (ref.current?.contains(target) || anchor.current?.contains(target))) return
      dismiss.current()
    }
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      event.stopPropagation()
      dismiss.current()
    }
    const onBlur = (): void => dismiss.current()
    window.addEventListener('pointerdown', onPointerDown, true)
    window.addEventListener('keydown', onKey, true)
    window.addEventListener('blur', onBlur)
    return () => {
      window.removeEventListener('pointerdown', onPointerDown, true)
      window.removeEventListener('keydown', onKey, true)
      window.removeEventListener('blur', onBlur)
    }
  }, [anchor])

  return createPortal(
    <div
      ref={ref}
      className={`db-popover is-${placement?.edge ?? 'above'}${placement ? ' is-placed' : ''}`}
      role="dialog"
      style={{ left: placement?.left ?? 0, top: placement?.top ?? 0, maxHeight: placement?.maxHeight }}
      onPointerEnter={() => props.onHoverChange?.(true)}
      onPointerLeave={() => props.onHoverChange?.(false)}
      onContextMenu={(event) => event.stopPropagation()}
    >
      <div className="db-popover-content scroll-hidden">{props.children}</div>
      <span className="db-popover-arrow" style={{ left: placement?.arrowX ?? 0 }} aria-hidden />
    </div>,
    host
  )
}
