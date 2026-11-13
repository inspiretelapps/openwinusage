import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { HTTPRequest } from '@core/services/HTTPClient'
import { ProxyConfig } from '@core/services/ProxyConfig'

/**
 * Provider responses carry emails, org ids, and usage, and every read must reach the provider, so the
 * client's session keeps no cache, on disk or in memory, with or without a proxy. Upstream reads the
 * `URLSessionConfiguration`; this port's client is Electron's `net` in its own session, so the test
 * records what the client asks Electron for.
 */
const electron = vi.hoisted(() => ({
  partitions: [] as { partition: string; options: unknown }[],
  proxies: [] as unknown[],
  requests: [] as Record<string, unknown>[]
}))

vi.mock('electron', async () => {
  const { EventEmitter: Emitter } = await import('node:events')
  const session = {
    fromPartition(partition: string, options: unknown) {
      electron.partitions.push({ partition, options })
      return {
        setProxy: async (config: unknown) => {
          electron.proxies.push(config)
        }
      }
    }
  }
  const net = {
    request(options: Record<string, unknown>) {
      electron.requests.push(options)
      const outgoing = new Emitter() as EventEmitter & Record<string, unknown>
      outgoing.setHeader = () => {}
      outgoing.write = () => {}
      outgoing.abort = () => {}
      outgoing.end = () => {
        const incoming = new Emitter() as EventEmitter & { statusCode: number; headers: Record<string, string> }
        incoming.statusCode = 200
        incoming.headers = {}
        outgoing.emit('response', incoming)
        incoming.emit('end')
      }
      return outgoing
    }
  }
  return { session, net, default: { session, net } }
})

afterEach(() => {
  vi.restoreAllMocks()
  electron.partitions.length = 0
  electron.proxies.length = 0
  electron.requests.length = 0
})

describe('HTTPClientCacheTests', () => {
  it('testTheSessionCachesNoResponseWithOrWithoutAProxy', async () => {
    const { ElectronHTTPClient } = await import('../src/main/ElectronHTTPClient')
    const proxy: ProxyConfig = { scheme: 'socks5', host: '127.0.0.1', port: 1080 }
    const cases: [string, ProxyConfig | undefined][] = [
      ['no proxy', undefined],
      ['proxy', proxy]
    ]
    for (const [name, config] of cases) {
      electron.partitions.length = 0
      electron.proxies.length = 0
      electron.requests.length = 0
      vi.spyOn(ProxyConfig, 'load').mockReturnValue(config)

      const client = new ElectronHTTPClient()
      await client.send(HTTPRequest.make('GET', 'https://example.com/usage'))

      expect(electron.partitions.map((entry) => entry.options), name).toEqual([{ cache: false }])
      expect(electron.requests.map((request) => request.cache), name).toEqual(['no-store'])
      expect(electron.proxies.length, name).toBe(config === undefined ? 0 : 1)
    }
  })
})
