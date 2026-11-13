import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { UsageReader, UsageReaderError } from '@core/services/UsageReader'
import { AppInfo } from '@core/support/AppInfo'
import { MemoryDefaults } from '@core/support/Defaults'
import { CLIArguments, CLIError } from './CLIArguments'

const command = AppInfo.commandName

const help = `Usage: ${command} [provider]

Print the usage ${AppInfo.name} last fetched, as openusage.limits.v2 JSON, and exit. The app refreshes
on its own schedule; this command never refreshes or signs in.

provider      An account id (codex@1a2b3c4d) or a provider kind (claude, codex) for every
              account of that kind. Omit it for every account.

Options:
  -v, --version
  -h, --help

Exit codes: 0 printed, 2 bad arguments or unknown provider, 4 nothing fetched yet.`

function fail(message: string, code: number): never {
  process.stderr.write(`${command}: ${message}\n`)
  process.exit(code)
}

/** The app's data folder, where it keeps `preferences.json`. */
function dataFolder(): string {
  if (process.platform === 'win32') return join(process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'), AppInfo.name)
  if (process.platform === 'darwin') return join(homedir(), 'Library', 'Application Support', AppInfo.name)
  return join(process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), AppInfo.name)
}

function version(): string | undefined {
  try {
    const manifest = JSON.parse(readFileSync(join(__dirname, '../../package.json'), 'utf8')) as { version?: string }
    return manifest.version
  } catch {
    return undefined
  }
}

function main(): void {
  try {
    // Under ELECTRON_RUN_AS_NODE the arguments follow the script path, as in Node.
    const parsed = CLIArguments.parse(process.argv.slice(2))
    if (parsed.showHelp) {
      process.stdout.write(help + '\n')
      return
    }
    if (parsed.showVersion) {
      const found = version()
      process.stdout.write((found ? `${command} ${found}` : `${command} (development build)`) + '\n')
      return
    }
    if (parsed.force) process.stderr.write(`${command}: --force does nothing; the command prints what the app last fetched\n`)
    const file = join(dataFolder(), 'preferences.json')
    let stored: Record<string, unknown> = {}
    if (existsSync(file)) {
      try {
        stored = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>
      } catch {
        fail(`Could not read the ${AppInfo.name} settings.`, 4)
      }
    }
    const result = UsageReader.read(new MemoryDefaults(stored), parsed.providerID)
    process.stdout.write(result.data + '\n')
    if (!result.hasSnapshots) fail(`nothing fetched yet; open ${AppInfo.name} and add or refresh an account`, 4)
  } catch (error) {
    if (error instanceof CLIError) fail(`${error.message}\nRun '${command} --help' for usage.`, 2)
    if (error instanceof UsageReaderError) fail(`Unknown provider: ${error.providerID}`, 2)
    fail(error instanceof Error ? error.message : String(error), 4)
  }
}

main()
