import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { MeterSeverity } from '@core/models/WidgetData'
import type { TrayIconUpdate } from '@shared/ipc'
import { api } from '../bridge'
import { useStores } from '../state/context'
import { trayContent, type TrayMark } from './trayContent'

/** The scale factors Windows asks a tray icon for, on a 16 px base. */
const scaleFactors = [1, 1.25, 1.5, 2, 2.5, 3]
const baseSide = 16

// The paths of `assets/app-mark.svg`, in its 100 × 100 box.
const markPaths = {
  ring: 'M50 8a42 42 0 1 0 42 42h-13a29 29 0 1 1-29-29z',
  arc: 'M58 8.7A42 42 0 0 1 91.3 42H78.1A29 29 0 0 0 58 21.9z'
}

const badgeColors: Record<MeterSeverity, [string, string]> = {
  // The app icon's blue, then Theme.severityColor's orange and red.
  normal: ['#4c9bff', '#1f5fe0'],
  warning: ['#ffa040', '#e8750f'],
  critical: ['#ff5a5d', '#d9262a']
}

function roundedSquare(context: CanvasRenderingContext2D, side: number, colors: [string, string]): void {
  const gradient = context.createLinearGradient(0, 0, 0, side)
  gradient.addColorStop(0, colors[0])
  gradient.addColorStop(1, colors[1])
  context.fillStyle = gradient
  context.beginPath()
  context.roundRect(0, 0, side, side, side * 0.23)
  context.fill()
}

function drawAppMark(context: CanvasRenderingContext2D, side: number): void {
  roundedSquare(context, side, badgeColors.normal)
  const inset = side * 0.17
  context.save()
  context.translate(inset, inset)
  context.scale((side - inset * 2) / 100, (side - inset * 2) / 100)
  context.fillStyle = '#fff'
  context.fill(new Path2D(markPaths.ring))
  context.beginPath()
  context.arc(50, 50, 6, 0, Math.PI * 2)
  context.fill()
  context.globalAlpha = 0.55
  context.fill(new Path2D(markPaths.arc))
  context.restore()
}

function drawBadge(context: CanvasRenderingContext2D, side: number, text: string, severity: MeterSeverity): void {
  roundedSquare(context, side, badgeColors[severity])
  const maxWidth = side * 0.86
  let size = side * (text.length <= 2 ? 0.66 : 0.52)
  const font = (px: number): string => `700 ${px}px "Segoe UI Variable Display", "Segoe UI", system-ui, sans-serif`
  context.font = font(size)
  while (context.measureText(text).width > maxWidth && size > side * 0.35) {
    size -= side * 0.03
    context.font = font(size)
  }
  context.fillStyle = '#fff'
  context.textAlign = 'center'
  // Measure on the alphabetic baseline, then center on the digits' ink rather than the line box.
  context.textBaseline = 'alphabetic'
  const metrics = context.measureText(text)
  const ink = metrics.actualBoundingBoxAscent - metrics.actualBoundingBoxDescent
  context.fillText(text, side / 2, side / 2 + ink / 2)
}

/** The tray icon as a PNG data URL, `16 × scale` pixels square. Settings shows it in its preview. */
export function renderTrayMark(mark: TrayMark, scale: number): string {
  const side = Math.round(baseSide * scale)
  const canvas = document.createElement('canvas')
  canvas.width = side
  canvas.height = side
  const context = canvas.getContext('2d')
  if (!context) return ''
  if (mark.type === 'badge') drawBadge(context, side, mark.text, mark.severity)
  else drawAppMark(context, side)
  return canvas.toDataURL('image/png')
}

export function trayIconUpdate(mark: TrayMark, tooltip: string): TrayIconUpdate {
  return {
    images: scaleFactors.map((scaleFactor) => ({ scaleFactor, dataURL: renderTrayMark(mark, scaleFactor) })).filter((image) => image.dataURL !== ''),
    tooltip
  }
}

/**
 * Keeps the tray icon current. Renders nothing; mount it once inside `<StoresProvider>`. The icon is redrawn
 * only when what it shows changes, and every 30 seconds while the ranking can change on its own.
 */
export function TrayIconUpdater(): ReactNode {
  const stores = useStores()
  const [tick, setTick] = useState(0)
  const last = useRef<string | undefined>(undefined)
  const content = trayContent(stores, Date.now())

  useEffect(() => {
    const key = JSON.stringify([content.mark, content.tooltip])
    if (key === last.current) return
    last.current = key
    void api.trayUpdate(trayIconUpdate(content.mark, content.tooltip))
  })

  useEffect(() => {
    if (!content.needsClock) return
    const timer = setTimeout(() => setTick((value) => value + 1), 30_000)
    return () => clearTimeout(timer)
  }, [content.needsClock, tick, stores])

  return null
}
