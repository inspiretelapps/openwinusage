import { describe, it, expect } from 'vitest'
import { AccountCredential, OAuthTokens } from '@core/models/Account'
import { AntigravityLogin, ClaudeLogin, CodexLogin } from '@core/services/BrowserProviderLogins'
import { APIKeyLogin, CopilotLogin, CursorLogin, GrokLogin, MuseLogin } from '@core/services/DeviceProviderLogins'
import type { HTTPRequest, HTTPResponse } from '@core/services/HTTPClient'
import { LoginError } from '@core/services/OAuthLoginSupport'
import type { LoginPrompt } from '@core/services/ProviderLogin'
import { bodyText, type JSONObject } from '@core/support/ProviderParse'
import { RoutingHTTPClient, jsonResponse } from './TestSupport'

/** `request.url.path`, which leaves out a trailing slash. */
function path(request: HTTPRequest): string {
  const pathname = new URL(request.url).pathname
  return pathname.length > 1 && pathname.endsWith('/') ? pathname.slice(0, -1) : pathname
}

const response = (json: string, status = 200): HTTPResponse => jsonResponse(json, status)

function jsonBody(request: HTTPRequest): JSONObject | undefined {
  if (request.body === undefined) return undefined
  try {
    return JSON.parse(bodyText(request.body)) as JSONObject
  } catch {
    return undefined
  }
}

function formBody(request: HTTPRequest): Record<string, string> {
  if (request.body === undefined) return {}
  const fields: Record<string, string> = {}
  for (const part of bodyText(request.body).split('&')) {
    const equals = part.indexOf('=')
    if (equals >= 0) fields[decodeURIComponent(part.slice(0, equals))] = decodeURIComponent(part.slice(equals + 1))
  }
  return fields
}

function jwt(payload: string): string {
  return `eyJhbGciOiJub25lIn0.${Buffer.from(payload, 'utf8').toString('base64url')}.signature`
}

function query(url: string): URLSearchParams {
  return new URL(url).searchParams
}

async function* emptyInput(): AsyncGenerator<string> {}

async function* pastedInput(value: string): AsyncGenerator<string> {
  yield value
}

class PromptCapture {
  value: LoginPrompt | undefined

  store(value: LoginPrompt): void {
    this.value = value
  }

  get browserURL(): string | undefined {
    return this.value?.type === 'browser' ? this.value.url : undefined
  }

  get deviceCode(): { userCode: string; verificationURL: string } | undefined {
    return this.value?.type === 'deviceCode' ? { userCode: this.value.userCode, verificationURL: this.value.verificationURL } : undefined
  }
}

class CallbackStatus {
  value: number | undefined
}

async function completeLoopbackCallback(authorizeURL: string): Promise<number | undefined> {
  const items = query(authorizeURL)
  const redirect = items.get('redirect_uri')
  const state = items.get('state')
  if (redirect === null || state === null) return undefined
  const callback = new URL(redirect)
  callback.hostname = '127.0.0.1'
  callback.search = `?code=fake-authorization-code&state=${encodeURIComponent(state)}`
  try {
    return (await fetch(callback)).status
  } catch {
    return undefined
  }
}

function browserPrompt(prompt: PromptCapture, callback: CallbackStatus): (value: LoginPrompt) => Promise<void> {
  return async (value) => {
    prompt.store(value)
    if (value.type !== 'browser') return
    callback.value = await completeLoopbackCallback(value.url)
  }
}

function identity(credential: AccountCredential): string | undefined {
  return credential.type === 'oauth' ? credential.tokens.extras[OAuthTokens.identityKey] : undefined
}

function ollamaHTTP(account: string, status = 200): RoutingHTTPClient {
  return new RoutingHTTPClient((request) =>
    path(request) === '/api/me' ? response(account, status) : response('{"included":{"balance_usd":72.5,"allowance_usd":100}}')
  )
}

describe('ProviderLoginTests', () => {
  it('testClaudeLoginExchangesCodeAndMapsProfile', async () => {
    const http = new RoutingHTTPClient((request) => {
      switch (path(request)) {
        case '/v1/oauth/token':
          return response('{"access_token":"claude-access","refresh_token":"claude-refresh","expires_in":3600}')
        case '/api/oauth/profile':
          return response('{"account":{"email":"claude@example.com","uuid":"acct"}}')
        default:
          return response('{}', 404)
      }
    })
    const prompt = new PromptCapture()
    const callback = new CallbackStatus()

    const result = await new ClaudeLogin(http).login(browserPrompt(prompt, callback), emptyInput())

    expect(result.label).toBe('claude@example.com')
    expect(callback.value).toBe(200)
    const authorizeURL = prompt.browserURL!
    expect(authorizeURL).toBeDefined()
    const items = query(authorizeURL)
    expect(items.get('scope')).toBe('user:profile')
    const tokenRequest = http.requests.find((request) => path(request) === '/v1/oauth/token')!
    const body = jsonBody(tokenRequest)!
    expect(body.grant_type).toBe('authorization_code')
    expect(body.code).toBe('fake-authorization-code')
    expect(body.client_id).toBe(ClaudeLogin.clientID)
    expect(new URL(body.redirect_uri as string).hostname).toBe('localhost')
    const verifier = body.code_verifier as string
    expect(typeof verifier).toBe('string')
    expect(body.state).not.toBe(verifier)
    expect(body.state).toBe(items.get('state'))
    expect(authorizeURL.includes(verifier), 'the authorize URL carries the challenge, never the verifier').toBe(false)
  })

  it('testClaudeLoginFailsWhenItCannotReadTheProfile', async () => {
    const profiles = [
      response('{"type":"error","error":{"type":"rate_limit_error"}}', 429),
      response('{"account":{"email":"claude@example.com"}}')
    ]
    for (const profile of profiles) {
      const http = new RoutingHTTPClient((request) =>
        path(request) === '/v1/oauth/token'
          ? response('{"access_token":"claude-access","refresh_token":"claude-refresh","expires_in":3600}')
          : profile
      )
      await expect(
        new ClaudeLogin(http).login(browserPrompt(new PromptCapture(), new CallbackStatus()), emptyInput()),
        `signed in without the profile that identifies the account (HTTP ${profile.statusCode})`
      ).rejects.toThrow('Claude didn’t return your profile. Click Try Again to sign in again.')
    }
  })

  it('testCodexLoginUsesPiOriginatorAndMapsAccountClaims', async () => {
    const accessToken = jwt('{"https://api.openai.com/auth":{"chatgpt_account_id":"chatgpt-account"}}')
    const idToken = jwt('{"email":"codex@example.com"}')
    const http = new RoutingHTTPClient((request) => {
      if (path(request) !== '/oauth/token') return response('{}', 404)
      return response(`{"access_token":"${accessToken}","refresh_token":"codex-refresh","id_token":"${idToken}","expires_in":3600}`)
    })
    const prompt = new PromptCapture()
    const callback = new CallbackStatus()

    const result = await new CodexLogin(http).login(browserPrompt(prompt, callback), emptyInput())

    expect(result.label).toBe('codex@example.com')
    expect(callback.value).toBe(200)
    if (result.credential.type !== 'oauth') throw new Error('Expected OAuth credentials')
    expect(result.credential.tokens.extras.chatgpt_account_id).toBe('chatgpt-account')
    const items = query(prompt.browserURL!)
    expect(items.get('originator')).toBe('pi')
    expect(items.get('scope')).toBe('openid profile email offline_access')
    expect(items.get('redirect_uri')).toBe('http://localhost:1455/auth/callback')
    const body = formBody(http.requests.find((request) => path(request) === '/oauth/token')!)
    expect(body.grant_type).toBe('authorization_code')
    expect(body.client_id).toBe(CodexLogin.clientID)
    expect(body.code).toBe('fake-authorization-code')
    expect(body.redirect_uri).toBe('http://localhost:1455/auth/callback')
    expect((body.code_verifier ?? '').length).toBeGreaterThan(0)
  })

  it('testCopilotDeviceLoginMapsGitHubProfile', async () => {
    const http = new RoutingHTTPClient((request) => {
      switch (path(request)) {
        case '/login/device/code':
          return response('{"device_code":"device","user_code":"ABCD-EFGH","verification_uri":"https://github.com/login/device","expires_in":600,"interval":1}')
        case '/login/oauth/access_token':
          return response('{"access_token":"copilot-access"}')
        case '/user':
          return response('{"login":"copilot-user"}')
        default:
          return response('{}', 404)
      }
    })
    const prompt = new PromptCapture()

    const result = await new CopilotLogin(http).login((value) => prompt.store(value), emptyInput())

    expect(result.label).toBe('copilot-user')
    expect(prompt.deviceCode?.userCode).toBe('ABCD-EFGH')
    const start = http.requests.find((request) => path(request) === '/login/device/code')!
    expect(formBody(start).scope).toBe('read:user')
    const token = http.requests.find((request) => path(request) === '/login/oauth/access_token')!
    expect(formBody(token).grant_type).toBe('urn:ietf:params:oauth:grant-type:device_code')
    expect(formBody(token).device_code).toBe('device')
  })

  it('testGrokDeviceLoginMapsEmailFromToken', async () => {
    const accessToken = jwt('{"email":"grok@example.com"}')
    const http = new RoutingHTTPClient((request) => {
      switch (path(request)) {
        case '/oauth2/device/code':
          return response(
            '{"device_code":"device","user_code":"GROK-CODE","verification_uri":"https://auth.x.ai/activate","verification_uri_complete":"https:/activate","expires_in":600,"interval":1}'
          )
        case '/oauth2/token':
          return response(`{"access_token":"${accessToken}","refresh_token":"grok-refresh","expires_in":3600}`)
        default:
          return response('{}', 404)
      }
    })
    const prompt = new PromptCapture()

    const result = await new GrokLogin(http).login((value) => prompt.store(value), emptyInput())

    expect(result.label).toBe('grok@example.com')
    expect(prompt.deviceCode?.userCode).toBe('GROK-CODE')
    expect(prompt.deviceCode?.verificationURL, 'an unusable prefilled link falls back to the plain one').toBe('https://auth.x.ai/activate')
    const start = http.requests.find((request) => path(request) === '/oauth2/device/code')!
    expect(formBody(start).client_id).toBe(GrokLogin.clientID)
    expect(formBody(start).scope).toBe('openid email offline_access grok-cli:access')
    const token = http.requests.find((request) => path(request) === '/oauth2/token')!
    expect(formBody(token).grant_type).toBe('urn:ietf:params:oauth:grant-type:device_code')
    expect(formBody(token).device_code).toBe('device')
  })

  it('testMuseDeviceLoginSendsNoScopeAndNamesTheAccountByEmail', async () => {
    const http = new RoutingHTTPClient((request) => {
      switch (path(request)) {
        case '/oidc/device/authorization':
          return response(
            '{"device_code":"device","user_code":"MUSE-CODE","verification_uri":"https://auth.meta.com/oauth/device/","verification_uri_complete":"https://auth.meta.com/oauth/device/?code=MUSE-CODE","expires_in":600,"interval":1}'
          )
        case '/oidc/device/token':
          return response('{"access_token":"dca:muse-access","token_type":"Bearer"}')
        case '/muse-code/key':
          return response('{"api_key":"LLM|SYNTHETIC-inference-key","user_email":"muse@example.com","is_subs_active":true}')
        default:
          return response('{}', 404)
      }
    })
    const prompt = new PromptCapture()

    const result = await new MuseLogin(http).login((value) => prompt.store(value), emptyInput())

    expect(result.label).toBe('muse@example.com')
    expect(result.credential, 'only the dca: token is stored, never the inference key the key read returns').toEqual(
      AccountCredential.oauth(OAuthTokens.make('dca:muse-access', undefined, undefined, { [OAuthTokens.identityKey]: 'muse:muse@example.com' }))
    )
    expect(prompt.deviceCode?.userCode).toBe('MUSE-CODE')
    expect(prompt.deviceCode?.verificationURL, 'the browser opens with the code filled in').toBe(
      'https://auth.meta.com/oauth/device/?code=MUSE-CODE'
    )
    const start = http.requests.find((request) => path(request) === '/oidc/device/authorization')!
    expect(formBody(start), 'no scope field at all').toEqual({ client_id: MuseLogin.clientID })
    const token = http.requests.find((request) => path(request) === '/oidc/device/token')!
    expect(formBody(token).grant_type).toBe('urn:ietf:params:oauth:grant-type:device_code')
    expect(formBody(token).device_code).toBe('device')
    const key = http.requests.find((request) => path(request) === '/muse-code/key')!
    expect(key.headers?.Authorization).toBe('Bearer dca:muse-access')
    expect(jsonBody(key)?.onboard).toBe(false)
  })

  it('testCursorLoginPollsForTokens', async () => {
    const http = new RoutingHTTPClient(() =>
      response(`{"accessToken":"${jwt('{"sub":"auth0|user_abc"}')}","refreshToken":"cursor-refresh","authId":"auth0|user_abc"}`)
    )
    const prompt = new PromptCapture()

    const result = await new CursorLogin(http).login((value) => prompt.store(value), emptyInput())

    expect(result.label).toBe('Cursor Account')
    expect(identity(result.credential), 'the id comes from the token\'s subject; the poll carries no user id').toBe('cursor:user_abc')
    const authorizeURL = new URL(prompt.browserURL!)
    expect(authorizeURL.hostname).toBe('cursor.com')
    expect(authorizeURL.pathname).toBe('/loginDeepControl')
    expect(authorizeURL.searchParams.get('mode')).toBe('login')
    expect(authorizeURL.searchParams.get('redirectTarget')).toBe('cli')
    const poll = http.requests.find((request) => path(request) === '/auth/poll')!
    const pollQuery = query(poll.url)
    expect((pollQuery.get('uuid') ?? '').length).toBeGreaterThan(0)
    expect((pollQuery.get('verifier') ?? '').length).toBeGreaterThan(0)
  })

  it('testCursorLoginNamesTheAccountByTheProfileEmail', async () => {
    const accessToken = jwt('{"sub":"auth0|user_abc"}')
    const http = new RoutingHTTPClient((request) =>
      path(request) === '/api/auth/me'
        ? response('{"email":"dev@example.com","name":"Dev","sub":"auth0|user_abc"}')
        : response(`{"accessToken":"${accessToken}","refreshToken":"cursor-refresh"}`)
    )

    const result = await new CursorLogin(http).login(() => {}, emptyInput())

    expect(result.label).toBe('dev@example.com')
    const profile = http.requests.find((request) => path(request) === '/api/auth/me')!
    expect(new URL(profile.url).hostname).toBe('cursor.com')
    expect(profile.headers?.Cookie).toBe(`WorkosCursorSessionToken=user_abc%3A%3A${accessToken}`)
  })

  it('testCursorLoginKeepsTheDefaultNameWhenTheProfileReadFails', async () => {
    const http = new RoutingHTTPClient((request) =>
      path(request) === '/api/auth/me'
        ? response('{}', 500)
        : response(`{"accessToken":"${jwt('{"sub":"auth0|user_abc"}')}","refreshToken":"cursor-refresh"}`)
    )

    const result = await new CursorLogin(http).login(() => {}, emptyInput())

    expect(http.requests.find((request) => path(request) === '/api/auth/me')).toBeDefined()
    expect(result.label).toBe('Cursor Account')
    expect(identity(result.credential)).toBe('cursor:user_abc')
  })

  it('testOllamaKeyLoginNamesTheAccountByTheEmailOfItsPlanRead', async () => {
    for (const account of ['{"Email":"dev@example.com","Name":"dev","Plan":"pro"}', '{"email":"dev@example.com","name":"dev","plan":"pro"}']) {
      const http = ollamaHTTP(account)

      const result = await new APIKeyLogin('ollama', http).login(() => {}, pastedInput('ollama-key'))

      expect(result.label).toBe('dev@example.com')
      expect(http.requests.filter((request) => path(request) === '/api/me').length, 'the plan read names the account; no second request').toBe(1)
    }
  })

  it('testOllamaKeyLoginKeepsTheProviderNameWithoutAnEmail', async () => {
    const cases: [string, number][] = [
      ['{"Name":"dev","Plan":"free"}', 200],
      ['{"Email":""}', 200],
      ['{}', 401]
    ]
    for (const [account, status] of cases) {
      const http = ollamaHTTP(account, status)

      const result = await new APIKeyLogin('ollama', http).login(() => {}, pastedInput('ollama-key'))

      expect(result.label).toBe('Ollama')
    }
  })

  it('testAntigravityLoginExchangesCodeAndMapsGoogleProfile', async () => {
    const http = new RoutingHTTPClient((request) => {
      switch (path(request)) {
        case '/token':
          return response('{"access_token":"google-access","refresh_token":"google-refresh","expires_in":3600}')
        case '/oauth2/v1/userinfo':
          return response('{"email":"google@example.com"}')
        default:
          return response('{}', 404)
      }
    })
    const prompt = new PromptCapture()
    const callback = new CallbackStatus()

    const result = await new AntigravityLogin(http).login(browserPrompt(prompt, callback), emptyInput())

    expect(result.label).toBe('google@example.com')
    expect(callback.value).toBe(200)
    const authorizeURL = prompt.browserURL!
    const items = query(authorizeURL)
    expect(items.get('scope')).toBe('https://www.googleapis.com/auth/cloud-platform https://www.googleapis.com/auth/userinfo.email')
    const body = formBody(http.requests.find((request) => path(request) === '/token')!)
    expect(body.grant_type).toBe('authorization_code')
    expect(body.client_id).toBe(AntigravityLogin.clientID)
    expect(body.code).toBe('fake-authorization-code')
    expect(body.redirect_uri).toBe('http://localhost:51121/oauth-callback')
    expect((body.code_verifier ?? '').length).toBeGreaterThan(0)
    const verifier = body.code_verifier
    expect(items.get('state')).not.toBe(verifier)
    expect(authorizeURL.includes(verifier), 'the authorize URL carries the challenge, never the verifier').toBe(false)
  })

  // Port only: Swift cancels the login's task; here the caller aborts a signal.
  it('aCancelledSignInStopsWithCancelledAndFreesItsCallbackPort', async () => {
    const http = new RoutingHTTPClient(() => response('{}', 404))
    const never = { [Symbol.asyncIterator]: () => ({ next: () => new Promise<IteratorResult<string>>(() => {}) }) }
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const abort = new AbortController()
      const login = new CodexLogin(http).login(() => abort.abort(), never, abort.signal)
      await expect(login).rejects.toSatisfy((error) => LoginError.is(error, 'cancelled'))
    }
    expect(http.requests, 'the fixed port was free again, so no device sign-in started').toEqual([])

    const abort = new AbortController()
    const pasted = new APIKeyLogin('ollama', http).login(() => {}, never, abort.signal)
    abort.abort()
    await expect(pasted).rejects.toSatisfy((error) => LoginError.is(error, 'cancelled'))
  })
})
