import { describe, expect, it } from 'vitest'
import { Account, AccountCredential, OAuthTokens } from '@core/models/Account'
import { AccountProviderRuntime } from '@core/providers/AccountProviderRuntime'
import { GrokUsageClient } from '@core/providers/grok/GrokUsageClient'
import { HTTPResponse } from '@core/services/HTTPClient'
import { InMemoryCredentialVault, isolatedDefaults, RoutingHTTPClient, TestSwitch } from './TestSupport'
import { storeForTesting } from './support/dataStoreHelpers'

describe('WidgetDataStorePlanTests', () => {
  it('testAGrokTeamAccountShowsItsPlanAndTheNoticeWithNoRows', async () => {
    const account = Account.make({ kind: 'grok', label: 'Team' })
    const vault = new InMemoryCredentialVault()
    vault.save(AccountCredential.oauth(OAuthTokens.make('token')), account.id)
    const settings = '{"subscription_tier_display":"SuperGrok Business"}'
    const noPersonalTeam = '{"error":"principal has no personal team"}'
    const billingStatus = new TestSwitch(412)
    const http = new RoutingHTTPClient((request) =>
      request.url === GrokUsageClient.settingsURL ? new HTTPResponse(200, {}, settings) : new HTTPResponse(billingStatus.value, {}, noPersonalTeam)
    )
    const runtime = new AccountProviderRuntime(account, vault, http)
    const store = storeForTesting([runtime], { defaults: isolatedDefaults() })
    const id = runtime.provider.id

    await store.refreshAll()
    expect(store.plan(id)).toBe('SuperGrok Business')
    expect(store.notice(id)).toBe('Grok team accounts have no personal quota.')
    expect(
      runtime.widgetDescriptors.some((descriptor) => store.data(descriptor).hasData),
      'a team account has no usage rows'
    ).toBe(false)

    billingStatus.value = 500
    await store.refreshAll(true)
    expect(store.notice(id), "a failed refresh shows its error, not the last snapshot's notice").toBe(
      'The provider request failed (HTTP 500).'
    )
    expect(store.plan(id)).toBe('SuperGrok Business')
  })
})
