import { describe, expect, it } from 'vitest'
import { AddAccountFlow } from '@core/app/AddAccountFlow'
import { AccountCredential, OAuthTokens, newUUID } from '@core/models/Account'
import { DevinLogin } from '@core/providers/devin/DevinLogin'
import { APIKeyLogin, CursorLogin } from '@core/services/DeviceProviderLogins'
import { HTTPResponse } from '@core/services/HTTPClient'
import type { LoginPrompt, ProviderLogin } from '@core/services/ProviderLogin'
import type { AccountStore } from '@core/stores/AccountStore'
import { AppInfo } from '@core/support/AppInfo'
import { OpenRouterFixtures } from './OpenRouterFixtures'
import { FailingVault, RoutingHTTPClient } from './TestSupport'
import { makeAccountStore, waitUntil } from './support/accountHelpers'

/** Upstream's private `IdentityLogin`: answers at once with a fresh credential. */
class IdentityLogin implements ProviderLogin {
  constructor(readonly credential: () => AccountCredential) {}

  async login(_prompt: (prompt: LoginPrompt) => Promise<void> | void, _pastedCode: AsyncIterable<string>): Promise<{ label: string; credential: AccountCredential }> {
    return { label: 'new@example.com', credential: this.credential() }
  }
}

function claude(identity: string): AccountCredential {
  return AccountCredential.oauth(OAuthTokens.make(newUUID().toUpperCase(), undefined, undefined, { [OAuthTokens.identityKey]: identity }))
}

function flowFor(store: AccountStore, credential: () => AccountCredential): AddAccountFlow {
  return new AddAccountFlow({ store, openURL: () => {}, login: () => new IdentityLogin(credential) })
}

/** Every sign-in is issued a new API key, so only the account's identity can tell it was added before. */
async function signInToDevin(store: AccountStore, team: string): Promise<AddAccountFlow> {
  const http = new RoutingHTTPClient((request) => {
    const body =
      new URL(request.url).hostname === 'api.codeium.com'
        ? `{"api_key":"devin-session-token$${newUUID().toUpperCase()}"}`
        : `{"userStatus":{"email":"rob@example.com","teamId":"${team}"}}`
    return new HTTPResponse(200, {}, body)
  })
  const flow = new AddAccountFlow({ store, openURL: () => {}, login: () => new DevinLogin(http) })
  flow.choose('devin')
  await waitUntil(() => flow.state.prompt !== undefined)
  flow.submitCode('one-time-token')
  await waitUntil(() => flow.finished || flow.state.errorMessage !== undefined)
  return flow
}

const labels = (store: AccountStore): string[] => store.accounts.map((account) => account.label)

describe('DuplicateLoginTests', () => {
  it('testSigningInToAnAddedClaudeAccountAgainNamesTheExistingOne', async () => {
    const store = makeAccountStore()
    store.add({ kind: 'claude', label: 'Work', credential: claude('acct/org') })

    const flow = flowFor(store, () => claude('acct/org'))
    flow.choose('claude')
    await waitUntil(() => flow.state.errorMessage !== undefined)

    expect(flow.state.errorMessage).toBe('This account is already added as Work.')
    expect(labels(store)).toEqual(['Work'])
    expect(flow.finished).toBe(false)
  })

  it('testAnotherAccountOrOrganizationOfTheSameProviderIsAdded', async () => {
    const store = makeAccountStore()
    store.add({ kind: 'claude', label: 'Work', credential: claude('acct/org') })

    const flow = flowFor(store, () => claude('acct/other-org'))
    flow.choose('claude')
    await waitUntil(() => flow.finished)
    expect(store.accounts.length).toBe(2)
  })

  it('testAnUnreadableStoredSignInDoesNotAllowADuplicateAccount', async () => {
    const vault = new FailingVault()
    vault.loadError.value = new Error('You don’t have permission to view it.')
    const store = makeAccountStore({ vault })
    store.add({ kind: 'claude', label: 'Work', credential: claude('acct/org') })

    const flow = flowFor(store, () => claude('acct/org'))
    flow.choose('claude')
    await waitUntil(() => flow.finished || flow.state.errorMessage !== undefined)

    // Upstream's message ends "Check Keychain access and try again."; there is no Keychain on Windows.
    expect(flow.state.errorMessage).toBe(`${AppInfo.name} couldn't check the saved sign-in for Work. Try again.`)
    expect(labels(store)).toEqual(['Work'])
  })

  it('testTheSameOrganizationIsNotAddedTwice', async () => {
    const store = makeAccountStore()
    store.add({ kind: 'copilot', label: 'acme', organization: 'acme', credential: AccountCredential.apiKey('first') })

    const flow = flowFor(store, () => AccountCredential.apiKey('second'))
    flow.choose('copilot')
    flow.chooseMethod({ type: 'organizationToken' })
    flow.addKey('second', '', 'ACME')
    await waitUntil(() => flow.state.errorMessage !== undefined)

    expect(flow.state.errorMessage).toBe('This account is already added as acme.')
    expect(labels(store)).toEqual(['acme'])
  })

  it('testSigningInToAnAddedCursorAccountAgainNamesTheExistingOne', async () => {
    const token = 'eyJhbGciOiJub25lIn0.' + Buffer.from('{"sub":"auth0|user_abc"}').toString('base64').replaceAll('=', '') + '.sig'
    const http = new RoutingHTTPClient(
      () => new HTTPResponse(200, {}, `{"accessToken":"${token}","refreshToken":"r","authId":"auth0|user_abc"}`)
    )
    const store = makeAccountStore()
    const first = new AddAccountFlow({ store, openURL: () => {}, login: () => new CursorLogin(http) })
    first.choose('cursor')
    await waitUntil(() => first.finished)
    expect(labels(store)).toEqual(['Cursor Account'])

    const again = new AddAccountFlow({ store, openURL: () => {}, login: () => new CursorLogin(http) })
    again.choose('cursor')
    await waitUntil(() => again.state.errorMessage !== undefined)

    expect(again.state.errorMessage).toBe('This account is already added as Cursor Account.')
    expect(store.accounts.length).toBe(1)
  })

  it('testSigningInToAnAddedDevinAccountAgainNamesTheExistingOne', async () => {
    const store = makeAccountStore()
    const first = await signInToDevin(store, 'devin-team$account-1')
    expect(first.finished).toBe(true)

    const again = await signInToDevin(store, 'devin-team$account-1')

    expect(again.state.errorMessage).toBe('This account is already added as rob@example.com.')
    expect(labels(store)).toEqual(['rob@example.com'])
  })

  it('testTheSameDevinEmailInAnotherOrganizationIsAdded', async () => {
    const store = makeAccountStore()
    await signInToDevin(store, 'devin-team$account-1')

    const other = await signInToDevin(store, 'devin-team$account-2')

    expect(other.finished).toBe(true)
    expect(store.accounts.length).toBe(2)
  })

  it('testTheSameAPIKeyIsNotAddedTwice', async () => {
    const store = makeAccountStore()
    store.add({ kind: 'openrouter', label: 'Personal', credential: AccountCredential.apiKey('sk-or-1') })

    const http = new RoutingHTTPClient(() => new HTTPResponse(200, {}, OpenRouterFixtures.standardKey))
    const flow = new AddAccountFlow({ store, openURL: () => {}, login: (kind) => new APIKeyLogin(kind, http) })
    flow.choose('openrouter')
    flow.addKey(' sk-or-1 ', '', '')
    await waitUntil(() => flow.state.errorMessage !== undefined)
    expect(flow.state.errorMessage).toBe('This account is already added as Personal.')
    expect(store.accounts.length).toBe(1)
  })

  it('testASignInWithoutAnIdentityIsAlwaysAdded', async () => {
    const store = makeAccountStore()
    store.add({ kind: 'claude', label: 'Old', credential: AccountCredential.oauth(OAuthTokens.make('a')) })

    const flow = flowFor(store, () => AccountCredential.oauth(OAuthTokens.make('b')))
    flow.choose('claude')
    await waitUntil(() => flow.finished)
    expect(store.accounts.length).toBe(2)
  })
})
