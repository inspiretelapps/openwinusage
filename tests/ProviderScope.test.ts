import { describe, it, expect } from 'vitest'
import { ClaudeLogin } from '@core/services/BrowserProviderLogins'
import { GrokLogin } from '@core/services/DeviceProviderLogins'
import type { HTTPRequest } from '@core/services/HTTPClient'
import { bodyText } from '@core/support/ProviderParse'
import { RoutingHTTPClient, jsonResponse } from './TestSupport'

/**
 * A refresh never asks for more than the sign-in did: Claude's refresh sends the sign-in's own scope
 * string, and the others send no `scope`, which OAuth reads as the granted set. `ProviderLoginTests`
 * pins the scope string each sign-in sends.
 */
const tokenEndpoint = (): RoutingHTTPClient => new RoutingHTTPClient(() => jsonResponse('{"access_token":"new","expires_in":3600}'))

function formFields(request: HTTPRequest): Record<string, string> {
  if (request.body === undefined) return {}
  const fields: Record<string, string> = {}
  for (const part of bodyText(request.body).split('&')) {
    const equals = part.indexOf('=')
    if (equals >= 0) fields[decodeURIComponent(part.slice(0, equals))] = decodeURIComponent(part.slice(equals + 1))
  }
  return fields
}

describe('ProviderScopeTests', () => {
  it('testClaudeRefreshAsksForTheSignInScopes', async () => {
    const http = tokenEndpoint()

    await ClaudeLogin.refresh('refresh', http, Date.now())

    const request = http.requests[0]
    expect(request).toBeDefined()
    const body = JSON.parse(bodyText(request.body!)) as Record<string, unknown>
    expect(body.scope).toBe('user:profile')
    expect(body.client_id).toBe(ClaudeLogin.clientID)
  })

  it('testGrokRefreshSendsNoScope', async () => {
    const http = tokenEndpoint()

    await GrokLogin.refresh('refresh', http, Date.now())

    expect(http.requests[0]).toBeDefined()
    expect(formFields(http.requests[0]).scope).toBeUndefined()
  })
})
