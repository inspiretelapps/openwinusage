import { useMemo, type ReactNode } from 'react'
import { MenuBarLimit } from '@core/models/MenuBarLimit'
import { renderTrayMark } from '../../tray/TrayIconUpdater'
import { badgeText, type TrayMark } from '../../tray/trayContent'
import { useStores } from '../../state/context'

const samples: readonly { provider: string; label: string; value: string }[] = [
  { provider: 'Claude', label: 'Weekly', value: '38%' },
  { provider: 'Claude', label: 'Session', value: '26%' },
  { provider: 'ChatGPT', label: 'Weekly', value: '31%' },
  { provider: 'Cursor', label: 'Extra', value: '$310' },
  { provider: 'Antigravity', label: 'Gemini', value: '12%' },
  { provider: 'Grok', label: 'Weekly', value: '9%' },
  { provider: 'Copilot', label: 'Credits', value: '7%' }
]

/** The sample limits a setting shows, and how many it leaves to the `+N` count. */
export function sample(limit: MenuBarLimit): { items: typeof samples; overflow: number } {
  if (limit === 'iconOnly') return { items: [], overflow: 0 }
  const items = samples.slice(0, MenuBarLimit.count(limit))
  return { items, overflow: samples.length - items.length }
}

/**
 * Upstream's `PriorityIconsPreview` shows sample menu-bar strips at the number the setting picks. The
 * Windows tray has no strip: it shows the tray icon as it would look with sample limits, and the tooltip
 * that lists them, so every choice looks different whatever is running out right now.
 */
export function PriorityIconsPreview(): ReactNode {
  const limit = useStores().data.menuBarLimit
  const content = sample(limit)
  const firstValue = content.items[0]?.value
  const image = useMemo(() => {
    const text = firstValue === undefined ? undefined : badgeText(firstValue)
    const mark: TrayMark = text === undefined ? { type: 'appMark' } : { type: 'badge', text, severity: 'warning' }
    // Shown 24 px square (1.5 × the 16 px icon), drawn at twice the screen's pixels so it stays sharp.
    return renderTrayMark(mark, 1.5 * 2 * Math.max(1, Math.ceil(window.devicePixelRatio)))
  }, [firstValue])
  return (
    <div className="priority-preview" role="img" aria-label="Tray Preview">
      <img className="priority-preview-icon" src={image} width={24} height={24} alt="" />
      <div className="priority-preview-tooltip">
        {content.items.length === 0 ? (
          <span className="secondary">App icon only</span>
        ) : (
          <>
            {content.items.map((item, index) => (
              <span key={index}>
                {item.provider} {item.label}: <span className="mono-digits">{item.value}</span>
              </span>
            ))}
            {content.overflow > 0 ? <span className="secondary">+{content.overflow} more</span> : null}
          </>
        )}
      </div>
    </div>
  )
}
