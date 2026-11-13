import { app } from 'electron'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { PanelWindow } from './PanelWindow'

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * A development aid behind `--capture=<folder>`: opens the panel, saves a picture of each screen in
 * light and dark, and quits. Run with `--demo` so the pictures show sample data.
 */
export async function capture(panel: PanelWindow, folder: string, open: () => void): Promise<void> {
  mkdirSync(folder, { recursive: true })
  const contents = panel.window.webContents
  const run = (script: string): Promise<unknown> => contents.executeJavaScript(script, true)
  const shoot = async (name: string): Promise<void> => {
    await wait(700)
    const image = await contents.capturePage()
    writeFileSync(join(folder, `${name}.png`), image.toPNG())
  }
  const clickText = (text: string): Promise<unknown> =>
    run(`(() => { const el = [...document.querySelectorAll('button,[role=tab]')].find((b) => b.textContent.trim() === ${JSON.stringify(text)}); if (el) { el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })); el.click() } return !!el })()`)
  const key = (code: string, modifiers: string[] = []): void => {
    contents.sendInputEvent({ type: 'keyDown', keyCode: code, modifiers: modifiers as Electron.InputEvent['modifiers'] })
    contents.sendInputEvent({ type: 'keyUp', keyCode: code, modifiers: modifiers as Electron.InputEvent['modifiers'] })
  }
  panel.setSticky(true)
  await wait(1500)
  open()
  await wait(1500)
  for (const theme of ['light', 'dark']) {
    await run(`window.winusage.call('setSetting', 'appearance', ${JSON.stringify(theme)})`)
    await clickText('Priority')
    await shoot(`priority-${theme}`)
    await clickText('All Usage')
    await shoot(`all-usage-${theme}`)
    key('Enter')
    await shoot(`accounts-${theme}`)
    key('Escape')
    await wait(400)
    key(',', ['control'])
    await shoot(`settings-general-${theme}`)
    for (const tab of ['Display', 'Alerts', 'Advanced']) {
      await clickText(tab)
      await shoot(`settings-${tab.toLowerCase()}-${theme}`)
    }
    key('Escape')
    await wait(400)
  }
  app.quit()
}
