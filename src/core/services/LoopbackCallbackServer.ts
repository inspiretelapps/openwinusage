import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { Duplex } from 'node:stream'
import { AppInfo } from '../support/AppInfo'
import { LoginError, URLQuery } from './OAuthLoginSupport'

type CallbackResult = { ok: true; code: string } | { ok: false; error: Error }

interface Waiter {
  resolve: (code: string) => void
  reject: (error: Error) => void
}

/**
 * The local HTTP server an OAuth sign-in redirects the browser to. It listens on 127.0.0.1 only, answers
 * stray requests without ending the sign-in, and delivers the first callback that carries this sign-in's
 * `state`.
 */
export class LoopbackCallbackServer {
  private readonly listener: Server
  private readonly state: string
  private readonly path: string
  private result: CallbackResult | undefined
  private waiters: Waiter[] = []
  /** Open connections, so `cancel` leaves none behind. */
  private readonly connections = new Set<Duplex>()
  /** Connections that already got their one reply; each closes itself once the reply is sent. */
  private readonly answered = new WeakSet<Duplex>()
  redirectURI = ''

  private constructor(listener: Server, state: string, path: string) {
    this.listener = listener
    this.state = state
    this.path = path
  }

  static async start(state: string, port?: number, path = '/callback'): Promise<LoopbackCallbackServer> {
    // The sign-in takes as long as the user does, so a connection the browser opened early is never
    // timed out. A header past 16 KiB is refused.
    const listener = createServer({ maxHeaderSize: LoopbackCallbackServer.headerLimit, requestTimeout: 0, headersTimeout: 0 })
    const server = new LoopbackCallbackServer(listener, state, path)
    listener.on('connection', (connection) => {
      server.connections.add(connection)
      connection.once('close', () => server.connections.delete(connection))
    })
    listener.on('request', (request, response) => server.handle(request, response))
    listener.on('clientError', (error, connection) => server.refuse(error, connection))
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error): void => {
        listener.off('listening', onListening)
        reject(LoginError.listenerFailed(error.message))
      }
      const onListening = (): void => {
        listener.off('error', onError)
        const address = listener.address()
        if (address === null || typeof address === 'string') {
          listener.close()
          reject(LoginError.listenerFailed('No local port was assigned.'))
          return
        }
        server.redirectURI = `http://localhost:${address.port}${path}`
        resolve()
      }
      listener.once('error', onError)
      listener.once('listening', onListening)
      listener.listen(port ?? 0, '127.0.0.1')
    })
    // A listener that fails after it started has no one to tell; the sign-in ends by callback, paste, or cancel.
    listener.on('error', () => undefined)
    return server
  }

  /** Whether the callback has answered, or the server was cancelled. */
  get isFinished(): boolean {
    return this.result !== undefined
  }

  waitForCode(): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      if (this.result) LoopbackCallbackServer.settle({ resolve, reject }, this.result)
      else this.waiters.push({ resolve, reject })
    })
  }

  cancel(): void {
    this.finish({ ok: false, error: LoginError.cancelled })
    this.stopListening()
    for (const connection of this.connections) {
      if (!this.answered.has(connection)) connection.destroy()
    }
  }

  private static readonly headerLimit = 16_384

  /**
   * The browser may deliver the request in pieces, so it is handled only once its whole header has
   * arrived; `refuse` gets a header cut off by the client or still unterminated at 16 KiB.
   */
  private handle(request: IncomingMessage, response: ServerResponse): void {
    if (request.method !== 'GET') {
      this.reply(response, 405, 'Only GET is supported.')
      return
    }
    let url: URL
    try {
      url = new URL(`http://localhost${request.url ?? ''}`)
    } catch {
      this.reply(response, 404, 'Sign-in callback not found.')
      return
    }
    if (url.pathname !== this.path) {
      this.reply(response, 404, 'Sign-in callback not found.')
      return
    }
    const query = URLQuery.items(url)
    if (URLQuery.value(query, 'state') !== this.state) {
      this.reply(response, 400, 'Sign-in state did not match.')
      return
    }
    const error = URLQuery.value(query, 'error')
    if (error !== undefined) {
      this.reply(response, 400, 'Sign-in failed.', { ok: false, error: LoginError.authorizationFailed(error) })
      return
    }
    const code = URLQuery.value(query, 'code')
    if (code === undefined || code.length === 0) {
      this.reply(response, 400, 'Authorization code was missing.', { ok: false, error: LoginError.invalidCallback })
      return
    }
    this.reply(response, 200, 'Sign-in complete. You may close this page.', { ok: true, code })
  }

  /** A request whose header never arrived whole, or that isn't HTTP at all. */
  private refuse(error: Error, connection: Duplex): void {
    if (this.answered.has(connection)) {
      connection.destroy()
      return
    }
    const code = (error as NodeJS.ErrnoException).code ?? ''
    const isCutOff = code === 'HPE_HEADER_OVERFLOW' || code === 'HPE_INVALID_EOF_STATE' || !code.startsWith('HPE_')
    if (!isCutOff) {
      // Not a request this server reads; like any request that isn't a GET, it ends nothing.
      this.send(connection, 405, 'Only GET is supported.')
      return
    }
    this.send(connection, 400, 'Sign-in failed.', { ok: false, error: LoginError.invalidCallback })
  }

  private reply(response: ServerResponse, status: number, body: string, result?: CallbackResult): void {
    if (result) this.finish(result)
    const connection = response.socket
    if (connection) this.answered.add(connection)
    const page = LoopbackCallbackServer.page(body)
    response.sendDate = false
    response.writeHead(status, status === 200 ? 'OK' : 'Error', {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Length': page.length,
      Connection: 'close'
    })
    response.end(page, () => {
      connection?.destroySoon()
      if (result) this.stopListening()
    })
  }

  /** The same reply for a connection whose request never became one. */
  private send(connection: Duplex, status: number, body: string, result?: CallbackResult): void {
    if (result) this.finish(result)
    this.answered.add(connection)
    const done = (): void => {
      connection.destroy()
      if (result) this.stopListening()
    }
    if (!connection.writable) {
      done()
      return
    }
    const page = LoopbackCallbackServer.page(body)
    const head = Buffer.from(
      `HTTP/1.1 ${status} ${status === 200 ? 'OK' : 'Error'}\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: ${page.length}\r\nConnection: close\r\n\r\n`,
      'utf8'
    )
    connection.once('error', done)
    connection.end(Buffer.concat([head, page]), done)
  }

  private static page(body: string): Buffer {
    return Buffer.from(`<!doctype html><title>${AppInfo.name}</title><p>${body}</p>`, 'utf8')
  }

  private stopListening(): void {
    if (this.listener.listening) this.listener.close()
  }

  private finish(result: CallbackResult): void {
    if (this.result) return
    this.result = result
    const pending = this.waiters
    this.waiters = []
    for (const waiter of pending) LoopbackCallbackServer.settle(waiter, result)
  }

  private static settle(waiter: Waiter, result: CallbackResult): void {
    if (result.ok) waiter.resolve(result.code)
    else waiter.reject(result.error)
  }
}
