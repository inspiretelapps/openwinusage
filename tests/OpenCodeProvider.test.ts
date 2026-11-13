import { describe, expect, it } from 'vitest'
import { Account, AccountCredential } from '@core/models/Account'
import { AccountProviderRuntime } from '@core/providers/AccountProviderRuntime'
import { HTTPResponse } from '@core/services/HTTPClient'
import { InMemoryCredentialVault, RoutingHTTPClient } from './TestSupport'

describe('OpenCodeProviderTests', () => {
  // Needs `AccountStore` (Stores), which is not ported yet.
  it.todo('testAccountSavedUnderTheOldRawValueStillLoads')

  it('testRefreshTagsTheAccountWithTheGoPlan', async () => {
    const account = Account.make({ kind: 'opencode', label: 'OpenCode' })
    const vault = new InMemoryCredentialVault()
    vault.save(AccountCredential.apiKey('key'), account.id)
    const body =
      '{"usage":{"rolling":{"percent":12,"resetsAt":"2026-07-12T13:30:00Z"},"weekly":{"percent":8,"resetsAt":"2026-07-13T00:00:00Z"},"monthly":{"percent":40,"resetsAt":"2026-08-04T11:18:32Z"}}}'
    const http = new RoutingHTTPClient(() => new HTTPResponse(200, {}, body))
    const runtime = new AccountProviderRuntime(account, vault, http)

    const result = await runtime.refresh()
    if (!result.ok) throw new Error(result.failure.message)
    const snapshot = result.snapshot

    expect(snapshot.displayName).toBe('OpenCode')
    expect(snapshot.plan).toBe('Go')
    expect(snapshot.lines.map((line) => line.label)).toEqual(['Session', 'Weekly', 'Monthly'])
    expect(runtime.widgetDescriptors.map((descriptor) => descriptor.id)[0]).toBe(`${Account.cardID(account)}.session`)
  })
})
