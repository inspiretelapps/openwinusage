import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { AppInfo } from '@core/support/AppInfo'
import { AppLog, describeError } from '@core/support/AppLog'
import { Observable } from '@core/support/Observable'
import type { CommandLineState, CommandLineStatus } from '@shared/ipc'

function powershell(script: string): string {
  return execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 15_000
  })
}

function samePath(a: string, b: string): boolean {
  const clean = (path: string): string => path.trim().replace(/[\\/]+$/, '').toLowerCase()
  return clean(a) === clean(b)
}

/**
 * Puts the app's command on the user's PATH: the Windows take on the macOS Terminal Helper, which
 * links `/usr/local/bin/openusage`. It edits only the user's own PATH (no administrator prompt) and
 * adds or removes exactly the app's `bin` folder.
 */
export class CommandLineTool extends Observable {
  /** The folder that holds `winusage.cmd`, inside the installed app. */
  readonly folder: string
  private status: CommandLineStatus
  private errorMessage: string | undefined

  constructor(resourcesPath: string) {
    super()
    this.folder = join(resourcesPath, 'bin')
    this.status = this.currentStatus()
  }

  get state(): CommandLineState {
    const state: CommandLineState = { status: this.status, folder: this.folder }
    if (this.errorMessage !== undefined) state.errorMessage = this.errorMessage
    return state
  }

  private userPath(): string[] {
    return powershell("[Environment]::GetEnvironmentVariable('Path','User')")
      .split(';')
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0)
  }

  private currentStatus(): CommandLineStatus {
    if (process.platform !== 'win32' || !existsSync(join(this.folder, `${AppInfo.commandName}.cmd`))) return 'unavailable'
    try {
      return this.userPath().some((entry) => samePath(entry, this.folder)) ? 'installed' : 'notInstalled'
    } catch (error) {
      AppLog.error('config', `cannot read the user PATH: ${describeError(error)}`)
      return 'unavailable'
    }
  }

  refreshStatus(): void {
    this.status = this.currentStatus()
    this.notify()
  }

  private write(entries: string[]): void {
    // The value travels in an environment variable, so nothing in a folder name is ever read as script.
    execFileSync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', "[Environment]::SetEnvironmentVariable('Path', $env:WINUSAGE_NEW_PATH, 'User')"],
      { encoding: 'utf8', windowsHide: true, timeout: 15_000, env: { ...process.env, WINUSAGE_NEW_PATH: entries.join(';') } }
    )
  }

  install(): void {
    this.change('install', (entries) => (entries.some((entry) => samePath(entry, this.folder)) ? undefined : [...entries, this.folder]))
  }

  uninstall(): void {
    this.change('uninstall', (entries) => {
      const kept = entries.filter((entry) => !samePath(entry, this.folder))
      return kept.length === entries.length ? undefined : kept
    })
  }

  private change(action: string, edit: (entries: string[]) => string[] | undefined): void {
    this.errorMessage = undefined
    this.status = this.currentStatus()
    if (this.status === 'unavailable') {
      this.errorMessage = `The bundled terminal helper couldn't be found. Reinstall ${AppInfo.name} and try again.`
      this.notify()
      return
    }
    try {
      const next = edit(this.userPath())
      if (next) this.write(next)
    } catch (error) {
      AppLog.error('config', `terminal helper ${action} failed: ${describeError(error)}`)
      this.errorMessage = `${AppInfo.name} couldn't update your PATH. Try again.`
    }
    this.status = this.currentStatus()
    this.notify()
  }
}
