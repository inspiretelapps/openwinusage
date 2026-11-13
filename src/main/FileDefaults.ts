import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { AppLog, describeError } from '@core/support/AppLog'
import { MemoryDefaults } from '@core/support/Defaults'

/**
 * The app's preferences as one JSON file in its data folder: the port of the macOS defaults domain.
 * Writes are gathered for a moment and replace the file whole, so a crash never leaves half a file.
 * The command line reads this same file.
 */
export class FileDefaults extends MemoryDefaults {
  private timer: ReturnType<typeof setTimeout> | undefined

  constructor(private readonly path: string) {
    super(FileDefaults.read(path))
    this.onChange(() => this.schedule())
  }

  static read(path: string): Record<string, unknown> {
    try {
      const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'))
      return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {}
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') AppLog.error('config', `cannot read preferences: ${describeError(error)}`)
      return {}
    }
  }

  private schedule(): void {
    if (this.timer !== undefined) return
    this.timer = setTimeout(() => this.flush(), 150)
  }

  /** Writes now. Called before the app quits. */
  flush(): void {
    if (this.timer !== undefined) clearTimeout(this.timer)
    this.timer = undefined
    try {
      mkdirSync(dirname(this.path), { recursive: true })
      const temporary = `${this.path}.tmp`
      writeFileSync(temporary, JSON.stringify(this.snapshot()), 'utf8')
      renameSync(temporary, this.path)
    } catch (error) {
      AppLog.error('config', `cannot save preferences: ${describeError(error)}`)
    }
  }
}
