import { defaultsEnum, standardDefaults } from '../support/Defaults'

/** Explicit appearance override for the whole app; `system` follows Windows. */
export type AppearanceSetting = 'system' | 'light' | 'dark'

export const AppearanceSetting = {
  key: 'appearance',
  allCases: ['system', 'light', 'dark'] as const satisfies readonly AppearanceSetting[],

  get current(): AppearanceSetting {
    return defaultsEnum(standardDefaults(), AppearanceSetting.key, AppearanceSetting.allCases, 'system')
  },

  label(setting: AppearanceSetting): string {
    switch (setting) {
      case 'system':
        return 'System'
      case 'light':
        return 'Light'
      case 'dark':
        return 'Dark'
    }
  }
}
