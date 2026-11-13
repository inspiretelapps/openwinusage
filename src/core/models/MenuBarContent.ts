import { DashboardLine } from './DashboardFamilies'
import { MenuBarLimit } from './MenuBarLimit'
import type { PriorityBoard } from './PriorityBoard'
import { Provider } from './Provider'

export interface MenuBarItem {
  readonly id: string
  readonly provider: Provider
  readonly label: string
  readonly shortLabel: string
  readonly value: string
}

/**
 * What the tray shows: the limits closest to running out. On macOS this is a strip of text in the menu
 * bar; on Windows the tray icon carries the first item and the tooltip lists them all.
 */
export interface MenuBarContent {
  readonly items: MenuBarItem[]
  overflow: number
  updateAvailable: boolean
}

export const MenuBarContent = {
  make(items: MenuBarItem[], overflow = 0, updateAvailable = false): MenuBarContent {
    return { items, overflow, updateAvailable }
  },

  isEmpty(content: MenuBarContent): boolean {
    return content.items.length === 0
  },

  accessibilityText(content: MenuBarContent): string {
    const shown = content.items.map((item) => `${Provider.fullName(item.provider)} ${item.label} ${item.value}`)
    const more = content.overflow > 0 ? [`${content.overflow} more`] : []
    const update = content.updateAvailable ? ['Update available'] : []
    return [...shown, ...more, ...update].join('; ')
  },

  equal(a: MenuBarContent, b: MenuBarContent): boolean {
    return JSON.stringify(a) === JSON.stringify(b)
  }
}

const genericWords = new Set(['models', 'bot', 'usage'])

export const MenuBarContentBuilder = {
  /** Only what's running out, or with `alwaysShows` every section of the Priority tab in its order, top to bottom. */
  build(board: PriorityBoard, limit: MenuBarLimit, alwaysShows = false): MenuBarContent {
    if (limit === 'iconOnly') return MenuBarContent.make([])
    const pair = (entry: { provider: Provider; line: DashboardLine }): { provider: Provider; line: DashboardLine } => ({
      provider: entry.provider,
      line: entry.line
    })
    const counted = alwaysShows
      ? [...board.pinned.map(pair), ...[...board.attention, ...board.useItOrLoseIt].map(pair)]
      : board.attention.map(pair)
    const usedUp = alwaysShows ? board.usedUp.map(pair) : []
    const shown = [...counted, ...usedUp].slice(0, MenuBarLimit.count(limit)).map(({ provider, line }): MenuBarItem => {
      const label = line.data.title
      return {
        id: DashboardLine.id(line),
        provider,
        label,
        shortLabel: MenuBarContentBuilder.shortLabel(label),
        value: line.data.menuBarValue
      }
    })
    return MenuBarContent.make(shown, Math.max(0, counted.length - shown.length))
  },

  shortLabel(label: string): string {
    const words = label.split(' ').filter((word) => word.length > 0)
    if (words.length <= 1) return label
    const last = words[words.length - 1]
    if (!genericWords.has(last.toLowerCase())) return label
    return words.slice(0, -1).join(' ')
  }
}
