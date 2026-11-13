import type { ReactNode } from 'react'
import { flushSync } from 'react-dom'
import { createRoot } from 'react-dom/client'
import { toPng } from 'html-to-image'
import { api } from '../../bridge'

function nextFrame(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()))
}

/**
 * Turns a card into a picture: the card is laid out off-screen in the panel's own document, so it
 * draws with the panel's theme and fonts, and is captured at four times its size.
 */
export const ShareCardRenderer = {
  scale: 4,

  /** A PNG data URL of `card`, or undefined when it could not be drawn. */
  async png(card: ReactNode): Promise<string | undefined> {
    const host = document.createElement('div')
    host.setAttribute('aria-hidden', 'true')
    host.style.cssText = 'position:fixed;left:-10000px;top:0;pointer-events:none;'
    document.body.appendChild(host)
    const root = createRoot(host, { identifierPrefix: 'share-card-' })
    try {
      flushSync(() => root.render(card))
      await document.fonts.ready
      await nextFrame()
      const node = host.firstElementChild
      if (!(node instanceof HTMLElement) || node.offsetWidth === 0 || node.offsetHeight === 0) return undefined
      return await toPng(node, { pixelRatio: ShareCardRenderer.scale, width: node.offsetWidth, height: node.offsetHeight, skipFonts: true })
    } catch (error) {
      console.error(`share card: failed to render a PNG: ${String(error)}`)
      return undefined
    } finally {
      root.unmount()
      host.remove()
    }
  },

  /** Puts a picture of `card` on the clipboard; answers whether it did. */
  async copy(card: ReactNode, name: string): Promise<boolean> {
    const dataURL = await ShareCardRenderer.png(card)
    if (dataURL === undefined) {
      console.error(`share card: failed to render a PNG for ${name}`)
      return false
    }
    try {
      const copied = await api.copyImage(dataURL)
      if (!copied) console.error('share card: the clipboard rejected the PNG')
      return copied
    } catch (error) {
      console.error(`share card: the clipboard rejected the PNG: ${String(error)}`)
      return false
    }
  }
}
