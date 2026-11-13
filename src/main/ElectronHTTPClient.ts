import { net, session, type Session } from 'electron'
import { NetworkError } from '@core/models/ProviderSnapshot'
import { HTTPRequest, HTTPResponse, httpDiagnostic, type HTTPClient } from '@core/services/HTTPClient'
import { ProxyConfig } from '@core/services/ProxyConfig'
import { AppLog } from '@core/support/AppLog'

/**
 * Sends provider requests through Chromium's network stack in a session of its own: no cookies, no
 * cache, and the Windows system proxy unless `~/.winusage/config.json` names one. The port of
 * `URLSessionHTTPClient`.
 */
export class ElectronHTTPClient implements HTTPClient {
  private readonly session: Session
  private readonly ready: Promise<void>
  private readonly proxy: ProxyConfig | undefined

  constructor() {
    this.session = session.fromPartition('providers', { cache: false })
    this.proxy = ProxyConfig.load()
    this.ready = this.proxy ? this.session.setProxy({ proxyRules: ProxyConfig.proxyRules(this.proxy) }) : Promise.resolve()
  }

  async send(request: HTTPRequest): Promise<HTTPResponse> {
    await this.ready
    const started = performance.now()
    const response = await new Promise<HTTPResponse>((resolve, reject) => {
      const timeoutSeconds = request.timeout ?? HTTPRequest.defaultTimeout
      let settled = false
      const fail = (message: string, cause?: unknown): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        reject(new NetworkError(message, { cause }))
      }
      let outgoing: Electron.ClientRequest
      try {
        outgoing = net.request({
          method: request.method,
          url: request.url,
          session: this.session,
          useSessionCookies: false,
          credentials: 'omit',
          redirect: 'follow',
          cache: 'no-store'
        })
      } catch (error) {
        reject(new NetworkError('The request could not be sent.', { cause: error }))
        return
      }
      const timer = setTimeout(() => {
        fail('The request timed out.')
        outgoing.abort()
      }, timeoutSeconds * 1000)
      for (const [name, value] of Object.entries(request.headers ?? {})) {
        try {
          outgoing.setHeader(name, value)
        } catch {
          // Chromium sets a few headers itself (Content-Length, Host) and refuses them here.
        }
      }
      outgoing.on('login', (authInfo, callback) => {
        if (authInfo.isProxy && this.proxy?.username !== undefined) callback(this.proxy.username, this.proxy.password ?? '')
        else callback()
      })
      outgoing.on('error', (error) => fail('Connection failed. Check your internet connection and try again.', error))
      outgoing.on('abort', () => fail('The request was cancelled.'))
      outgoing.on('response', (incoming) => {
        const chunks: Buffer[] = []
        incoming.on('data', (chunk: Buffer) => chunks.push(chunk))
        incoming.on('error', (error: unknown) => fail('Connection failed. Check your internet connection and try again.', error))
        incoming.on('end', () => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          const headers: Record<string, string> = {}
          for (const [name, value] of Object.entries(incoming.headers)) headers[name.toLowerCase()] = Array.isArray(value) ? value.join(', ') : String(value)
          resolve(new HTTPResponse(incoming.statusCode, headers, new Uint8Array(Buffer.concat(chunks))))
        })
      })
      if (request.body !== undefined) outgoing.write(Buffer.from(request.body))
      outgoing.end()
    })
    AppLog.debug('http', () => httpDiagnostic(request, response, performance.now() - started))
    return response
  }
}
