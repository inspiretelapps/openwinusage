import { defaultsEnum, standardDefaults } from '../support/Defaults'
import type { Instant } from '../support/time'

export type TimeFormatSetting = 'auto' | '12h' | '24h'

function hourCycle(setting: TimeFormatSetting): Intl.DateTimeFormatOptions {
  switch (setting) {
    case 'auto':
      return {}
    case '12h':
      return { hourCycle: 'h12' }
    case '24h':
      return { hourCycle: 'h23' }
  }
}

/** ICU separates the time from AM/PM with a narrow no-break space; a plain space reads the same and measures predictably. */
function plainSpaces(text: string): string {
  return text.replace(/[  ]/g, ' ')
}

export const TimeFormatSetting = {
  key: 'timeFormat',
  allCases: ['auto', '12h', '24h'] as const satisfies readonly TimeFormatSetting[],

  get current(): TimeFormatSetting {
    return defaultsEnum(standardDefaults(), TimeFormatSetting.key, TimeFormatSetting.allCases, 'auto')
  },

  label(setting: TimeFormatSetting): string {
    switch (setting) {
      case 'auto':
        return 'Auto'
      case '12h':
        return '12-hour'
      case '24h':
        return '24-hour'
    }
  },

  /** `4:00 PM` or `16:00`. `base` is a BCP 47 locale; undefined is the system's. */
  shortTime(setting: TimeFormatSetting, date: Instant, base?: string, timeZone?: string): string {
    return plainSpaces(
      new Intl.DateTimeFormat(base, { hour: 'numeric', minute: '2-digit', timeZone, ...hourCycle(setting) }).format(date)
    )
  },

  /** `Wed 4:00 PM`, or `mié, 16:00` where the locale separates the weekday with a comma. */
  weekdayTime(setting: TimeFormatSetting, date: Instant, base?: string, timeZone?: string): string {
    return plainSpaces(
      new Intl.DateTimeFormat(base, {
        weekday: 'short',
        hour: 'numeric',
        minute: '2-digit',
        timeZone,
        ...hourCycle(setting)
      }).format(date)
    )
  }
}
