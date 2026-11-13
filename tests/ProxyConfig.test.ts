import { describe, it, expect } from 'vitest'
import { ProxyConfig, ProxyConfigParseError } from '@core/services/ProxyConfig'

function file(url: string | undefined): string {
  const proxy: Record<string, unknown> = { enabled: true }
  if (url !== undefined) proxy.url = url
  return JSON.stringify({ proxy })
}

function parseError(text: string): ProxyConfigParseError | undefined {
  try {
    ProxyConfig.parse(text)
    return undefined
  } catch (error) {
    return error instanceof ProxyConfigParseError ? error : undefined
  }
}

describe('ProxyConfigTests', () => {
  it('testEachSchemeParsesWithItsDefaultPortAndAnyCredential', () => {
    const cases: [string, ProxyConfig][] = [
      ['socks5://127.0.0.1:10808', { scheme: 'socks5', host: '127.0.0.1', port: 10808 }],
      ['socks5://proxy.example.com', { scheme: 'socks5', host: 'proxy.example.com', port: 1080 }],
      ['http://proxy.example.com', { scheme: 'http', host: 'proxy.example.com', port: 80 }],
      ['HTTPS://proxy.example.com', { scheme: 'https', host: 'proxy.example.com', port: 443 }],
      ['http://us%40er:p%3Ass@[::1]:8080', { scheme: 'http', host: '::1', port: 8080, username: 'us@er', password: 'p:ss' }],
      ['socks5://user@proxy.example.com:1081', { scheme: 'socks5', host: 'proxy.example.com', port: 1081, username: 'user', password: '' }]
    ]
    for (const [url, expected] of cases) {
      expect(ProxyConfig.parse(file(url)), url).toEqual(expected)
    }
  })

  it('testAnAbsentOrDisabledProxyIsOffWithoutAnError', () => {
    const files = [
      '{}',
      '{"proxy": null}',
      '{"theme": "dark"}',
      '{"proxy": {"enabled": false}}',
      '{"proxy": {"enabled": false, "url": "ftp://nowhere"}}'
    ]
    for (const text of files) {
      expect(ProxyConfig.parse(text), text).toBeUndefined()
    }
  })

  it('testInvalidConfigThrowsAndItsMessageLeavesOutTheURL', () => {
    const malformed = [
      '',
      'not json',
      '[]',
      '{"proxy": "socks5://127.0.0.1:1080"}',
      '{"proxy": {"url": "socks5://127.0.0.1:1080"}}',
      '{"proxy": {"enabled": "true", "url": "socks5://127.0.0.1:1080"}}'
    ]
    for (const text of malformed) {
      expect(parseError(text)?.case, text).toBe('invalidJSON')
    }
    const badURLs: (string | undefined)[] = [
      undefined,
      'not a url',
      'ftp://alice:s3cret@proxy.example.com',
      'alice:s3cret@proxy.example.com:8080',
      'socks5://alice:s3cret@:1080',
      'http://alice:s3cret@proxy.example.com:70000',
      'http://alice:s3cret@proxy.example.com:0'
    ]
    for (const url of badURLs) {
      const error = parseError(file(url))
      expect(error?.case, url ?? 'no url').toBe('invalidURL')
      const message = error?.message ?? ''
      expect(message.includes('alice') || message.includes('s3cret'), message).toBe(false)
    }
  })

  // testAnHTTPProxyGetsACONNECTForTheProviderHost, testAnHTTPSProxyGetsATLSHandshake, and
  // testASOCKS5ProxyGetsAGreetingThatOffersPasswordAuthOnlyWithACredential drive a URLSession through the
  // proxy. The port hands the proxy to Chromium as proxy rules instead, so those have no port.
  it.skip('testAnHTTPProxyGetsACONNECTForTheProviderHost', () => {})
  it.skip('testAnHTTPSProxyGetsATLSHandshake', () => {})
  it.skip('testASOCKS5ProxyGetsAGreetingThatOffersPasswordAuthOnlyWithACredential', () => {})

  // Port only: what the desktop app passes to `session.setProxy`.
  it('proxyRulesNameTheSchemeHostAndPortAndNeverTheCredential', () => {
    expect(ProxyConfig.proxyRules({ scheme: 'socks5', host: '127.0.0.1', port: 10808 })).toBe('socks5://127.0.0.1:10808')
    expect(ProxyConfig.proxyRules({ scheme: 'https', host: 'proxy.example.com', port: 443 })).toBe('https://proxy.example.com:443')
    expect(ProxyConfig.proxyRules({ scheme: 'http', host: '::1', port: 8080, username: 'alice', password: 's3cret' })).toBe('http://[::1]:8080')
  })
})
