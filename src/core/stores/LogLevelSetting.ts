import { defaultsEnum, standardDefaults } from '../support/Defaults'

/** How much the app writes to its log. */
export type LogLevelSetting = 'error' | 'warn' | 'info' | 'debug'

const verbosity: Record<LogLevelSetting, number> = { error: 0, warn: 1, info: 2, debug: 3 }

export const LogLevelSetting = {
  key: 'logLevel',
  allCases: ['error', 'warn', 'info', 'debug'] as const satisfies readonly LogLevelSetting[],

  get current(): LogLevelSetting {
    return defaultsEnum(standardDefaults(), LogLevelSetting.key, LogLevelSetting.allCases, 'info')
  },

  label(setting: LogLevelSetting): string {
    switch (setting) {
      case 'error':
        return 'Error'
      case 'warn':
        return 'Warning'
      case 'info':
        return 'Info'
      case 'debug':
        return 'Debug'
    }
  },

  includes(setting: LogLevelSetting, line: LogLevelSetting): boolean {
    return verbosity[line] <= verbosity[setting]
  }
}
