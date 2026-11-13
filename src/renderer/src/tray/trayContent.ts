import { MenuBarContent, MenuBarContentBuilder } from '@core/models/MenuBarContent'
import { PriorityBoard } from '@core/models/PriorityBoard'
import { DashboardLine } from '@core/models/DashboardFamilies'
import { Provider } from '@core/models/Provider'
import type { MeterSeverity } from '@core/models/WidgetData'
import { AppInfo } from '@core/support/AppInfo'
import type { Instant } from '@core/support/time'
import type { Stores } from '../state/stores'

/**
 * What the Windows tray icon shows. macOS draws a strip of text in the menu bar; the Windows tray has room
 * for one 16 px icon, so it carries the most urgent value and its tooltip lists what the strip would.
 */
export type TrayMark = { type: 'appMark' } | { type: 'badge'; text: string; severity: MeterSeverity }

export interface TrayContent {
  mark: TrayMark
  tooltip: string
  /** Whether the ranking can change without a new reading, so the icon is redrawn every 30 seconds. */
  needsClock: boolean
}

/** Windows cuts a tray tooltip at 127 characters. */
export const trayTooltipLimit = 127

/** As in upstream's `StatusItemController.updateImage`, read from the panel's copy of the stores. */
export function trayContent(stores: Stores, now: Instant): TrayContent {
  const privacy = stores.state.privacyMode
  // Windows cannot tell when the screen is shared, so Privacy Mode hides the figures whenever it is on.
  const limit = privacy.isEnabled || privacy.isConcealing ? 'iconOnly' : stores.data.menuBarLimit
  const updateAvailable = stores.state.updater.availableUpdateVersion !== undefined
  const board = stores.data.priorityBoard(limit === 'iconOnly' ? [] : stores.layout.displayGroups, stores.layout.state.priorityPinIDs, now)
  const content = MenuBarContentBuilder.build(board, limit, stores.data.menuBarAlwaysShows)
  content.updateAvailable = updateAvailable

  const first = content.items[0]
  const text = first ? badgeText(first.value) : undefined
  const mark: TrayMark =
    first && text !== undefined ? { type: 'badge', text, severity: severityOf(board, first.id) } : { type: 'appMark' }
  return { mark, tooltip: trayTooltip(content), needsClock: limit !== 'iconOnly' && PriorityBoard.requiresRankingClock(board, now) }
}

function severityOf(board: PriorityBoard, id: string): MeterSeverity {
  const lines = [...board.attention, ...board.usedUp, ...board.useItOrLoseIt, ...board.pinned].map((entry) => entry.line)
  return lines.find((line) => DashboardLine.id(line) === id)?.data.severity ?? 'normal'
}

/**
 * The value as it fits on a 16 px badge: at most three characters, digits first. "85%" is "85", "$4.20"
 * is "4", "1.2K" is "1K". Undefined when nothing short enough is left, and the tray shows the app mark.
 */
export function badgeText(value: string): string | undefined {
  const trimmed = value.trim()
  const withoutPercent = trimmed.replace(/%$/, '')
  const withoutSymbol = withoutPercent.replace(/^[^\d-]+/, '')
  const candidates = [withoutSymbol, withoutSymbol.replace(/[.,]\d+(?=\D*$)/, '')]
  return candidates.find((candidate) => candidate.length > 0 && candidate.length <= 3 && /\d/.test(candidate))
}

/** One line per limit the strip would show, then how many more, then the update. Cut to fit Windows' limit. */
export function trayTooltip(content: MenuBarContent): string {
  const lines = [AppInfo.name]
  for (const item of content.items) lines.push(`${Provider.fullName(item.provider)} ${item.shortLabel}: ${item.value}`)
  if (content.overflow > 0) lines.push(`+${content.overflow} more`)
  if (content.updateAvailable) lines.push('Update available')
  let text = lines.join('\n')
  if (text.length <= trayTooltipLimit) return text
  // Drop whole lines from the end of the list, keeping the update notice, until it fits.
  const tail = content.updateAvailable ? ['Update available'] : []
  const listed = lines.slice(0, lines.length - tail.length)
  while (listed.length > 1) {
    listed.pop()
    text = [...listed, '…', ...tail].join('\n')
    if (text.length <= trayTooltipLimit) return text
  }
  return text.slice(0, trayTooltipLimit)
}
