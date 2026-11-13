import { createContext, useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react'
import type { Observable } from '@core/support/Observable'
import type { Instant } from '@core/support/time'
import type { AppState } from '@shared/ipc'
import { api, bridge, onState } from '../bridge'
import { AccountRenameStore } from './AccountRenameStore'
import { PopoverState } from './PopoverState'
import { buildStores, type Stores } from './stores'

interface PanelContext {
  stores: Stores
  popover: PopoverState
  renaming: AccountRenameStore
}

const Context = createContext<PanelContext | undefined>(undefined)

/** Loads the app's state, keeps it current, and provides the stores built from it. Renders nothing until the first state arrives. */
export function StoresProvider({ children }: { children: ReactNode }): ReactNode {
  const [state, setState] = useState<AppState | undefined>(undefined)
  useEffect(() => {
    let live = true
    const stop = onState((next) => {
      if (live) setState(next)
    })
    void bridge.call('getState').then((first) => {
      if (live) setState((current) => current ?? first)
    })
    return () => {
      live = false
      stop()
    }
  }, [])

  const stores = useMemo(() => (state ? buildStores(state) : undefined), [state])
  const storesRef = useRef<Stores | undefined>(stores)
  storesRef.current = stores
  const [popover] = useState(() => new PopoverState())
  const [renaming] = useState(
    () =>
      new AccountRenameStore(
        (providerID) => storesRef.current?.account(providerID),
        (providerID, label) => void api.accountRename(providerID, label)
      )
  )
  const value = useMemo(() => (stores ? { stores, popover, renaming } : undefined), [stores, popover, renaming])
  if (!value) return null
  return <Context.Provider value={value}>{children}</Context.Provider>
}

function usePanelContext(): PanelContext {
  const context = useContext(Context)
  if (!context) throw new Error('This component must be inside <StoresProvider>.')
  return context
}

/** The current stores. The component re-renders whenever the app sends new state. */
export function useStores(): Stores {
  return usePanelContext().stores
}

export function useAppState(): AppState {
  return usePanelContext().stores.state
}

/** Re-renders the component whenever `observable` notifies. */
export function useObservable<T extends Observable>(observable: T): T {
  const version = useRef(0)
  useSyncExternalStore(
    (onChange) =>
      observable.subscribe(() => {
        version.current += 1
        onChange()
      }),
    () => version.current
  )
  return observable
}

/** The panel's screen and sheets (`PopoverState`). Set its properties directly; the component re-renders. */
export function usePopover(): PopoverState {
  return useObservable(usePanelContext().popover)
}

export function useRenaming(): AccountRenameStore {
  return useObservable(usePanelContext().renaming)
}

/**
 * The current time, re-rendering the component every `seconds`. Countdowns on rows use 30, the footer's
 * refresh countdown uses 1. Ticks stop while the panel is hidden.
 */
export function useNow(seconds: number): Instant {
  const popover = usePanelContext().popover
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    let timer: ReturnType<typeof setInterval> | undefined
    const start = (): void => {
      setNow(Date.now())
      if (timer === undefined) timer = setInterval(() => setNow(Date.now()), seconds * 1000)
    }
    const stop = (): void => {
      if (timer !== undefined) clearInterval(timer)
      timer = undefined
    }
    const sync = (): void => (popover.popoverShown ? start() : stop())
    sync()
    const unsubscribe = popover.subscribe(sync)
    return () => {
      unsubscribe()
      stop()
    }
  }, [seconds, popover])
  return now
}

/** Whether animations are off: the system's Reduce Motion (Windows "Animation effects" off). */
export function useReduceAnimations(): boolean {
  return usePanelContext().stores.state.reduceMotion
}
