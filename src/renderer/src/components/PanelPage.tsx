import { useEffect, useLayoutEffect, useRef, useState, type ReactNode, type Ref } from 'react'
import './components.css'

/** How far content must be under the bottom bar to frost it fully. */
const fullFrost = 12

/**
 * One page of the panel (upstream's `PopoverScrollView` with `panelBars`): `children` scroll under a
 * top bar, which hides them, and a bottom bar, which frosts what is under it and draws nothing while
 * nothing is.
 *
 * `onIdealHeight` reports the height the page wants: both bars plus all of its content. The panel takes
 * that height, up to what the screen allows.
 */
export function PanelPage(props: {
  top?: ReactNode
  bottom?: ReactNode
  children: ReactNode
  onIdealHeight?: (height: number) => void
  scrollRef?: Ref<HTMLDivElement>
}): ReactNode {
  const topRef = useRef<HTMLDivElement>(null)
  const bottomRef = useRef<HTMLDivElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const [insets, setInsets] = useState({ top: 0, bottom: 0 })
  const [underBottom, setUnderBottom] = useState(0)
  const { onIdealHeight } = props
  const report = useRef(onIdealHeight)
  report.current = onIdealHeight

  const measure = (): void => {
    const top = topRef.current?.offsetHeight ?? 0
    const bottom = bottomRef.current?.offsetHeight ?? 0
    const content = contentRef.current?.offsetHeight ?? 0
    setInsets((current) => (current.top === top && current.bottom === bottom ? current : { top, bottom }))
    if (content > 0 || top > 0 || bottom > 0) report.current?.(top + content + bottom)
    updateFrost()
  }

  const updateFrost = (): void => {
    const scroll = scrollRef.current
    if (!scroll) return
    const below = scroll.scrollHeight - scroll.clientHeight - scroll.scrollTop
    setUnderBottom(Math.min(Math.max(below / fullFrost, 0), 1))
  }

  useLayoutEffect(measure)
  useEffect(() => {
    const observer = new ResizeObserver(measure)
    for (const node of [topRef.current, bottomRef.current, contentRef.current, scrollRef.current]) if (node) observer.observe(node)
    return () => observer.disconnect()
  }, [])

  return (
    <div className="panel-page">
      <div
        ref={(node) => {
          scrollRef.current = node
          const outer = props.scrollRef
          if (typeof outer === 'function') outer(node)
          else if (outer) (outer as { current: HTMLDivElement | null }).current = node
        }}
        className="panel-page-scroll scroll-hidden"
        style={{ paddingTop: insets.top, paddingBottom: insets.bottom }}
        onScroll={updateFrost}
      >
        <div ref={contentRef}>{props.children}</div>
      </div>
      <div ref={topRef} className="panel-bar-top">
        {props.top}
      </div>
      <div ref={bottomRef} className="panel-bar-bottom">
        <div className="panel-bar-frost" style={{ opacity: underBottom }} />
        <div className="panel-bar-content">{props.bottom}</div>
      </div>
    </div>
  )
}
