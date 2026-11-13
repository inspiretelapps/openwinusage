export class CLIError extends Error {}

export interface CLIArguments {
  providerID?: string
  showHelp: boolean
  showVersion: boolean
  force: boolean
}

export const CLIArguments = {
  parse(args: string[]): CLIArguments {
    const parsed: CLIArguments = { showHelp: false, showVersion: false, force: false }
    for (const argument of args) {
      switch (argument) {
        case '-h':
        case '--help':
          parsed.showHelp = true
          break
        case '-v':
        case '--version':
          parsed.showVersion = true
          break
        case '--force':
          parsed.force = true
          break
        default:
          if (argument.startsWith('-')) throw new CLIError(`Unknown option: ${argument}`)
          if (parsed.providerID !== undefined) throw new CLIError('Only one provider can be requested at a time.')
          parsed.providerID = argument.toLowerCase()
      }
    }
    return parsed
  }
}
