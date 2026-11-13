import { useLayoutEffect, useRef, type ReactNode, type RefObject } from 'react'
import { createPortal } from 'react-dom'

export interface Point {
  x: number
  y: number
}

export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

/** What is being dragged: a preview that follows the pointer while its source stays hidden in the list. */
export interface ReorderLift {
  readonly id: string
  readonly preview: ReactNode
  /** Where the source was when it was lifted, in window coordinates. */
  readonly sourceFrame: Rect
  readonly touchOffset: Point
  /** The pointer, in window coordinates. */
  location: Point
}

/** The lifted preview: the source's width, a touch larger, with a shadow under it. It is drawn over the panel and clipped to it. */
export function ReorderLiftPreview({ lift, host }: { lift: ReorderLift; host: HTMLElement }): ReactNode {
  const panel = host.getBoundingClientRect()
  return createPortal(
    <div
      className="db-lift"
      aria-hidden
      style={{
        width: lift.sourceFrame.width,
        left: lift.location.x - lift.touchOffset.x - panel.left,
        top: lift.location.y - lift.touchOffset.y - panel.top
      }}
    >
      {lift.preview}
    </div>,
    host
  )
}

/** The element's layout frame inside `root`, which no transform in flight moves: SwiftUI's `proxy.frame(in:)`. */
function layoutFrame(element: HTMLElement, root: HTMLElement): Rect {
  let x = 0
  let y = 0
  let node: HTMLElement | null = element
  while (node && node !== root) {
    x += node.offsetLeft
    y += node.offsetTop
    node = node.offsetParent as HTMLElement | null
  }
  return { x, y, width: element.offsetWidth, height: element.offsetHeight }
}

/** The frame of everything under `root` that can be reordered (it carries `data-reorder-id`), by id. `root` must be positioned. */
export function reorderFrames(root: HTMLElement): Map<string, Rect> {
  const frames = new Map<string, Rect>()
  for (const element of root.querySelectorAll<HTMLElement>('[data-reorder-id]')) {
    const id = element.dataset.reorderId
    if (id !== undefined) frames.set(id, layoutFrame(element, root))
  }
  return frames
}

function contains(frame: Rect, point: Point): boolean {
  return point.x >= frame.x && point.x < frame.x + frame.width && point.y >= frame.y && point.y < frame.y + frame.height
}

/**
 * The item the dragged one should trade places with: the one under the pointer, once the pointer is a
 * fifth of the way into it from the side the dragged item comes from.
 */
export function reorderTarget(location: Point, frames: ReadonlyMap<string, Rect>, draggedID: string, orderedIDs: string[]): string | undefined {
  const from = orderedIDs.indexOf(draggedID)
  if (from < 0) return undefined
  const crossingThreshold = 0.2

  for (const [to, id] of orderedIDs.entries()) {
    if (id === draggedID) continue
    const frame = frames.get(id)
    if (!frame) continue
    // `frame.insetBy(dx: 0, dy: -2)`
    if (!contains({ x: frame.x, y: frame.y - 2, width: frame.width, height: frame.height + 4 }, location)) continue
    if (to > from) return location.y >= frame.y + frame.height * crossingThreshold ? id : undefined
    return location.y <= frame.y + frame.height - frame.height * crossingThreshold ? id : undefined
  }
  return undefined
}

export interface ReorderDrag {
  id: string
  /** The positioned element every reorderable item is inside. */
  root: HTMLElement | null
  setActive: (id: string | undefined) => void
  setLift: (lift: ReorderLift | undefined) => void
  makePreview: () => ReactNode
  /** The dragged item and its siblings, in the order they show now. */
  orderedIDs: () => string[]
  /** Moves the dragged item beside `target`; answers whether anything moved. */
  reorder: (target: string) => boolean
}

const minimumDistance = 4

/**
 * Upstream's `reorderDragGesture`, started from a handle's pointer-down: once the pointer has moved
 * 4 points the item lifts, follows the pointer, and trades places with what it is dragged over.
 */
export function beginReorderDrag(event: React.PointerEvent<HTMLElement>, drag: ReorderDrag): void {
  const root = drag.root
  if (event.button !== 0 || !root) return
  const origin = event.target as HTMLElement
  // A press inside something drawn over the row (a detail), or in a text field, is not a drag of the row.
  if (!event.currentTarget.contains(origin) || origin.closest('input, textarea, [contenteditable="true"]')) return
  const start: Point = { x: event.clientX, y: event.clientY }
  let lift: ReorderLift | undefined

  const move = (moved: PointerEvent): void => {
    const location: Point = { x: moved.clientX, y: moved.clientY }
    if (!lift) {
      if (Math.hypot(location.x - start.x, location.y - start.y) < minimumDistance) return
      let source: HTMLElement | undefined
      for (const element of root.querySelectorAll<HTMLElement>('[data-reorder-id]')) {
        if (element.dataset.reorderId === drag.id) source = element
      }
      if (!source) return
      const frame = source.getBoundingClientRect()
      lift = {
        id: drag.id,
        preview: drag.makePreview(),
        sourceFrame: { x: frame.left, y: frame.top, width: frame.width, height: frame.height },
        touchOffset: { x: start.x - frame.left, y: start.y - frame.top },
        location
      }
      drag.setActive(drag.id)
    }
    lift = { ...lift, location }
    drag.setLift(lift)
    const bounds = root.getBoundingClientRect()
    const target = reorderTarget({ x: location.x - bounds.left, y: location.y - bounds.top }, reorderFrames(root), drag.id, drag.orderedIDs())
    if (target !== undefined) drag.reorder(target)
  }

  const end = (): void => {
    window.removeEventListener('pointermove', move)
    window.removeEventListener('pointerup', end)
    window.removeEventListener('pointercancel', end)
    window.removeEventListener('blur', end)
    if (!lift) return
    drag.setActive(undefined)
    drag.setLift(undefined)
    // The release of a drag is not a click on whatever was under the handle.
    const swallow = (click: MouseEvent): void => {
      click.stopPropagation()
      click.preventDefault()
    }
    window.addEventListener('click', swallow, { capture: true, once: true })
    setTimeout(() => window.removeEventListener('click', swallow, true), 0)
  }

  window.addEventListener('pointermove', move)
  window.addEventListener('pointerup', end)
  window.addEventListener('pointercancel', end)
  window.addEventListener('blur', end)
}

/**
 * Slides reorderable items to their new places with the app's spring whenever the same items come in a
 * new order (upstream's `withAnimation(Motion.spring)` around a reorder). `orderedIDs` is every item
 * top to bottom. Each item is measured inside the reorderable item that holds it, so a card that moves
 * carries its rows without animating them twice.
 */
export function useReorderAnimation(rootRef: RefObject<HTMLElement | null>, orderedIDs: string[]): void {
  const orderKey = orderedIDs.join('|')
  const memberKey = [...orderedIDs].sort().join('|')
  const previous = useRef(new Map<string, number>())
  const last = useRef({ orderKey, memberKey })
  useLayoutEffect(() => {
    const root = rootRef.current
    if (!root) return
    const animates = last.current.orderKey !== orderKey && last.current.memberKey === memberKey
    const next = new Map<string, number>()
    const elements = [...root.querySelectorAll<HTMLElement>('[data-reorder-id]')]
    const tops = new Map<HTMLElement, number>(elements.map((element) => [element, layoutFrame(element, root).y]))
    const moved: HTMLElement[] = []
    for (const element of elements) {
      const id = element.dataset.reorderId
      if (id === undefined) continue
      const parent = element.parentElement?.closest<HTMLElement>('[data-reorder-id]')
      const top = (tops.get(element) ?? 0) - (parent ? (tops.get(parent) ?? 0) : 0)
      next.set(id, top)
      const before = previous.current.get(id)
      if (!animates || before === undefined || Math.abs(before - top) < 0.5) continue
      const inFlight = new DOMMatrixReadOnly(getComputedStyle(element).transform).m42
      element.style.transition = 'none'
      element.style.transform = `translateY(${before - top + inFlight}px)`
      moved.push(element)
    }
    if (moved.length > 0) {
      void root.offsetHeight
      for (const element of moved) {
        element.style.transition = 'transform var(--motion-spring)'
        element.style.transform = ''
      }
    }
    last.current = { orderKey, memberKey }
    previous.current = next
  })
}
