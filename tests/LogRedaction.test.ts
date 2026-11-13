import { describe, expect, it } from 'vitest'
import { LogRedaction } from '@core/support/LogRedaction'

describe('LogRedactionTests', () => {
  it('testRedactLogMessageJWTAndBareApiKey', () => {
    const msg =
      'token=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U key=sk-1234567890abcdef'
    expect(LogRedaction.redactLogMessage(msg)).toBe('token=[REDACTED] key=[REDACTED]')
  })

  it('testRedactLogMessageAccountEqAndPaths', () => {
    const msg = 'keychain read: service=Claude Code-credentials, account=rebers path=/opt/homebrew/bin/bunx home=/Users/rebers/.claude'
    expect(LogRedaction.redactLogMessage(msg)).toBe(
      'keychain read: service=Claude Code-credentials, account=[REDACTED] path=[PATH] home=[PATH]'
    )
  })
})
