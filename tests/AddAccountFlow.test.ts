import { describe, expect, it } from 'vitest'
import { AddAccountFlow } from '@core/app/AddAccountFlow'
import { Account, AccountCredential, OAuthTokens, type ProviderAuthMethod } from '@core/models/Account'
import { ProviderError } from '@core/providers/ProviderError'
import { APIKeyLogin } from '@core/services/DeviceProviderLogins'
import { HTTPResponse } from '@core/services/HTTPClient'
import { LoginError, nextPastedCode } from '@core/services/OAuthLoginSupport'
import { LoginPrompt } from '@core/services/ProviderLogin'
import type { AccountStore } from '@core/stores/AccountStore'
import { OpenRouterFixtures } from './OpenRouterFixtures'
import { InMemoryCredentialVault, RoutingHTTPClient, TestSwitch } from './TestSupport'
import { StubLogin, canAddKey, canSubmitCode, makeAccountStore, tick, untilCancelled, waitUntil } from './support/accountHelpers'

function makeStore(vault: InMemoryCredentialVault = new InMemoryCredentialVault()): AccountStore {
  return makeAccountStore({ vault })
}

const access = (token: string): AccountCredential => AccountCredential.oauth(OAuthTokens.make(token))

describe('AddAccountFlowTests', () => {
  it('testFailedSignInCanBeRetriedAndAddsTheAccount', async () => {
    const store = makeStore()
    let attempts = 0
    const flow = new AddAccountFlow({
      store,
      openURL: () => {},
      login: () => {
        attempts += 1
        return attempts === 1
          ? new StubLogin(async () => {
              throw LoginError.invalidCode
            })
          : new StubLogin(async () => ({ label: 'claude@example.com', credential: access('access') }))
      }
    })
    flow.choose('claude')
    await waitUntil(() => flow.state.errorMessage !== undefined)
    expect(flow.state.errorMessage).toBe(LoginError.invalidCode.message)
    expect(store.accounts.length).toBe(0)

    flow.signIn()
    await waitUntil(() => flow.finished)
    expect(flow.state.errorMessage).toBeUndefined()
    expect(store.accounts.map((account) => account.label)).toEqual(['claude@example.com'])
    expect(store.accounts.map((account) => account.kind)).toEqual(['claude'])
  })

  it('testSigningInAgainReplacesTheSignInAndAddsNoAccount', async () => {
    const store = makeStore()
    const account = store.add({ kind: 'claude', label: 'Personal', credential: access('old') })
    const replaced: [AccountCredential, string][] = []
    const flow = new AddAccountFlow({
      store,
      openURL: () => {},
      login: () => new StubLogin(async () => ({ label: 'someone@example.com', credential: access('new') })),
      replaceCredential: async (credential, providerID) => {
        replaced.push([credential, providerID])
      },
      signingInAgainTo: account
    })
    expect(flow.state.provider, "the sheet opens on the account's sign-in, not the provider list").toBe('claude')
    expect(flow.state.isWorking, 'creating the flow must not open a browser').toBe(false)

    flow.startSigningInAgain()
    await waitUntil(() => flow.finished)

    expect(replaced.map((entry) => entry[1])).toEqual([Account.cardID(account)])
    expect(store.accounts.map((candidate) => candidate.label)).toEqual(['Personal'])
  })

  it('testAPIKeyIsSavedUnderTheTypedName', async () => {
    const vault = new InMemoryCredentialVault()
    const store = makeStore(vault)
    const http = new RoutingHTTPClient(() => new HTTPResponse(200, {}, OpenRouterFixtures.standardKey))
    const flow = new AddAccountFlow({ store, openURL: () => {}, login: (kind) => new APIKeyLogin(kind, http) })
    flow.choose('openrouter')
    expect(flow.state.isWorking).toBe(false)
    expect(canAddKey(flow, '')).toBe(false)

    const apiKey = '  sk-or-key  '
    const accountName = ' Work '
    flow.addKey(apiKey, accountName, '')
    await waitUntil(() => flow.finished)
    const account = store.accounts[0]
    expect(account).toBeDefined()
    expect(account.label).toBe('Work')
    expect(vault.load(account.id)).toEqual(AccountCredential.apiKey('sk-or-key'))
    expect(http.requests.map((request) => request.headers?.Authorization)).toEqual(['Bearer sk-or-key'])
  })

  it('testARejectedAPIKeyIsNotAdded', async () => {
    const store = makeStore()
    const http = new RoutingHTTPClient(() => new HTTPResponse(401))
    const flow = new AddAccountFlow({ store, openURL: () => {}, login: (kind) => new APIKeyLogin(kind, http) })
    flow.choose('openrouter')

    flow.addKey('sk-or-typo', '', '')
    await waitUntil(() => flow.state.errorMessage !== undefined)

    expect(flow.state.errorMessage).toBe('OpenRouter rejected the API key.')
    expect(store.accounts.length).toBe(0)
  })

  it('testCopilotAsksForAMethodAndOrganizationBillingAddsTheOrganization', async () => {
    const vault = new InMemoryCredentialVault()
    const store = makeStore(vault)
    const started: [ProviderAuthMethod, string][] = []
    const flow = new AddAccountFlow({
      store,
      openURL: () => {},
      login: (_kind, method, organization) => {
        started.push([method, organization])
        return new StubLogin(async (input) => {
          const token = (await nextPastedCode(input)) ?? ''
          return { label: organization, credential: AccountCredential.apiKey(token) }
        })
      }
    })
    flow.choose('copilot')
    expect(flow.state.method, 'Copilot asks how to add it').toBeUndefined()
    expect(flow.state.isWorking).toBe(false)

    flow.chooseMethod({ type: 'organizationToken' })
    const apiKey = 'github_pat_1'
    expect(canAddKey(flow, apiKey, ''), 'an organization is required').toBe(false)
    const organization = ' Acme '
    flow.addKey(apiKey, '', organization)
    await waitUntil(() => flow.finished)

    expect(started.map((entry) => entry[0])).toEqual([{ type: 'organizationToken' }])
    expect(started.map((entry) => entry[1])).toEqual(['Acme'])
    const account = store.accounts[0]
    expect(account).toBeDefined()
    expect(account.kind).toBe('copilot')
    expect(account.label).toBe('Acme')
    expect(account.organization).toBe('Acme')
    expect(vault.load(account.id)).toEqual(AccountCredential.apiKey('github_pat_1'))
  })

  it('testBackStopsTheSignInAndReturnsToTheListWithTheProviderSelected', async () => {
    const store = makeStore()
    const url = 'https://example.com/authorize'
    const cancelled = new TestSwitch(false)
    const flow = new AddAccountFlow({
      store,
      openURL: () => {},
      login: () =>
        new StubLogin(async (_input, signal) => {
          try {
            await untilCancelled(signal)
          } catch (error) {
            cancelled.value = true
            throw error
          }
          return { label: 'late', credential: access('access') }
        }, LoginPrompt.browser(url, true))
    })
    flow.choose('codex')
    await waitUntil(() => flow.state.prompt !== undefined)
    // The pasted code lives in the sheet here; `back()` leaves the sheet to clear it.

    flow.back()

    const state = flow.state
    expect(state.provider).toBeUndefined()
    expect(state.selection).toEqual({ type: 'provider', kind: 'codex' })
    expect(state.prompt).toBeUndefined()
    expect(state.errorMessage).toBeUndefined()
    expect(state.isWorking).toBe(false)
    expect(flow.finished).toBe(false)
    for (let index = 0; index < 200 && !cancelled.value; index++) await tick()
    expect(cancelled.value, 'back() left the sign-in running').toBe(true)
    expect(flow.state.errorMessage).toBeUndefined()
    expect(flow.finished).toBe(false)
    expect(store.accounts.length).toBe(0)
  })

  it('testTheBrowserOpensOnceEachTimeASignInAttemptAsksForIt', async () => {
    const store = makeStore()
    const url = 'https://example.com/authorize'
    const opened: string[] = []
    let attempts = 0
    const flow = new AddAccountFlow({
      store,
      openURL: (target) => opened.push(target),
      login: () => {
        attempts += 1
        switch (attempts) {
          case 1:
            return new StubLogin(async () => {
              throw LoginError.invalidCode
            }, LoginPrompt.browser(url, false))
          case 2:
            return new StubLogin(async () => {
              throw LoginError.invalidCode
            })
          default:
            return new StubLogin(async () => ({ label: 'rob', credential: access('access') }), LoginPrompt.browser(url, false))
        }
      }
    })
    flow.choose('claude')
    await waitUntil(() => flow.state.errorMessage !== undefined)
    expect(opened, 'the browser opens when the sign-in asks for it').toEqual([url])

    flow.signIn()
    await waitUntil(() => attempts === 2 && flow.state.errorMessage !== undefined)
    expect(opened, 'Try Again opened the browser before the new attempt asked for it').toEqual([url])

    flow.signIn()
    await waitUntil(() => flow.finished)
    expect(opened, "the new attempt's prompt opens the browser again").toEqual([url, url])
  })

  it('testATokenPageOpensOnItsOwnAndThePastedTokenFinishesTheSignIn', async () => {
    const store = makeStore()
    const url = 'https://example.com/show-auth-token'
    const opened: string[] = []
    const flow = new AddAccountFlow({
      store,
      openURL: (target) => opened.push(target),
      login: () =>
        new StubLogin(async (input) => {
          return { label: `token:${(await nextPastedCode(input)) ?? ''}`, credential: access('key') }
        }, LoginPrompt.browserToken(url))
    })
    flow.choose('claude')
    await waitUntil(() => flow.state.prompt !== undefined)
    expect(opened).toEqual([url])
    expect(canSubmitCode(flow, '')).toBe(false)

    flow.submitCode('abc123')
    await waitUntil(() => flow.finished)
    expect(store.accounts.map((account) => account.label)).toEqual(['token:abc123'])
  })

  it('testTheDeviceCodePageOpensOnlyOnRequest', async () => {
    const store = makeStore()
    const url = 'https://example.com/device'
    const opened: string[] = []
    const flow = new AddAccountFlow({
      store,
      openURL: (target) => opened.push(target),
      login: () =>
        new StubLogin(async (_input, signal) => {
          await untilCancelled(signal)
          return { label: 'late', credential: access('access') }
        }, LoginPrompt.deviceCode('ABCD-EFGH', url))
    })
    flow.choose('grok')
    await waitUntil(() => flow.state.prompt !== undefined)
    expect(opened.length, 'a device code has to be read before its page opens').toBe(0)

    flow.openBrowser()
    expect(opened).toEqual([url])
    flow.cancel()
  })

  it('testAHubErrorShowsOnlyAfterConnectAndClearsOnceTheUserTypes', async () => {
    const flow = new AddAccountFlow({
      store: makeStore(),
      openURL: () => {},
      connectHub: async () => {
        throw ProviderError.unavailable('Use https for hub.example.com.')
      }
    })
    flow.chooseHub()
    // The address and key live in the sheet, which clears the error as the user edits either one.
    let hubURL = 'http://hub.example.com'
    let apiKey = 'mgmt-key'
    expect(flow.state.errorMessage, 'typing shows no error').toBeUndefined()

    flow.connect(hubURL, apiKey)
    await waitUntil(() => flow.state.errorMessage !== undefined)
    hubURL = 'https://hub.example.com'
    flow.clearError()
    expect(flow.state.errorMessage, 'editing the address hides the error until Connect').toBeUndefined()

    flow.connect(hubURL, apiKey)
    await waitUntil(() => flow.state.errorMessage !== undefined)
    apiKey = 'other-key'
    flow.clearError()
    expect(flow.state.errorMessage, 'editing the key hides the error until Connect').toBeUndefined()
  })

  it('testAddKeyWhileSavingStartsNoSecondSave', async () => {
    const store = makeStore()
    let started = 0
    let finishSave: (() => void) | undefined
    const flow = new AddAccountFlow({
      store,
      openURL: () => {},
      login: () => {
        started += 1
        return new StubLogin(async () => {
          await new Promise<void>((resolve) => (finishSave = resolve))
          return { label: 'key', credential: AccountCredential.apiKey('sk-or-key') }
        })
      }
    })
    flow.choose('openrouter')
    const apiKey = 'sk-or-key'
    for (let index = 0; index < 3; index++) flow.addKey(apiKey, '', '')
    expect(canAddKey(flow, apiKey), 'a save in flight keeps Return from starting another').toBe(false)
    await waitUntil(() => finishSave !== undefined)
    finishSave?.()
    await waitUntil(() => flow.finished)
    expect(started).toBe(1)
    expect(store.accounts.map((account) => account.label)).toEqual(['key'])
  })
})
