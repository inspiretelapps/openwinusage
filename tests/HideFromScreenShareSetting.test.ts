import { describe, expect, it } from 'vitest'
import { HideFromScreenShareSetting } from '@core/stores/HideFromScreenShareSetting'
import { TestSwitch, isolatedDefaults } from './TestSupport'

/**
 * Upstream injects `installChangeNotifications`, which the setting calls when it starts watching the
 * capture. This port watches by polling `isScreenCaptured`, so a capture check stands for that call.
 */
describe('HideFromScreenShareSettingTests', () => {
  it('testUsageIsConcealedOnlyWhileTheSettingIsOnAndTheScreenIsCaptured', () => {
    const cases: [boolean, boolean][] = [
      [true, true],
      [true, false],
      [false, true]
    ]
    for (const [enabled, captured] of cases) {
      const watched = new TestSwitch(false)
      const setting = new HideFromScreenShareSetting(isolatedDefaults(), () => {
        watched.value = true
        return captured
      })
      try {
        expect(setting.isEnabled, 'off by default').toBe(false)
        setting.isEnabled = enabled

        expect(setting.isConcealing, `on: ${enabled}, captured: ${captured}`).toBe(enabled && captured)
        expect(watched.value, 'the capture is watched only while the setting is on').toBe(enabled)
      } finally {
        setting.dispose()
      }
    }
  })

  it('testTheSettingReadsAndWritesTheKeyVersion0716Saved', () => {
    const defaults = isolatedDefaults()
    defaults.set('hideUsageWhileScreenSharing', true)
    const setting = new HideFromScreenShareSetting(defaults, () => true)
    try {
      expect(setting.isEnabled).toBe(true)
      expect(setting.isConcealing, 'a saved setting conceals from launch').toBe(true)

      setting.isEnabled = false
      expect(defaults.get('hideUsageWhileScreenSharing')).toBe(false)
      expect(setting.isConcealing, 'turning it off shows usage at once').toBe(false)
    } finally {
      setting.dispose()
    }
  })
})
