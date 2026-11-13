import { AppInfo } from '../../support/AppInfo'

/**
 * Where a Copilot seat signs in: github.com, or a company's GitHub Enterprise Cloud domain on GHE.com.
 * Self-hosted GitHub Enterprise Server is not supported.
 */
export type GitHubDomain =
  | { type: 'github' }
  /** A `<name>.ghe.com` domain. */
  | { type: 'enterprise'; domain: string }

const github: GitHubDomain = { type: 'github' }

export const GitHubDomain = {
  github,

  enterprise(domain: string): GitHubDomain {
    return { type: 'enterprise', domain }
  },

  invalidMessage: `${AppInfo.name} works with GitHub Enterprise on GHE.com. Enter an address like octocorp.ghe.com.`,

  /** `GitHubDomain(saved:)`: the domain an account saved, or github.com when it saved none. */
  fromSaved(domain: string | undefined): GitHubDomain {
    return domain === undefined ? github : GitHubDomain.enterprise(domain)
  },

  /**
   * `GitHubDomain(parsing:)`. Reads a typed or pasted address. It trims and lowercases it and drops the
   * scheme and path, so a pasted link works. Blank or github.com is github.com, and a bare name is
   * `<name>.ghe.com`. Any other address is not a GHE.com domain.
   */
  parsing(input: string): GitHubDomain | undefined {
    let host = input.trim().toLowerCase()
    const scheme = host.indexOf('://')
    if (scheme >= 0) host = host.slice(scheme + 3)
    const end = host.search(/[/?#]/)
    if (end >= 0) host = host.slice(0, end)
    if (host.length === 0 || host === 'github.com' || host === 'www.github.com') return github
    if (!host.includes('.')) host += '.ghe.com'
    if (!host.endsWith('.ghe.com')) return undefined
    const name = host.slice(0, -'.ghe.com'.length)
    if (name.length === 0 || name.startsWith('-') || name.endsWith('-') || !/^[a-z0-9-]+$/.test(name)) return undefined
    return GitHubDomain.enterprise(host)
  },

  /** What an account saves: github.com saves none. */
  saved(domain: GitHubDomain): string | undefined {
    return domain.type === 'enterprise' ? domain.domain : undefined
  },

  host(domain: GitHubDomain): string {
    return GitHubDomain.saved(domain) ?? 'github.com'
  },

  webURL(domain: GitHubDomain, path: string): string {
    return `https://${GitHubDomain.host(domain)}${path}`
  },

  /** GitHub's API lives on `api.` of the same domain: api.github.com, or api.<name>.ghe.com. */
  apiURL(domain: GitHubDomain, path: string): string {
    return `https://api.${GitHubDomain.host(domain)}${path}`
  }
}
