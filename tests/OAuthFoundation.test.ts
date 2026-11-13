import { connect, type Socket } from 'node:net'
import { describe, it, expect } from 'vitest'
import { NetworkError } from '@core/models/ProviderSnapshot'
import { DeviceCodePoller, DeviceCodePollResult } from '@core/services/DeviceCodePoller'
import { LoopbackCallbackServer } from '@core/services/LoopbackCallbackServer'
import { LoginError } from '@core/services/OAuthLoginSupport'
import { PKCE } from '@core/services/PKCE'
import { TestClock, TestSwitch } from './TestSupport'

/** One browser-side TCP connection to the callback server, sending the request in whatever pieces a test wants. */
class CallbackClient {
  private received = ''
  private readonly closed: Promise<void>

  private constructor(private readonly connection: Socket) {
    connection.setEncoding('utf8')
    connection.on('data', (chunk: string) => (this.received += chunk))
    this.closed = new Promise((resolve) => {
      connection.once('end', () => resolve())
      connection.once('close', () => resolve())
      connection.once('error', () => resolve())
    })
  }

  static async open(server: LoopbackCallbackServer): Promise<CallbackClient> {
    const port = Number(new URL(server.redirectURI).port)
    const connection = connect({ host: '127.0.0.1', port, allowHalfOpen: true })
    await new Promise<void>((resolve, reject) => {
      connection.once('connect', () => resolve())
      connection.once('error', reject)
    })
    return new CallbackClient(connection)
  }

  /** Sends one piece; `closing` half-closes the connection after it, the way a client that gives up mid-header does. */
  send(piece: string, closing = false): Promise<void> {
    return new Promise((resolve) => {
      if (closing) this.connection.end(piece, () => resolve())
      else this.connection.write(piece, () => resolve())
    })
  }

  /** Everything the server sent before it closed the connection. */
  async reply(): Promise<string> {
    await this.closed
    this.connection.destroy()
    return this.received
  }
}

const sleepMs = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

describe('OAuthFoundationTests', () => {
  it('testPKCEAppendixBChallenge', () => {
    expect(PKCE.challenge('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk')).toBe('E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM')
  })

  it('testDeviceCodePollerHandlesPendingSlowDownAndSuccess', async () => {
    const results: DeviceCodePollResult<string>[] = [DeviceCodePollResult.pending, DeviceCodePollResult.slowDown, DeviceCodePollResult.complete('token')]
    const index = new TestSwitch(0)
    const sleeps = new TestSwitch<number[]>([])
    const token = await DeviceCodePoller.poll(
      1,
      100,
      () => results[index.value++],
      undefined,
      (seconds) => {
        sleeps.value.push(seconds)
      }
    )

    expect(token).toBe('token')
    expect(sleeps.value).toEqual([1, 6])
  })

  it('testDeviceCodePollerKeepsPollingThroughANetworkError', async () => {
    const calls = new TestSwitch(0)
    const token = await DeviceCodePoller.poll<string>(
      1,
      100,
      () => {
        calls.value += 1
        if (calls.value === 1) throw new NetworkError('The request timed out.')
        return DeviceCodePollResult.complete('token')
      },
      undefined,
      () => {}
    )

    expect(token, 'one timed-out poll must not end the sign-in').toBe('token')
  })

  it('testDeviceCodePollerReportsTheNetworkErrorOnceTheCodeExpires', async () => {
    const clock = new TestClock(0)
    const offline = new NetworkError('The Internet connection appears to be offline.')
    await expect(
      DeviceCodePoller.poll<string>(
        1,
        10,
        () => {
          throw offline
        },
        clock.now,
        (seconds) => clock.advance(seconds)
      )
    ).rejects.toBe(offline)
  })

  it('testDeviceCodeExpiredTokenFails', async () => {
    await expect(
      DeviceCodePoller.poll<string>(1, 100, () => DeviceCodePollResult.failed('The device code expired.'), undefined, () => {})
    ).rejects.toThrow('The device code expired.')
  })

  // Port only: cancelling the login's task is an aborted signal here.
  it('deviceCodePollerStopsWithCancelledWhenTheCallerCancels', async () => {
    const abort = new AbortController()
    const polling = DeviceCodePoller.poll<string>(1, 100, () => DeviceCodePollResult.pending, undefined, undefined, abort.signal)
    await sleepMs(20)
    abort.abort()
    await expect(polling).rejects.toThrow(LoginError.cancelled.message)
  })

  it('testLoopbackCallbackAnswersStrayRequestsAndKeepsListeningForTheCode', async () => {
    const server = await LoopbackCallbackServer.start('expected')
    expect(new URL(server.redirectURI).hostname).toBe('localhost')
    const callback = server.waitForCode()
    const callbackURL = server.redirectURI.replace('localhost', '127.0.0.1')
    const strays: [string, RequestInit, number][] = [
      [callbackURL.replace('/callback', '/cancel'), {}, 404],
      [callbackURL + '?code=ignored&state=wrong', {}, 400],
      [callbackURL + '?code=ignored&state=expected', { method: 'POST' }, 405]
    ]
    for (const [url, init, status] of strays) {
      const response = await fetch(url, init)
      expect(response.status, url).toBe(status)
    }
    const valid = await fetch(callbackURL + '?code=accepted&state=expected')
    expect(valid.status).toBe(200)
    expect(await valid.text()).toContain('Sign-in complete. You may close this page.')
    expect(await callback).toBe('accepted')
    server.cancel()
  })

  it('testLoopbackCallbackWaitsForTheWholeHeaderBeforeItAnswers', async () => {
    const request = 'GET /callback?code=demo&state=expected HTTP/1.1\r\nHost: localhost\r\n\r\n'
    const cuts = [request.indexOf('&state'), request.indexOf('ected HTTP'), request.length - 1]
    for (const cut of cuts) {
      const server = await LoopbackCallbackServer.start('expected')
      const settled = new TestSwitch(false)
      const callback = server.waitForCode().finally(() => (settled.value = true))
      const client = await CallbackClient.open(server)
      await client.send(request.slice(0, cut))
      await sleepMs(100)
      expect(settled.value, `answered the partial header ${JSON.stringify(request.slice(0, cut))}`).toBe(false)
      await client.send(request.slice(cut))
      expect(await callback).toBe('demo')
      const reply = await client.reply()
      expect(reply.startsWith('HTTP/1.1 200 '), reply).toBe(true)
      expect(reply.split('HTTP/1.1 ').length, 'one reply per connection').toBe(2)
      server.cancel()
    }
  })

  it('testLoopbackCallbackRefusesAHeaderCutOffOrPast16KiB', async () => {
    const cutOff = 'GET /callback?code=demo&state=expected HTTP/1.1\r\nHost: localhost\r\n'
    const oversized = `GET /callback?code=demo&state=expected&pad=${'a'.repeat(20_000)} HTTP/1.1\r\n\r\n`
    const cases: [string, boolean][] = [
      [cutOff, true],
      [oversized, false]
    ]
    for (const [request, closing] of cases) {
      const server = await LoopbackCallbackServer.start('expected')
      const callback = server.waitForCode()
      callback.catch(() => undefined)
      const client = await CallbackClient.open(server)
      await client.send(request, closing)
      await expect(callback).rejects.toThrow(LoginError.invalidCallback.message)
      const reply = await client.reply()
      if (closing) expect(reply.startsWith('HTTP/1.1 400 '), reply).toBe(true)
      server.cancel()
    }
  })

  // Port only: a cancelled sign-in stops the server and whoever waits on it.
  it('loopbackCallbackCancelEndsTheWaitAndStopsListening', async () => {
    const server = await LoopbackCallbackServer.start('expected')
    const callback = server.waitForCode()
    server.cancel()
    await expect(callback).rejects.toThrow(LoginError.cancelled.message)
    await expect(fetch(server.redirectURI.replace('localhost', '127.0.0.1'))).rejects.toThrow()
  })
})
