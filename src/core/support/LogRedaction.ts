export const LogRedaction = {
  redactLogMessage(message: string): string {
    return message
      .replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, '[REDACTED]')
      .replace(/(?:sk-|pk-|api_|key_|secret_)[A-Za-z0-9_-]{12,}/g, '[REDACTED]')
      .replace(/account=[^,\s]+/g, 'account=[REDACTED]')
      .replace(/\/(?:Users|home|opt|private|var|tmp|Applications)\/[^\s"')]+/g, '[PATH]')
      // Windows home and temp paths, which the macOS patterns above never match.
      .replace(/[A-Za-z]:\\(?:Users|ProgramData|Program Files(?: \(x86\))?|Windows)\\[^\s"')]+/g, '[PATH]')
  }
}
