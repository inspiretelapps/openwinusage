import { cloneElement, useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactElement, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import './components.css'

/** `TooltipPresenter.revealDelay`, `anchorGap`, `maxTooltipWidth`. */
const revealDelayMs = 400
const anchorGap = 10
const maxTooltipWidth = 280
/** How close the bubble may come to the window's edge. */
const edgeMargin = 2

/** `TooltipBubble`: 12pt centered text on balanced lines, on the window background with a hairline. */
const bubbleStyle: CSSProperties = {
  width: 'max-content',
  maxWidth: maxTooltipWidth,
  padding: '5px 8px',
  borderRadius: 6,
  background: 'var(--panel)',
  boxShadow: '0 0 0 0.5px var(--separator), 0 3px 10px rgba(0, 0, 0, 0.22)',
  fontSize: 12,
  lineHeight: 1.3,
  textAlign: 'center',
  textWrap: 'balance'
}

/**
 * Upstream's `.hoverTooltip(_:)`: a small label that appears 0.4s after the pointer comes to rest on
 * the child. It is centered on the child just above its top edge, or under it when there is no room
 * above, and never leaves the window. A text that changes while the tooltip shows changes in place.
 *
 * The child must take a ref and the pointer handlers (any DOM element does). An undefined or empty
 * `text` shows nothing.
 */
export function Tooltip(props: { text: string | undefined; children: ReactElement<Record<string, unknown>> }): ReactNode {
  const [anchor, setAnchor] = useState<HTMLElement | undefined>(undefined)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const hovered = useRef<HTMLElement | undefined>(undefined)
  const text = props.text !== undefined && props.text.length > 0 ? props.text : undefined

  const cancelPending = useCallback(() => {
    if (timer.current !== undefined) clearTimeout(timer.current)
    timer.current = undefined
  }, [])

  const hide = useCallback(() => {
    cancelPending()
    setAnchor(undefined)
  }, [cancelPending])

  const scheduleReveal = useCallback(() => {
    if (timer.current !== undefined) return
    timer.current = setTimeout(() => {
      timer.current = undefined
      if (hovered.current?.isConnected) setAnchor(hovered.current)
    }, revealDelayMs)
  }, [])

  // A text that appears under a resting pointer starts its own wait; one that goes away hides at once.
  useEffect(() => {
    if (text === undefined) hide()
    else if (hovered.current !== undefined && anchor === undefined) scheduleReveal()
  }, [text, anchor, hide, scheduleReveal])

  useEffect(
    () => () => {
      hovered.current = undefined
      cancelPending()
    },
    [cancelPending]
  )

  useEffect(() => {
    if (!anchor) return
    const dismiss = (): void => {
      hovered.current = undefined
      hide()
    }
    window.addEventListener('scroll', dismiss, true)
    window.addEventListener('blur', dismiss)
    return () => {
      window.removeEventListener('scroll', dismiss, true)
      window.removeEventListener('blur', dismiss)
    }
  }, [anchor, hide])

  const child = props.children
  const childProps = child.props as {
    onPointerEnter?: (event: React.PointerEvent<HTMLElement>) => void
    onPointerLeave?: (event: React.PointerEvent<HTMLElement>) => void
  }

  return (
    <>
      {cloneElement(child, {
        onPointerEnter: (event: React.PointerEvent<HTMLElement>) => {
          childProps.onPointerEnter?.(event)
          hovered.current = event.currentTarget
          if (text !== undefined) scheduleReveal()
        },
        onPointerLeave: (event: React.PointerEvent<HTMLElement>) => {
          childProps.onPointerLeave?.(event)
          hovered.current = undefined
          hide()
        }
      })}
      {anchor && text !== undefined ? createPortal(<TooltipBubble anchor={anchor} text={text} />, document.body) : null}
    </>
  )
}

function TooltipBubble({ anchor, text }: { anchor: HTMLElement; text: string }): ReactNode {
  const ref = useRef<HTMLDivElement>(null)
  const [position, setPosition] = useState<{ left: number; top: number } | undefined>(undefined)
  useLayoutEffect(() => {
    const node = ref.current
    if (!node) return
    const target = anchor.getBoundingClientRect()
    const { width, height } = node.getBoundingClientRect()
    const viewWidth = document.documentElement.clientWidth
    const viewHeight = document.documentElement.clientHeight
    const left = Math.max(edgeMargin, Math.min(target.left + target.width / 2 - width / 2, viewWidth - width - edgeMargin))
    let top = target.top - anchorGap - height
    if (top < edgeMargin) top = target.bottom + anchorGap
    top = Math.min(top, viewHeight - height - edgeMargin)
    setPosition({ left, top })
  }, [anchor, text])
  return (
    <div
      ref={ref}
      className="tooltip"
      role="tooltip"
      style={{ ...bubbleStyle, left: position?.left ?? 0, top: position?.top ?? 0, opacity: position ? 1 : 0 }}
    >
      {text}
    </div>
  )
}
