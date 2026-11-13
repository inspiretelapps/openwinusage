import type { CSSProperties, ReactNode } from 'react'
import { CLIProxyHub } from '@core/models/CLIProxyHub'
import type { Provider } from '@core/models/Provider'
import { AppInfo } from '@core/support/AppInfo'
import appMark from '../assets/app-mark.svg?raw'

const sources = import.meta.glob('../assets/provider-icons/*.svg', { query: '?raw', import: 'default', eager: true }) as Record<string, string>

const rawByID = new Map<string, string>([['app', appMark]])
for (const [path, svg] of Object.entries(sources)) {
  const id = path.slice(path.lastIndexOf('/') + 1, -'.svg'.length)
  rawByID.set(id, svg)
}

const trimmed = new Map<string, string>()

/**
 * A mark as a data URL whose view box is cropped to what is drawn, so every mark fills the same share
 * of its square whatever padding its file has (upstream's `ProviderMark`).
 */
export function markURL(id: string): string {
  const cached = trimmed.get(id)
  if (cached) return cached
  const raw = rawByID.get(id) ?? rawByID.get('app') ?? ''
  let url = `data:image/svg+xml;utf8,${encodeURIComponent(raw)}`
  try {
    const host = document.createElement('div')
    host.style.cssText = 'position:absolute;left:-9999px;top:-9999px;width:0;height:0;overflow:hidden;visibility:hidden'
    host.innerHTML = raw
    const svg = host.querySelector('svg')
    if (svg) {
      document.body.appendChild(host)
      const box = svg.getBBox()
      document.body.removeChild(host)
      if (box.width > 0 && box.height > 0) {
        svg.setAttribute('viewBox', `${box.x} ${box.y} ${box.width} ${box.height}`)
        svg.removeAttribute('width')
        svg.removeAttribute('height')
        url = `data:image/svg+xml;utf8,${encodeURIComponent(new XMLSerializer().serializeToString(svg))}`
      }
    }
  } catch {
    // Fall back to the file as it is.
  }
  trimmed.set(id, url)
  return url
}

/**
 * A provider's mark as a template image: it takes the current text color (secondary by default).
 * `id` is a provider kind, `cliproxyapi`, or `app` for this app's own mark.
 */
export function ProviderIcon(props: { id: string; side: number; inset?: number; className?: string; style?: CSSProperties }): ReactNode {
  const inset = props.inset ?? 0.14
  const url = markURL(props.id)
  const size = `${(1 - 2 * inset) * 100}%`
  return (
    <span
      aria-hidden
      className={props.className}
      style={{
        display: 'inline-block',
        flex: 'none',
        width: props.side,
        height: props.side,
        color: 'var(--text-secondary)',
        backgroundColor: 'currentColor',
        WebkitMaskImage: `url("${url}")`,
        WebkitMaskRepeat: 'no-repeat',
        WebkitMaskPosition: 'center',
        WebkitMaskSize: `${size} ${size}`,
        ...props.style
      }}
    />
  )
}

/**
 * An account's provider mark. An account mirrored from a CLIProxyAPI hub carries the hub's mark in the
 * bottom-trailing corner, cut out of the provider's mark so the two never touch.
 */
export function AccountIcon(props: { provider: Provider; side: number; inset?: number; style?: CSSProperties }): ReactNode {
  const { provider, side } = props
  if (provider.hubHost === undefined) return <ProviderIcon id={provider.kind} side={side} inset={props.inset} style={props.style} />
  const badge = side * 0.52
  const offset = side * 0.08
  const hole = badge * 1.24
  const center = side + offset + badge * 0.12 - hole / 2
  return (
    <span
      role="img"
      aria-label="Managed by CLIProxyAPI"
      style={{ position: 'relative', display: 'inline-block', flex: 'none', width: side, height: side, ...props.style }}
    >
      <span
        style={{
          position: 'absolute',
          inset: 0,
          WebkitMaskImage: `radial-gradient(circle ${hole / 2}px at ${center}px ${center}px, transparent 98%, #000 100%)`
        }}
      >
        <ProviderIcon id={provider.kind} side={side} inset={props.inset} />
      </span>
      <ProviderIcon id={CLIProxyHub.markID} side={badge} inset={0} style={{ position: 'absolute', right: -offset, bottom: -offset }} />
    </span>
  )
}

/** This app's own mark, in full color, for the empty dashboard and About. */
export function AppIcon(props: { side: number }): ReactNode {
  return (
    <span
      role="img"
      aria-label={AppInfo.name}
      style={{
        display: 'inline-grid',
        placeItems: 'center',
        width: props.side,
        height: props.side,
        borderRadius: props.side * 0.23,
        background: 'linear-gradient(160deg, #4c9bff, #1f5fe0)',
        boxShadow: '0 2px 6px rgba(0,0,0,0.18)'
      }}
    >
      <ProviderIcon id="app" side={props.side * 0.62} inset={0} style={{ color: '#fff' }} />
    </span>
  )
}
