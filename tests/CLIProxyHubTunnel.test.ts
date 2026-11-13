import { describe, it, expect } from 'vitest'
import { CLIProxyHub, HubLogin } from '@core/models/CLIProxyHub'
import { NetworkError, type RefreshFailureKind, type RefreshResult } from '@core/models/ProviderSnapshot'
import type { AccountProviderRuntime } from '@core/providers/AccountProviderRuntime'
import { ProviderCatalog } from '@core/providers/ProviderCatalog'
import { ProviderError } from '@core/providers/ProviderError'
import { AntigravityUsageClient } from '@core/providers/antigravity/AntigravityUsageClient'
import { ClaudeUsageClient } from '@core/providers/claude/ClaudeUsageClient'
import { CodexUsageClient } from '@core/providers/codex/CodexUsageClient'
import { GrokUsageClient } from '@core/providers/grok/GrokUsageClient'
import { CLIProxyHubClient, CLIProxyHubGate } from '@core/services/CLIProxyHubClient'
import { HTTPResponse, type HTTPClient, type HTTPRequest } from '@core/services/HTTPClient'
import { AccountStore } from '@core/stores/AccountStore'
import { CLIProxyHubSync } from '@core/stores/CLIProxyHubSync'
import { bodyText } from '@core/support/ProviderParse'
import { InMemoryHubKeyVault, hubLogin, recordedListing } from './CLIProxyHubSupport'
import { HeldResponse, InMemoryCredentialVault, RoutingHTTPClient, isolatedDefaults } from './TestSupport'

/**
 * A mirrored account's unchanged Claude or ChatGPT runtime reads usage through the hub's `api-call`, a
 * wrong management key reaches the hub once, and every hub answer reads as an account-specific message.
 */
const hubURL = 'http://mini.local:8317'
const claudeUsage = '{"five_hour":{"utilization":42,"resets_at":"2099-01-01T00:00:00.000Z"}}'
const antigravitySummary =
  '{"groups":[{"displayName":"Gemini","buckets":[{"bucketId":"gemini-weekly","remainingFraction":0.75,"resetTime":"2099-01-01T00:00:00Z","window":"weekly"}]}]}'
const devinStatus = '{"userStatus":{"planStatus":{"planInfo":{"planName":"Max"},"weeklyQuotaRemainingPercent":40}}}'
const grokCredits =
  '{"config":{"currentPeriod":{"type":"USAGE_PERIOD_TYPE_WEEKLY","start":"2099-01-01T00:00:00Z","end":"2099-01-08T00:00:00Z"},"creditUsagePercent":25}}'

type Upstream = (url: string, header: Record<string, string>) => [status: number, body: string, headers: Record<string, string[]>]

interface APICall {
  authIndex: string
  method: string
  url: string
  header: Record<string, string>
  data: string
}

function apiCall(request: HTTPRequest): APICall {
  const payload = JSON.parse(bodyText(request.body ?? new Uint8Array())) as Record<string, unknown>
  return {
    authIndex: (payload.auth_index as string | undefined) ?? '',
    method: (payload.method as string | undefined) ?? '',
    url: (payload.url as string | undefined) ?? '',
    header: (payload.header as Record<string, string> | undefined) ?? {},
    data: (payload.data as string | undefined) ?? ''
  }
}

const json = (status: number, body: string): HTTPResponse => new HTTPResponse(status, { 'x-cpa-version': 'v8.0.47' }, body)

/** An `api-call` answer in the shape CLIProxyAPI v8.0.47 sends: Go-cased header names with value lists. */
function envelope(status: number, body: string, headers: Record<string, string[]> = {}): HTTPResponse {
  return new HTTPResponse(200, {}, JSON.stringify({ status_code: status, header: { 'Content-Type': ['application/json'], ...headers }, body }))
}

/**
 * A hub that checks the management key, lists the recorded logins, and answers each `api-call`
 * with what `upstream` returns for its URL and headers.
 */
function fakeHub(upstream: Upstream, key = 'mgmt-key', listing: string = recordedListing): RoutingHTTPClient {
  return new RoutingHTTPClient((request) => {
    if (request.headers?.Authorization !== `Bearer ${key}`) return json(401, '{"error":"invalid management key"}')
    switch (new URL(request.url).pathname) {
      case '/v0/management/auth-files':
        return json(200, listing)
      case '/v0/management/api-call': {
        const call = apiCall(request)
        const [status, body, headers] = upstream(call.url, call.header)
        return envelope(status, body, headers)
      }
      default:
        return json(404, '')
    }
  })
}

function listingOf(logins: HubLogin[]): string {
  return JSON.stringify({
    files: logins.map((login) => ({
      id: login.id,
      auth_index: login.authIndex,
      provider: login.provider,
      email: login.label,
      account_type: 'oauth',
      disabled: login.isDisabled
    }))
  })
}

function login(id: string, provider: string, index?: string, disabled = false, workspace?: string): HubLogin {
  return hubLogin({
    id,
    authIndex: index ?? `index-${id}`,
    provider,
    label: `${id}@example.com`,
    isDisabled: disabled,
    chatGPTAccountID: provider === 'codex' ? (workspace ?? `acct-${id}`) : undefined
  })
}

function makeRuntimes(
  gate: CLIProxyHubGate,
  http: HTTPClient,
  logins: HubLogin[],
  key = 'mgmt-key'
): { runtimes: AccountProviderRuntime[]; store: AccountStore; hub: CLIProxyHub } {
  const vault = new InMemoryCredentialVault()
  const store = new AccountStore({ defaults: isolatedDefaults(), vault, hubKeys: new InMemoryHubKeyVault() })
  const hub = CLIProxyHub.make(hubURL)
  store.addHub(hub, key)
  store.mirror(logins, hub.id)
  const runtimes = ProviderCatalog.make({ accounts: [...store.accounts], vault, hubKeys: store.hubKeys, http, hubGate: gate, hubsEnabled: true })
  return { runtimes, store, hub }
}

const failureOf = (result: RefreshResult): { message: string; kind: RefreshFailureKind } | undefined => (result.ok ? undefined : result.failure)

function snapshotOf(result: RefreshResult) {
  if (!result.ok) throw new Error(result.failure.message)
  return result.snapshot
}

describe('CLIProxyHubTunnelTests', () => {
  it('testClaudeAndChatGPTReadUsageThroughTheHubWithTheirClientsUnchanged', async () => {
    const http = fakeHub((url) => (url === ClaudeUsageClient.usageURL ? [200, claudeUsage, {}] : [200, '{"rate_limit":{}}', {}]))
    const { runtimes } = makeRuntimes(new CLIProxyHubGate(), http, [login('a', 'claude'), login('b', 'codex')])

    for (const runtime of runtimes) {
      const result = await runtime.refresh()
      expect(failureOf(result), `${runtime.account.kind}: ${failureOf(result)?.message ?? ''}`).toBeUndefined()
    }
    const claude = snapshotOf(await runtimes[0].refresh())
    expect(claude.lines.length, 'the Claude mapper read the tunnelled answer').toBeGreaterThan(0)

    const calls = http.requests.map(apiCall)
    expect(http.requests.every((request) => request.url === 'http://mini.local:8317/v0/management/api-call')).toBe(true)
    expect(http.requests.every((request) => request.method === 'POST' && request.headers?.Authorization === 'Bearer mgmt-key')).toBe(true)
    const claudeCall = calls.find((call) => call.url === ClaudeUsageClient.usageURL)!
    expect(claudeCall.authIndex).toBe('index-a')
    expect(claudeCall.method).toBe('GET')
    expect(claudeCall.header.Authorization, 'the hub puts its own token in').toBe('Bearer $TOKEN$')
    const codexCall = calls.find((call) => call.url === CodexUsageClient.usageURL)!
    expect(codexCall.authIndex).toBe('index-b')
    expect(codexCall.header.Authorization).toBe('Bearer $TOKEN$')
    expect(codexCall.header['ChatGPT-Account-Id']).toBe('acct-b')
  })

  it('testAntigravityDevinAndGrokReadUsageThroughTheHubWithTheirClientsUnchanged', async () => {
    const http = fakeHub((url) => {
      if (url.endsWith(AntigravityUsageClient.loadCodeAssistPath)) {
        return [200, '{"cloudaicompanionProject":"p-1","currentTier":{"id":"free-tier","name":"Free"}}', {}]
      }
      if (url.endsWith(AntigravityUsageClient.quotaSummaryPath)) return [200, antigravitySummary, {}]
      if (url.endsWith('GetUserStatus')) return [200, devinStatus, {}]
      if (url === GrokUsageClient.creditsConfigURL) return [200, grokCredits, {}]
      return [200, '{}', {}]
    })
    const { runtimes } = makeRuntimes(new CLIProxyHubGate(), http, [login('g', 'antigravity'), login('d', 'devin'), login('x', 'xai')])
    expect(runtimes.map((runtime) => runtime.account.kind)).toEqual(['antigravity', 'devin', 'grok'])

    for (const runtime of runtimes) {
      const snapshot = snapshotOf(await runtime.refresh())
      expect(snapshot.lines.length, `${runtime.account.kind} mapped the tunnelled answer`).toBeGreaterThan(0)
    }
    const calls = http.requests.map(apiCall)
    const quota = calls.find((call) => call.url.endsWith(AntigravityUsageClient.quotaSummaryPath))!
    expect(quota.authIndex).toBe('index-g')
    expect(quota.header.Authorization, 'the hub puts its own, refreshed token in').toBe('Bearer $TOKEN$')
    expect(quota.data.includes('p-1'), 'the quota read names the project from the first call').toBe(true)
    const devin = calls.find((call) => call.url.endsWith('GetUserStatus'))!
    expect(devin.authIndex).toBe('index-d')
    expect(devin.data.includes('"apiKey":"$TOKEN$"'), "Devin's key goes in the body, where the hub substitutes it too").toBe(true)
    const grok = calls.find((call) => call.url === GrokUsageClient.creditsConfigURL)!
    expect(grok.authIndex).toBe('index-x')
    expect(grok.header.Authorization).toBe('Bearer $TOKEN$')
  })

  it('testAWrongManagementKeyReachesTheHubOnceUntilTheKeyIsReplaced', async () => {
    const gate = new CLIProxyHubGate()
    const logins = [1, 2, 3, 4, 5, 6].map((number) => login(`l${number}`, 'claude'))
    const http = fakeHub(() => [200, claudeUsage, {}], 'right-key', listingOf(logins))
    const { runtimes, store, hub } = makeRuntimes(gate, http, logins, 'wrong-key')

    const messages = await Promise.all([...runtimes, ...runtimes].map(async (runtime) => failureOf(await runtime.refresh())?.message))

    expect(http.requests.length, "one strike toward the hub's five-strike IP ban, not one per account").toBe(1)
    expect(new Set(messages)).toEqual(new Set(['The CLIProxyAPI hub at mini.local:8317 rejected the management key. Replace it in Accounts.']))
    await runtimes[0].refresh()
    expect(http.requests.length, 'nothing more goes to the hub').toBe(1)

    const sync = new CLIProxyHubSync(store, new CLIProxyHubClient(http, gate), true)
    await expect(sync.replaceKey('still-wrong', hub.id), 'a refused key is not saved').rejects.toThrow()
    expect(store.hubKeys.load(hub.id)?.key).toBe('wrong-key')
    await sync.replaceKey('right-key', hub.id)
    expect(store.hubKeys.load(hub.id)?.key).toBe('right-key')
    expect(store.accountsOnHub(hub.id).length, 'the same logins, unchanged').toBe(6)
    const resumed = await runtimes[0].refresh()
    expect(failureOf(resumed), 'calls resume once the key is replaced').toBeUndefined()
  })

  it('testALateRejectionOfTheReplacedKeyLeavesTheNewKeyWorking', async () => {
    const gate = new CLIProxyHubGate()
    const held = new HeldResponse()
    const logins = [login('a', 'claude')]
    const hub = fakeHub(() => [200, claudeUsage, {}], 'right-key', listingOf(logins))
    const http = new RoutingHTTPClient(async (request) => {
      if (request.headers?.Authorization === 'Bearer wrong-key') await held.hold()
      return hub.send(request)
    })
    const { runtimes, store, hub: hubAccount } = makeRuntimes(gate, http, logins, 'wrong-key')
    const stale = runtimes[0].refresh()
    await held.waitUntilHeld()

    const sync = new CLIProxyHubSync(store, new CLIProxyHubClient(http, gate), true)
    await sync.replaceKey('right-key', hubAccount.id)
    held.release()
    const staleResult = await stale
    expect(failureOf(staleResult)?.message).toBe('The CLIProxyAPI hub at mini.local:8317 rejected the management key. Replace it in Accounts.')

    const sent = http.requests.length
    const fresh = await runtimes[0].refresh()
    expect(failureOf(fresh), "the old key's late 401 doesn't stop the new key").toBeUndefined()
    expect(http.requests.length, "the new key's request reached the hub").toBeGreaterThan(sent)
    expect(http.requests.at(-1)?.headers?.Authorization).toBe('Bearer right-key')
  })

  it('testAnIPBanStopsCallsToo', async () => {
    const http = new RoutingHTTPClient(() => json(403, '{"error":"IP banned due to too many failed attempts. Try again in 29m12s"}'))
    const { runtimes } = makeRuntimes(new CLIProxyHubGate(), http, [login('a', 'claude'), login('b', 'codex')])

    const first = failureOf(await runtimes[0].refresh())
    const second = failureOf(await runtimes[1].refresh())

    expect(http.requests.length).toBe(1)
    expect(first?.message).toBe(
      'The CLIProxyAPI hub at mini.local:8317 blocked this computer after too many wrong keys. Wait 30 minutes, then replace the management key in Accounts.'
    )
    expect(second?.message).toBe(first?.message)
  })

  it('testEveryHubAnswerReadsAsAnAccountSpecificMessage', async () => {
    const cases: { name: string; answer: () => HTTPResponse; message: string; kind: RefreshFailureKind }[] = [
      {
        name: 'remote management off',
        answer: () => json(403, '{"error":"remote management disabled"}'),
        message: 'The CLIProxyAPI hub at mini.local:8317 only allows management from its own machine. Turn on allow-remote in its config.',
        kind: { type: 'refused' }
      },
      {
        name: 'management API off',
        answer: () => json(404, ''),
        message: 'The CLIProxyAPI hub at mini.local:8317 has its management API turned off. Set a management key in its config.',
        kind: { type: 'refused' }
      },
      {
        name: 'login gone',
        answer: () => json(400, '{"error":"auth credential not found for auth_index"}'),
        message: 'This login is no longer on the CLIProxyAPI hub at mini.local:8317.',
        kind: { type: 'refused' }
      },
      {
        name: 'no token on the hub',
        answer: () => json(400, '{"error":"auth token not found"}'),
        message: 'The CLIProxyAPI hub at mini.local:8317 has no working sign-in for this login. Sign it in again on the hub.',
        kind: { type: 'refused' }
      },
      {
        name: 'upstream unreachable',
        answer: () => json(502, '{"error":"request failed"}'),
        message: 'The CLIProxyAPI hub at mini.local:8317 couldn’t reach Claude.',
        kind: { type: 'unreachable' }
      },
      {
        name: 'hub unreachable',
        answer: () => {
          throw new NetworkError('Could not connect to the server.')
        },
        message: 'Can’t reach the CLIProxyAPI hub at mini.local:8317.',
        kind: { type: 'unreachable' }
      },
      {
        name: "upstream refused the hub's token",
        answer: () => envelope(401, '{"error":"unauthorized"}'),
        message: 'The CLIProxyAPI hub at mini.local:8317 has no working sign-in for this login. Sign it in again on the hub.',
        kind: { type: 'refused' }
      },
      {
        name: "an answer that isn't an envelope",
        answer: () => json(200, '<html></html>'),
        message: ProviderError.invalidResponse.message,
        kind: { type: 'refused' }
      }
    ]
    for (const testCase of cases) {
      const http = new RoutingHTTPClient(() => testCase.answer())
      const { runtimes } = makeRuntimes(new CLIProxyHubGate(), http, [login('a', 'claude')])
      const failure = failureOf(await runtimes[0].refresh())
      expect(failure?.message, testCase.name).toBe(testCase.message)
      expect(failure?.kind, testCase.name).toEqual(testCase.kind)
    }
  })

  it('testAnUpstreamRateLimitKeepsItsRetryAfter', async () => {
    const http = fakeHub(() => [429, '{}', { 'Retry-After': ['120'] }])
    const { runtimes } = makeRuntimes(new CLIProxyHubGate(), http, [login('b', 'codex')])
    const failure = failureOf(await runtimes[0].refresh())
    expect(failure?.kind).toEqual({ type: 'rateLimited', retryAfter: 120 })
  })

  it('testAHubClaudeAccountShowsItsPlanOnItsFirstRefresh', async () => {
    const profile =
      '{"account":{"uuid":"acc-1"},"organization":{"uuid":"6a9f1c2e-1b4d-4c3a-9e8f-0123456789ab","organization_type":"claude_max","rate_limit_tier":"default_claude_max_20x"}}'
    const http = fakeHub((url) => [200, url === ClaudeUsageClient.profileURL ? profile : claudeUsage, {}])
    const { runtimes } = makeRuntimes(new CLIProxyHubGate(), http, [login('a', 'claude')])

    const snapshot = snapshotOf(await runtimes[0].refresh())
    expect(snapshot.plan).toBe('Ultra')
    const profileCalls = http.requests.map(apiCall).filter((call) => call.url === ClaudeUsageClient.profileURL)
    expect(profileCalls.map((call) => call.authIndex)).toEqual(['index-a'])
    expect(profileCalls[0]?.header.Authorization).toBe('Bearer $TOKEN$')

    await runtimes[0].refreshHourlyReads(snapshot)
    const again = http.requests.map(apiCall).filter((call) => call.url === ClaudeUsageClient.profileURL)
    expect(again.length, "the slot doesn't read the profile again within the hour").toBe(1)
    const next = await runtimes[0].refresh()
    expect(snapshotOf(next).plan).toBe('Ultra')
  })

  it('testARelinkedLoginGetsAFreshRuntimeAndARenameKeepsIt', () => {
    const gate = new CLIProxyHubGate()
    const http = fakeHub(() => [200, claudeUsage, {}])
    const { runtimes, store, hub } = makeRuntimes(gate, http, [login('a', 'claude')])
    const account = store.accounts[0]

    store.rename(account.id, 'Team')
    const renamed = ProviderCatalog.make({
      accounts: [...store.accounts],
      vault: store.credentialVault,
      hubKeys: store.hubKeys,
      http,
      hubGate: gate,
      hubsEnabled: true,
      reusing: runtimes
    })
    expect(renamed[0]).toBe(runtimes[0])
    expect(renamed[0].provider.hubHost).toBeDefined()

    store.mirror([login('a', 'claude', 'moved')], hub.id)
    const relinked = ProviderCatalog.make({
      accounts: [...store.accounts],
      vault: store.credentialVault,
      hubKeys: store.hubKeys,
      http,
      hubGate: gate,
      hubsEnabled: true,
      reusing: renamed
    })
    expect(relinked[0], "the tunnel carries the login's auth index").not.toBe(renamed[0])
  })

  it('testAChatGPTWorkspaceSwitchedOnTheHubIsSentWithTheNextRead', async () => {
    const gate = new CLIProxyHubGate()
    const http = fakeHub(() => [200, '{"rate_limit":{}}', {}])
    const { runtimes, store, hub } = makeRuntimes(gate, http, [login('b', 'codex', undefined, false, 'acct-old')])
    const account = store.accounts[0]

    store.mirror([login('b', 'codex', undefined, false, 'acct-new')], hub.id)
    const next = ProviderCatalog.make({
      accounts: [...store.accounts],
      vault: store.credentialVault,
      hubKeys: store.hubKeys,
      http,
      hubGate: gate,
      hubsEnabled: true,
      reusing: runtimes
    })
    await next[0].refresh()

    expect(store.accounts.map((stored) => stored.id), 'the same account, not a new one').toEqual([account.id])
    const call = http.requests.map(apiCall).findLast((sent) => sent.url === CodexUsageClient.usageURL)!
    expect(call.header['ChatGPT-Account-Id']).toBe('acct-new')
  })

  it('testConnectingSavesNothingUntilTheHubAcceptsTheKey', async () => {
    const http = fakeHub(() => [200, '{}', {}], 'right-key')
    const store = new AccountStore({ defaults: isolatedDefaults(), vault: new InMemoryCredentialVault(), hubKeys: new InMemoryHubKeyVault() })
    const sync = new CLIProxyHubSync(store, new CLIProxyHubClient(http, new CLIProxyHubGate()), true)

    await expect(sync.connect('mini.local:8317', 'wrong-key'), 'a wrong key connects nothing').rejects.toThrow()
    expect(store.hubs.length).toBe(0)

    await sync.connect('http://mini.local:8317/management.html', ' right-key ')
    const hub = store.hubs[0]
    expect(hub.url).toBe(hubURL)
    expect(store.accountsOnHub(hub.id).length, 'the disabled login gets no account').toBe(4)
    expect(sync.status(hub.id), 'the Kimi login is counted, not shown').toEqual({ type: 'synced', unsupported: 1 })
    expect(store.hubKeys.load(hub.id)).toEqual({ key: 'right-key', url: hubURL })

    const listings = http.requests.length
    await sync.syncDue()
    expect(http.requests.length, "a hub read moments ago isn't read again").toBe(listings)
    await sync.syncDue(0)
    expect(http.requests.length).toBe(listings + 1)
  })
})
