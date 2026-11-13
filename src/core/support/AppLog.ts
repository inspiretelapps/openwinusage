import { AppInfo } from './AppInfo'
import { LogRedaction } from './LogRedaction'

/** The log categories. Pass one of these, or any string such as `LogTags.auth(id)`. */
export type LogTag =
  | 'refresh'
  | 'cache'
  | 'http'
  | 'auth'
  | 'updates'
  | 'config'
  | 'statusitem'
  | 'lifecycle'
  | 'notifications'

export const LogTags = {
  plugin: (id: string) => `plugin:${id}`,
  auth: (id: string) => `auth:${id}`
}

/** How much is written. The raw values are the stored setting's (`LogLevelSetting`). */
export type LogLevel = 'error' | 'warn' | 'info' | 'debug'

const verbosity: Record<LogLevel, number> = { error: 0, warn: 1, info: 2, debug: 3 }

export interface LogLine {
  level: LogLevel
  /** A notice is an info line the sink should keep on disk even when it drops other info lines. */
  notice: boolean
  tag: string
  message: string
  at: number
}

type Message = string | (() => string)

/**
 * The app's log. Lines below the current level are dropped, and every message is redacted before it
 * reaches the sink. The desktop app installs a sink that writes to its log file; the default sink is
 * silent so tests and the command line stay quiet.
 */
export const AppLog = {
  level: 'info' as LogLevel,
  sink: undefined as ((line: LogLine) => void) | undefined,

  bootstrap(): void {
    AppLog.info('config', `${AppInfo.name} ${AppInfo.version} starting`)
  },

  error(tag: LogTag | string, message: Message): void {
    emit('error', false, tag, message)
  },
  warn(tag: LogTag | string, message: Message): void {
    emit('warn', false, tag, message)
  },
  info(tag: LogTag | string, message: Message): void {
    emit('info', false, tag, message)
  },
  /** For the lines read after the fact to check what the app did, such as each refresh pass's start and end. */
  notice(tag: LogTag | string, message: Message): void {
    emit('info', true, tag, message)
  },
  debug(tag: LogTag | string, message: Message): void {
    emit('debug', false, tag, message)
  }
}

function emit(level: LogLevel, notice: boolean, tag: string, message: Message): void {
  if (verbosity[level] > verbosity[AppLog.level]) return
  const sink = AppLog.sink
  if (!sink) return
  const text = typeof message === 'function' ? message() : message
  sink({ level, notice, tag, message: LogRedaction.redactLogMessage(text), at: Date.now() })
}

/** `error.localizedDescription` */
export function describeError(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}
