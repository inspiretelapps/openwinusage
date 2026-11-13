import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import type { DashboardTab } from '@core/models/DashboardTab'
import { api, onPanelEvent } from '../bridge'
import { PanelPage } from '../components/PanelPage'
import { Sheet } from '../components/Sheet'
import { PopoverScreen } from '../state/PopoverState'
import { usePopover, useReduceAnimations, useRenaming, useStores } from '../state/context'
import { AccountsView } from './accounts/AccountsView'
import { AddAccountSheet } from './accounts/AddAccountSheet'
import { DashboardContentView } from './DashboardContentView'
import { PopoverFooter } from './PopoverFooter'
import { PopoverTopBar } from './PopoverTopBar'
import { SettingsScreen } from './settings/SettingsScreen'
import './shell.css'

const slideMs = 250
/** PanelGeometry.sheetMargin: the panel is at least this much taller than a sheet on it. */
const sheetMargin = 20

function heightKey(screen: PopoverScreen, tab: DashboardTab): string {
  return screen === 'dashboard' ? `dashboard.${tab}` : screen
}

/**
 * The panel: the dashboard, Accounts, and Settings as pages that slide between each other, each with
 * its top bar and footer, sized to its content (upstream's `DashboardView` with `PanelHeightController`).
 */
export function DashboardView(): ReactNode {
  const stores = useStores()
  const popover = usePopover()
  const renaming = useRenaming()
  const reduceAnimations = useReduceAnimations()
  const [maxHeight, setMaxHeight] = useState(800)
  const [anchor, setAnchor] = useState<'top' | 'bottom'>('bottom')
  /** The height each page last measured. The dashboard's tabs differ, so each keeps its own. */
  const ideal = useRef(new Map<string, number>())
  const [, setMeasureTick] = useState(0)
  const [sheetHeight, setSheetHeight] = useState<number | undefined>(undefined)
  const [settledSlideID, setSettledSlideID] = useState(0)
  const [slideStarted, setSlideStarted] = useState(0)
  const [hasVisitedSettings, setHasVisitedSettings] = useState(false)
  const dashboardScroll = useRef<HTMLDivElement>(null)
  const applied = useRef(0)

  const isSliding = !reduceAnimations && popover.screenSlideID !== 0 && popover.screenSlideID !== settledSlideID
  const screen = popover.screen

  // The app says when the panel opens and closes.
  useEffect(
    () =>
      onPanelEvent((event) => {
        if (event.type === 'shown') {
          void api.panelMaxHeight().then(setMaxHeight)
          if (event.screen === 'settings') popover.screen = 'settings'
          popover.show(event.tab)
        } else if (event.type === 'hidden') {
          renaming.commit()
          popover.popoverShown = false
          popover.reset()
          if (popover.isAddingAccount) popover.isAddingAccount = false
          dashboardScroll.current?.scrollTo({ top: 0 })
        } else if (event.type === 'openSettings') {
          popover.screen = 'settings'
        }
      }),
    [popover, renaming]
  )

  useEffect(() => {
    void api.panelMaxHeight().then(setMaxHeight)
  }, [])

  useEffect(() => {
    if (screen === 'settings') setHasVisitedSettings(true)
    if (screen === 'accounts') void api.hubsSyncDue(60)
  }, [screen])

  // A sign-in sends the user to their browser, so the panel must not close when it loses focus.
  useEffect(() => {
    void api.panelSetSticky(popover.isAddingAccount)
    if (popover.isAddingAccount) void api.addAccountOpen({ signingInAgainProviderID: popover.signingInAgainProviderID })
    else void api.addAccountClose()
  }, [popover.isAddingAccount, popover.signingInAgainProviderID])

  // Each screen switch slides for a fixed time, then drops the page that left.
  useLayoutEffect(() => {
    const id = popover.screenSlideID
    if (id === 0 || id === settledSlideID) return
    if (reduceAnimations) {
      setSettledSlideID(id)
      return
    }
    setSlideStarted(0)
    const frame = requestAnimationFrame(() => setSlideStarted(id))
    const timer = setTimeout(() => setSettledSlideID(id), slideMs + 30)
    return () => {
      cancelAnimationFrame(frame)
      clearTimeout(timer)
    }
  }, [popover.screenSlideID, reduceAnimations, settledSlideID])

  const report = useCallback((key: string, height: number) => {
    if (height <= 0 || Math.abs((ideal.current.get(key) ?? 0) - height) < 0.5) return
    ideal.current.set(key, height)
    setMeasureTick((tick) => tick + 1)
  }, [])

  // The panel takes its page's height, up to what the screen allows, and holds a sheet with room to spare.
  const key = heightKey(screen, popover.dashboardTab)
  const measured = ideal.current.get(key)
  useEffect(() => {
    if (measured === undefined) return
    let target = Math.min(measured, maxHeight)
    if (isSliding) {
      const from = ideal.current.get(heightKey(popover.screenSlideFrom, popover.dashboardTab))
      if (from !== undefined) target = Math.max(target, Math.min(from, maxHeight))
    }
    if (sheetHeight !== undefined) target = Math.min(Math.max(target, sheetHeight + sheetMargin), maxHeight)
    target = Math.round(target)
    if (Math.abs(target - applied.current) < 1) return
    applied.current = target
    void api.panelSetHeight(target).then((answer) => {
      if (answer.anchor !== undefined) setAnchor(answer.anchor)
    })
  }, [measured, maxHeight, isSliding, sheetHeight, popover.screenSlideFrom, popover.dashboardTab])

  // Keyboard navigation. A text field or the shortcut recorder keeps its own keys.
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      const target = event.target as HTMLElement | null
      const editing = target !== null && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable || target.dataset.recording === 'true')
      const command = event.ctrlKey || event.metaKey
      if (event.key === 'Escape' && !editing) {
        if (!popover.back()) void api.panelHide()
      } else if (event.key === 'Enter' && !editing && !command && !event.altKey && !event.shiftKey) {
        if (target !== null && (target.tagName === 'BUTTON' || target.tagName === 'SELECT' || target.tagName === 'A')) return
        if (popover.screen === 'dashboard') popover.toggle('accounts')
        else popover.back()
      } else if (command && event.key === ',') {
        popover.toggle('settings')
      } else if (command && !event.shiftKey && event.key.toLowerCase() === 'z' && !editing) {
        if (stores.state.canUndo) void api.layoutUndo()
      } else if (command && event.key.toLowerCase() === 'r') {
        void api.refreshNow()
      } else if (command && event.key.toLowerCase() === 'q') {
        void api.quit()
      } else {
        return
      }
      event.preventDefault()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [popover, stores.state.canUndo])

  const pages: PopoverScreen[] = isSliding
    ? PopoverScreen.slideRank(popover.screenSlideFrom) < PopoverScreen.slideRank(screen)
      ? [popover.screenSlideFrom, screen]
      : [screen, popover.screenSlideFrom]
    : [screen]
  const width = 340
  let offset = 0
  if (isSliding && pages.length > 1) {
    const from = -pages.indexOf(popover.screenSlideFrom) * width
    const to = -pages.indexOf(screen) * width
    offset = slideStarted === popover.screenSlideID ? to : from
  }
  const animating = isSliding && slideStarted === popover.screenSlideID

  const page = (which: PopoverScreen): ReactNode => {
    const hidden = which !== screen && !isSliding
    return (
      <div key={which} style={{ display: hidden ? 'none' : 'block', height: '100%', flex: 'none' }} aria-hidden={which !== screen}>
        <PanelPage
          top={<PopoverTopBar screen={which} />}
          bottom={<PopoverFooter screen={which} />}
          scrollRef={which === 'dashboard' ? dashboardScroll : undefined}
          onIdealHeight={(height) => {
            if (which === popover.screen || isSliding) report(heightKey(which, popover.dashboardTab), height)
          }}
        >
          {which === 'dashboard' ? <DashboardContentView scrollRef={dashboardScroll} /> : which === 'accounts' ? <AccountsView /> : <SettingsScreen />}
        </PanelPage>
      </div>
    )
  }

  // Settings stays mounted after its first visit, so returning to it is instant.
  const mounted: PopoverScreen[] = [...pages]
  if (hasVisitedSettings && !mounted.includes('settings')) mounted.push('settings')

  return (
    <div className="window" data-anchor={anchor}>
      <div className="panel" data-conceals-names={stores.state.privacyMode.isConcealing}>
        <div className="pager" style={{ transform: `translateX(${offset}px)`, transition: animating ? `transform ${slideMs}ms ease-in-out` : 'none' }}>
          {mounted.map(page)}
        </div>
        {popover.isAddingAccount ? (
          <Sheet onDismiss={() => (popover.isAddingAccount = false)} onHeight={setSheetHeight}>
            <AddAccountSheet onClose={() => (popover.isAddingAccount = false)} />
          </Sheet>
        ) : null}
      </div>
    </div>
  )
}
