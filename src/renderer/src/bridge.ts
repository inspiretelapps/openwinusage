import type { Api, ApiMethod, AppState, Bridge, PanelEvent } from '@shared/ipc'

/** The connection to the app, put on `window` by the preload script. */
export const bridge: Bridge = window.winusage

type ApiCalls = { [M in ApiMethod]: (...args: Parameters<Api[M]>) => Promise<Awaited<ReturnType<Api[M]>>> }

/**
 * Everything the panel can ask the app to do: `api.layoutUndo()`, `api.refreshNow()`. Each call is one
 * round trip and rejects with an `Error` whose message is ready to show.
 */
export const api = new Proxy({} as ApiCalls, {
  get: (_target, method: string) => (...args: unknown[]) => (bridge.call as (method: string, ...args: unknown[]) => Promise<unknown>)(method, ...args)
})

export function onState(listener: (state: AppState) => void): () => void {
  return bridge.onState(listener)
}

export function onPanelEvent(listener: (event: PanelEvent) => void): () => void {
  return bridge.onEvent(listener)
}

/** The message of a rejected `api` call, without Electron's "Error invoking remote method" wrapper. */
export function errorMessage(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error)
  return text.replace(/^Error invoking remote method '[^']*': (?:Error: )?/, '')
}
