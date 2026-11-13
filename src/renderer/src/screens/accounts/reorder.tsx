import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import './accounts.css'

/** A row's layout frame in window coordinates, without any transform it is animating through. */
export interface ReorderFrame {
  left: number
  top: number
  width: number
  height: number
}

interface Point {
  x: number
  y: number
}

/** The row being dragged: where it was picked up, and where the pointer is (upstream's `ReorderLift`). */
interface ReorderLift {
  id: string
  sourceFrame: ReorderFrame
  touchOffset: Point
  location: Point
}

/** A drag starts once the pointer has moved this far (the gesture's `minimumDistance`). */
const minimumDistance = 4
/** How long to wait for the app's new order before giving up on it. */
const orderWaitMs = 600

/**
 * The row the dragged one should trade places with, or undefined (upstream's `reorderTarget`). The
 * pointer must be in a row, 2 points of slack above and below, and a fifth of the way into it from
 * the side the dragged row comes from.
 */
export function reorderTarget(location: Point, frames: ReadonlyMap<string, ReorderFrame>, draggedID: string, orderedIDs: readonly string[]): string | undefined {
  const from = orderedIDs.indexOf(draggedID)
  if (from < 0) return undefined
  const crossingThreshold = 0.2
  for (let to = 0; to < orderedIDs.length; to += 1) {
    const id = orderedIDs[to]
    if (id === draggedID) continue
    const frame = frames.get(id)
    if (!frame) continue
    const contains =
      location.x >= frame.left && location.x < frame.left + frame.width && location.y >= frame.top - 2 && location.y < frame.top + frame.height + 2
    if (!contains) continue
    if (to > from) return location.y >= frame.top + frame.height * crossingThreshold ? id : undefined
    return location.y <= frame.top + frame.height - frame.height * crossingThreshold ? id : undefined
  }
  return undefined
}

function layoutFrame(element: HTMLElement): ReorderFrame {
  // offsetTop is the laid-out place; the bounding rect would follow the row through its move animation.
  const parent = element.offsetParent
  const origin = parent ? parent.getBoundingClientRect() : { left: 0, top: 0 }
  return { left: origin.left + element.offsetLeft, top: origin.top + element.offsetTop, width: element.offsetWidth, height: element.offsetHeight }
}

export interface Reorder {
  /** The row being dragged; draw it with `rowStyle` so it leaves its place empty. */
  activeID: string | undefined
  /** Put on each row: `ref={reorder.row(id)}`. The rows' container must be `position: relative`. */
  row: (id: string) => (element: HTMLElement | null) => void
  rowStyle: (id: string) => CSSProperties | undefined
  /** Put on each row's grip: `onPointerDown={reorder.grip(id)}`. */
  grip: (id: string) => (event: ReactPointerEvent<HTMLElement>) => void
  /** The lifted row following the pointer. Render it anywhere; it draws over the panel. */
  lift: ReactNode
}

/**
 * Drag-to-reorder for a list of rows (upstream's `reorderDragGesture` with `ReorderLiftPreview`). As
 * the dragged row crosses another, `reorder` is asked to trade them; it answers whether the app moved
 * anything. The rows then arrive in their new order from the app, and slide to their places.
 */
export function useReorder(options: {
  orderedIDs: readonly string[]
  reorder: (dragged: string, target: string) => Promise<boolean>
  /** The dragged row as the lift draws it: the row with an inert grip. */
  preview: (id: string) => ReactNode
}): Reorder {
  const [lift, setLift] = useState<ReorderLift | undefined>(undefined)
  const rows = useRef(new Map<string, HTMLElement>())
  const latest = useRef(options)
  latest.current = options
  const stopDrag = useRef<(() => void) | undefined>(undefined)

  const orderKey = options.orderedIDs.join('\n')

  // Rows slide from where they were to where the new order puts them.
  const tops = useRef(new Map<string, number>())
  const lastOrderKey = useRef(orderKey)
  useLayoutEffect(() => {
    const moved = lastOrderKey.current !== orderKey
    lastOrderKey.current = orderKey
    const next = new Map<string, number>()
    for (const [id, element] of rows.current) {
      next.set(id, element.offsetTop)
      const before = tops.current.get(id)
      if (!moved || before === undefined || before === element.offsetTop) continue
      element.style.transition = 'none'
      element.style.transform = `translateY(${before - element.offsetTop}px)`
      void element.offsetHeight
      element.style.transition = 'transform var(--motion-spring)'
      element.style.transform = ''
    }
    tops.current = next
  })

  useEffect(() => () => stopDrag.current?.(), [])

  const row = useCallback(
    (id: string) =>
      (element: HTMLElement | null): void => {
        if (element) rows.current.set(id, element)
        else rows.current.delete(id)
      },
    []
  )

  const grip = useCallback(
    (id: string) =>
      (down: ReactPointerEvent<HTMLElement>): void => {
        if (down.button !== 0) return
        down.preventDefault()
        stopDrag.current?.()
        const start: Point = { x: down.clientX, y: down.clientY }
        const pointerID = down.pointerId
        let current: ReorderLift | undefined
        let isAsking = false
        /** The order a move was made from: nothing more is asked until the app's new order has arrived. */
        let waitingOnOrder: { key: string; since: number } | undefined
        let refused: string | undefined

        const frames = (): Map<string, ReorderFrame> => new Map([...rows.current].map(([rowID, element]) => [rowID, layoutFrame(element)]))

        const onMove = (event: PointerEvent): void => {
          if (event.pointerId !== pointerID) return
          const location: Point = { x: event.clientX, y: event.clientY }
          if (!current) {
            if (Math.hypot(location.x - start.x, location.y - start.y) < minimumDistance) return
            const element = rows.current.get(id)
            if (!element) return
            const sourceFrame = layoutFrame(element)
            current = { id, sourceFrame, touchOffset: { x: start.x - sourceFrame.left, y: start.y - sourceFrame.top }, location }
          }
          current = { ...current, location }
          setLift(current)

          const ids = latest.current.orderedIDs
          const key = ids.join('\n')
          if (waitingOnOrder) {
            if (waitingOnOrder.key === key && Date.now() - waitingOnOrder.since < orderWaitMs) return
            waitingOnOrder = undefined
          }
          if (isAsking) return
          const target = reorderTarget(location, frames(), id, ids)
          if (target === undefined) return
          // A move the app refused (an account past a provider with several) is not asked again until something changes.
          const attempt = `${target}\n\n${key}`
          if (attempt === refused) return
          isAsking = true
          void latest.current
            .reorder(id, target)
            .then(
              (moved) => {
                if (moved) waitingOnOrder = { key, since: Date.now() }
                else refused = attempt
              },
              () => {
                refused = attempt
              }
            )
            .finally(() => {
              isAsking = false
            })
        }

        const stop = (): void => {
          window.removeEventListener('pointermove', onMove)
          window.removeEventListener('pointerup', onEnd)
          window.removeEventListener('pointercancel', onEnd)
          window.removeEventListener('blur', stop)
          stopDrag.current = undefined
          current = undefined
          setLift(undefined)
        }
        const onEnd = (event: PointerEvent): void => {
          if (event.pointerId === pointerID) stop()
        }

        window.addEventListener('pointermove', onMove)
        window.addEventListener('pointerup', onEnd)
        window.addEventListener('pointercancel', onEnd)
        window.addEventListener('blur', stop)
        stopDrag.current = stop
      },
    []
  )

  const activeID = lift?.id
  const rowStyle = useCallback((id: string): CSSProperties | undefined => (id === activeID ? { opacity: 0 } : undefined), [activeID])

  const liftNode = lift
    ? createPortal(
        <div
          className="card reorder-lift"
          aria-hidden
          style={{
            left: lift.location.x - lift.touchOffset.x,
            top: lift.location.y - lift.touchOffset.y,
            width: lift.sourceFrame.width
          }}
        >
          {options.preview(lift.id)}
        </div>,
        document.body
      )
    : null

  return { activeID, row, rowStyle, grip, lift: liftNode }
}
