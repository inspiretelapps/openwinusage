import { describe, expect, it } from 'vitest'
import { MenuBarContent, type MenuBarItem } from '@core/models/MenuBarContent'
import { badgeText, trayTooltip, trayTooltipLimit } from '../src/renderer/src/tray/trayContent'

// Not a port: the Windows tray icon has no upstream counterpart.
describe('TrayContent', () => {
  it('fits a value on the badge in three characters', () => {
    expect(badgeText('85%')).toBe('85')
    expect(badgeText('100%')).toBe('100')
    expect(badgeText('$4.20')).toBe('4')
    expect(badgeText('$12')).toBe('12')
    expect(badgeText('1.2K')).toBe('1K')
    expect(badgeText('$1.5K')).toBe('1K')
    expect(badgeText('—')).toBeUndefined()
    expect(badgeText('12345')).toBeUndefined()
  })

  const item = (index: number): MenuBarItem =>
    ({
      id: `id-${index}`,
      provider: { id: `p${index}`, kind: 'claude', name: 'Claude', accountLabel: '' },
      label: `Weekly limit ${index}`,
      shortLabel: `Weekly limit ${index}`,
      value: `${index}%`
    }) as unknown as MenuBarItem

  it('lists items, the overflow, then the update', () => {
    const text = trayTooltip(MenuBarContent.make([item(1)], 2, true))
    const lines = text.split('\n')
    expect(lines[1]).toContain('Weekly limit 1: 1%')
    expect(lines[2]).toBe('+2 more')
    expect(lines[3]).toBe('Update available')
  })

  it('stays within the Windows tooltip limit and keeps the update notice', () => {
    const text = trayTooltip(MenuBarContent.make([1, 2, 3, 4, 5].map(item), 4, true))
    expect(text.length).toBeLessThanOrEqual(trayTooltipLimit)
    expect(text.endsWith('Update available')).toBe(true)
  })
})
