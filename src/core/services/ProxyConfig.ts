import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { AppInfo } from '../support/AppInfo'
import { AppLog, describeError } from '../support/AppLog'
import { bodyText, isJSONObject } from '../support/ProviderParse'

export type ProxyConfigScheme = 'socks5' | 'http' | 'https'

export const ProxyConfigScheme = {
  /** `Scheme(rawValue:)` */
  from(rawValue: string): ProxyConfigScheme | undefined {
    return rawValue === 'socks5' || rawValue === 'http' || rawValue === 'https' ? rawValue : undefined
  },

  defaultPort(scheme: ProxyConfigScheme): number {
    switch (scheme) {
      case 'socks5':
        return 1080
      case 'http':
        return 80
      case 'https':
        return 443
    }
  }
}

/** The config file as error text names it: `~/.winusage/config.json`. */
const fileName = `~/${AppInfo.configFolderName}/config.json`

/**
 * Error text never quotes the URL, not even its scheme. A password can sit anywhere in it, and
 * `user:pass@host` without a scheme parses its user name as the scheme.
 */
export class ProxyConfigParseError extends Error {
  readonly case: 'invalidJSON' | 'invalidURL'

  constructor(errorCase: 'invalidJSON' | 'invalidURL') {
    super(
      errorCase === 'invalidJSON'
        ? `${fileName} is not valid JSON in the form {"proxy": {"enabled": true, "url": "socks5://host:port"}}`
        : `proxy.url in ${fileName} must be socks5://, http://, or https://, then a host and an optional port`
    )
    this.name = 'ProxyConfigParseError'
    this.case = errorCase
  }

  static get invalidJSON(): ProxyConfigParseError {
    return new ProxyConfigParseError('invalidJSON')
  }

  static get invalidURL(): ProxyConfigParseError {
    return new ProxyConfigParseError('invalidURL')
  }
}

/** The proxy the user set in the config file. A proxy that needs no sign-in has no `username` or `password`. */
export interface ProxyConfig {
  scheme: ProxyConfigScheme
  host: string
  port: number
  username?: string
  password?: string
}

interface ProxyFile {
  proxy?: { enabled: boolean; url?: string }
}

/** `JSONDecoder().decode(File.self, from:)`; undefined for anything that isn't the file's shape. */
function decodeFile(data: Uint8Array | string): ProxyFile | undefined {
  let json: unknown
  try {
    json = JSON.parse(bodyText(data))
  } catch {
    return undefined
  }
  if (!isJSONObject(json)) return undefined
  const proxy = json.proxy
  if (proxy === undefined || proxy === null) return {}
  if (!isJSONObject(proxy) || typeof proxy.enabled !== 'boolean') return undefined
  const url = proxy.url
  if (url === undefined || url === null) return { proxy: { enabled: proxy.enabled } }
  if (typeof url !== 'string') return undefined
  return { proxy: { enabled: proxy.enabled, url } }
}

function percentDecoded(text: string): string {
  try {
    return decodeURIComponent(text)
  } catch {
    return text
  }
}

export const ProxyConfig = {
  /** Where the config file lives: `config.json` in the app's folder under the user's home directory. */
  filePath(): string {
    return join(homedir(), AppInfo.configFolderName, 'config.json')
  },

  load(): ProxyConfig | undefined {
    try {
      const proxy = ProxyConfig.parse(readFileSync(ProxyConfig.filePath()))
      if (proxy) AppLog.notice('config', `proxy on: ${proxy.scheme}://${proxy.host}:${proxy.port}`)
      return proxy
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      AppLog.error('config', `proxy off: ${describeError(error)}`)
      return undefined
    }
  },

  parse(data: Uint8Array | string): ProxyConfig | undefined {
    const file = decodeFile(data)
    if (!file) throw ProxyConfigParseError.invalidJSON
    const proxy = file.proxy
    if (!proxy || !proxy.enabled) return undefined
    // A scheme, then `//` and a host: `host:port` and `user:pass@host` alone name no proxy.
    if (proxy.url === undefined || !/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(proxy.url)) throw ProxyConfigParseError.invalidURL
    let url: URL
    try {
      url = new URL(proxy.url)
    } catch {
      throw ProxyConfigParseError.invalidURL
    }
    const scheme = ProxyConfigScheme.from(url.protocol.replace(/:$/, '').toLowerCase())
    if (scheme === undefined) throw ProxyConfigParseError.invalidURL
    const host = url.hostname.replace(/^\[|\]$/g, '')
    if (host.length === 0) throw ProxyConfigParseError.invalidURL
    const port = url.port.length > 0 ? Number(url.port) : ProxyConfigScheme.defaultPort(scheme)
    if (!Number.isInteger(port) || port <= 0 || port > 65_535) throw ProxyConfigParseError.invalidURL
    const config: ProxyConfig = { scheme, host, port }
    if (url.username.length > 0 || url.password.length > 0) {
      config.username = percentDecoded(url.username)
      config.password = percentDecoded(url.password)
    }
    return config
  },

  /**
   * The proxy as Chromium's proxy rules, which the desktop app hands to `session.setProxy`:
   * `socks5://host:port`, `http://host:port`, or `https://host:port`. It carries no user name or
   * password; the app answers the proxy's sign-in request with those.
   */
  proxyRules(config: ProxyConfig): string {
    const host = config.host.includes(':') ? `[${config.host}]` : config.host
    return `${config.scheme}://${host}:${config.port}`
  }
}
