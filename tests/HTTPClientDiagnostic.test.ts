import { describe, it, expect } from 'vitest'
import { HTTPRequest, HTTPResponse, httpDiagnostic } from '@core/services/HTTPClient'

/**
 * The transport's log line is built from the request method, the URL's host and path, the status,
 * and the duration. A Cursor poll carries the PKCE verifier in its query and a failed poll echoes it
 * in the error body; neither may appear, and neither may a header.
 */
describe('HTTPClientDiagnosticTests', () => {
  it('testDiagnosticCarriesOnlyMethodEndpointStatusAndDuration', () => {
    const verifier = 'SYNTHETIC-pkce-verifier-0123456789abcdefghijklmnopqrstuvwxyz'
    const poll = `https://api2.cursor.sh/auth/poll?uuid=7f3c2a90&verifier=${verifier}`
    const request = HTTPRequest.make('GET', poll, { Authorization: 'Bearer SYNTHETIC-bearer-token' })
    const response = new HTTPResponse(
      401,
      { 'set-cookie': 'SYNTHETIC-session-cookie' },
      `{"error":"invalid verifier ${verifier}","detail":"SYNTHETIC-ERROR-BODY"}`
    )

    const line = httpDiagnostic(request, response, 143)

    expect(line).toBe('GET api2.cursor.sh/auth/poll -> 401 (143 ms)')
  })
})
