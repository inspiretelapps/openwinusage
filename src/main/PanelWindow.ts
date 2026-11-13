import { BrowserWindow, screen, type Rectangle } from 'electron'
import { join } from 'node:path'
import type { DashboardTab } from '@core/models/DashboardTab'
import { AppLog } from '@core/support/AppLog'
import { IpcChannels, type PanelEvent } from '@shared/ipc'

/** PanelMetrics.width, and the room the window leaves around the panel for its shadow (matches `.window` in shell.css). */
const panelWidth = 340
const shadowMargin = 16
/** PanelGeometry */
const gap = 8
const screenMargin = 8
const defaultHeight = 480

/** Where the panel hangs: under the tray when the taskbar is on top, otherwise resting above the taskbar. */
interface Anchor {
  edge: 'top' | 'bottom'
  /** The panel's left edge. */
  x: number
  /** The panel's fixed edge: its top for `top`, its bottom for `bottom`. */
  y: number
  maxHeight: number
}

/** The room a panel has and where it sits, from the tray icon's place and the screen's work area. */
export function panelAnchor(tray: Rectangle, workArea: Rectangle, display: Rectangle): Anchor {
  const minX = workArea.x + screenMargin
  const maxX = workArea.x + workArea.width - panelWidth - screenMargin
  const x = Math.round(Math.min(Math.max(tray.x + tray.width / 2 - panelWidth / 2, minX), Math.max(minX, maxX)))
  const taskbarOnTop = workArea.y > display.y
  const cap = Math.floor(workArea.height * 0.85)
  if (taskbarOnTop) {
    const y = Math.max(workArea.y, tray.y + tray.height) + gap
    return { edge: 'top', x, y, maxHeight: Math.max(1, Math.min(workArea.y + workArea.height - screenMargin - y, cap)) }
  }
  const y = workArea.y + workArea.height - gap
  return { edge: 'bottom', x, y, maxHeight: Math.max(1, Math.min(y - workArea.y - screenMargin, cap)) }
}

/**
 * The dashboard's window: frameless and transparent, shown beside the tray icon, sized to its content,
 * and hidden when it loses focus. The port of `MenuBarPanel` with `PanelHeightController`.
 */
export class PanelWindow {
  readonly window: BrowserWindow
  private anchor: Anchor | undefined
  private height = defaultHeight
  private opening = false
  private openTimer: ReturnType<typeof setTimeout> | undefined
  private sticky = false
  private menuDepth = 0
  private hiddenAt = 0
  onVisibilityChanged: ((visible: boolean) => void) | undefined

  constructor(options: { preload: string; devServerURL?: string; rendererFile: string }) {
    this.window = new BrowserWindow({
      width: panelWidth + shadowMargin * 2,
      height: defaultHeight + shadowMargin * 2,
      show: false,
      frame: false,
      transparent: true,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      hasShadow: false,
      alwaysOnTop: true,
      backgroundColor: '#00000000',
      webPreferences: {
        preload: options.preload,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        backgroundThrottling: false,
        spellcheck: false
      }
    })
    this.window.setAlwaysOnTop(true, 'pop-up-menu')
    this.window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
    this.window.setMenu(null)
    this.window.on('blur', () => {
      if (this.sticky || this.menuDepth > 0 || this.window.webContents.isDevToolsOpened()) return
      this.hide()
    })
    this.window.on('close', (event) => {
      if (!this.quitting) {
        event.preventDefault()
        this.hide()
      }
    })
    this.window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    this.window.webContents.on('will-navigate', (event) => event.preventDefault())
    if (options.devServerURL) void this.window.loadURL(options.devServerURL)
    else void this.window.loadFile(options.rendererFile)
  }

  quitting = false

  get isVisible(): boolean {
    return this.window.isVisible()
  }

  /** True for a moment after the panel hid itself: a click on the tray icon that took its focus must not reopen it. */
  get justHid(): boolean {
    return Date.now() - this.hiddenAt < 250
  }

  send(event: PanelEvent): void {
    if (!this.window.isDestroyed()) this.window.webContents.send(IpcChannels.event, event)
  }

  setSticky(sticky: boolean): void {
    this.sticky = sticky
  }

  setContentProtection(enabled: boolean): void {
    this.window.setContentProtection(enabled)
  }

  /** Runs `work` (a native menu or dialog) without the panel closing when it loses focus to it. */
  async holdingOpen<T>(work: () => Promise<T>): Promise<T> {
    this.menuDepth += 1
    try {
      return await work()
    } finally {
      // Focus returns to the panel a moment after a menu closes.
      setTimeout(() => {
        this.menuDepth -= 1
        if (this.menuDepth === 0 && this.isVisible && !this.window.isFocused() && !this.sticky) this.hide()
      }, 150)
    }
  }

  get maxHeight(): number {
    return this.anchor?.maxHeight ?? defaultHeight
  }

  /** Opens beside the tray icon. The window appears once the panel has said how tall its content is. */
  show(trayBounds: Rectangle, tab: DashboardTab, screenName?: 'dashboard' | 'settings'): void {
    const center = { x: Math.round(trayBounds.x + trayBounds.width / 2), y: Math.round(trayBounds.y + trayBounds.height / 2) }
    const display = screen.getDisplayNearestPoint(center)
    this.anchor = panelAnchor(trayBounds, display.workArea, display.bounds)
    this.height = Math.min(this.height, this.anchor.maxHeight)
    this.applyBounds()
    this.send({ type: 'shown', tab, screen: screenName })
    if (this.isVisible) {
      this.window.focus()
      return
    }
    this.opening = true
    if (this.openTimer !== undefined) clearTimeout(this.openTimer)
    this.openTimer = setTimeout(() => this.reveal(), 120)
  }

  private reveal(): void {
    if (!this.opening) return
    this.opening = false
    if (this.openTimer !== undefined) clearTimeout(this.openTimer)
    this.openTimer = undefined
    this.window.show()
    this.window.focus()
    this.onVisibilityChanged?.(true)
  }

  hide(): void {
    this.opening = false
    if (this.openTimer !== undefined) clearTimeout(this.openTimer)
    this.openTimer = undefined
    if (!this.isVisible) return
    this.hiddenAt = Date.now()
    this.window.hide()
    this.sticky = false
    this.send({ type: 'hidden' })
    this.onVisibilityChanged?.(false)
  }

  /** Takes the height the content wants, clamped to the screen, keeping the anchored edge where it is. */
  setHeight(requested: number): { height: number; anchor: 'top' | 'bottom' } {
    if (!this.anchor) return { height: this.height, anchor: 'bottom' }
    if (Number.isFinite(requested) && requested > 1) {
      this.height = Math.round(Math.min(requested, this.anchor.maxHeight))
      this.applyBounds()
    }
    if (this.opening) this.reveal()
    return { height: this.height, anchor: this.anchor.edge }
  }

  private applyBounds(): void {
    const anchor = this.anchor
    if (!anchor || this.window.isDestroyed()) return
    const top = anchor.edge === 'top' ? anchor.y : anchor.y - this.height
    try {
      this.window.setBounds({
        x: anchor.x - shadowMargin,
        y: Math.round(top) - shadowMargin,
        width: panelWidth + shadowMargin * 2,
        height: this.height + shadowMargin * 2
      })
    } catch (error) {
      AppLog.error('statusitem', `could not place the panel: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
}

export function rendererEntry(): { devServerURL?: string; rendererFile: string; preload: string } {
  return {
    devServerURL: process.env.ELECTRON_RENDERER_URL,
    rendererFile: join(__dirname, '../renderer/index.html'),
    preload: join(__dirname, '../preload/index.cjs')
  }
}
