import { contextBridge, ipcRenderer } from 'electron'
import { IpcChannels, type AppState, type Bridge, type PanelEvent } from '@shared/ipc'

const bridge: Bridge = {
  call: (method, ...args) => ipcRenderer.invoke(IpcChannels.call, method, args),
  onState: (listener) => {
    const handler = (_event: unknown, state: AppState): void => listener(state)
    ipcRenderer.on(IpcChannels.state, handler)
    return () => ipcRenderer.removeListener(IpcChannels.state, handler)
  },
  onEvent: (listener) => {
    const handler = (_event: unknown, event: PanelEvent): void => listener(event)
    ipcRenderer.on(IpcChannels.event, handler)
    return () => ipcRenderer.removeListener(IpcChannels.event, handler)
  }
}

contextBridge.exposeInMainWorld('winusage', bridge)
