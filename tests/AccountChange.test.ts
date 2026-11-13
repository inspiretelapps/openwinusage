import { describe, expect, it } from 'vitest'
import { Account, AccountCredential } from '@core/models/Account'
import { ProviderSnapshot } from '@core/models/ProviderSnapshot'
import { UsageBreakdown, UsageTotals } from '@core/models/UsageHistory'
import { OpenRouterUsageClient } from '@core/providers/openrouter/OpenRouterUsageClient'
import { HTTPResponse, type HTTPRequest } from '@core/services/HTTPClient'
import { ProviderSnapshotCache } from '@core/stores/ProviderSnapshotCache'
import { AppInfo } from '@core/support/AppInfo'
import { OpenRouterFixtures } from './OpenRouterFixtures'
import { HeldResponse, InMemoryCredentialVault, RoutingHTTPClient, isolatedDefaults } from './TestSupport'
import { containerForTesting, makeAccountStore, messageOf, settle, waitUntil } from './support/accountHelpers'

function acceptedRead(request: HTTPRequest): HTTPResponse {
  return request.url === OpenRouterUsageClient.keyURL
    ? OpenRouterFixtures.response(200, OpenRouterFixtures.standardKey)
    : OpenRouterFixtures.response(403, OpenRouterFixtures.forbidden)
}

const authorization = (request: HTTPRequest): string | undefined => request.headers?.Authorization

const keyOf = (vault: InMemoryCredentialVault, id: string): AccountCredential | undefined => vault.load(id)

/** Swift's `breakdown.models`: the ranking of the first figure the models report. */
function modelNames(breakdown: UsageBreakdown | undefined): string[] | undefined {
  if (!breakdown) return undefined
  const figure = UsageBreakdown.modelFigures(breakdown)[0]
  return figure === undefined ? [] : UsageBreakdown.models(breakdown, figure).map((model) => model.name)
}

const openRouterLabels = ['Key Limit', 'Budget', 'Free Requests', 'Today', 'This Week', 'This Month']

describe('AccountChangeTests', () => {
  it('testAccountChangesUpdateTheDashboardInPlace', async () => {
    const defaults = isolatedDefaults()
    const accounts = makeAccountStore({ defaults })
    const container = containerForTesting(accounts, defaults)
    const layout = container.layout
    const dataStore = container.dataStore
    expect(layout.displayGroups.length).toBe(0)

    const codex = accounts.add({ kind: 'codex', label: 'Work', credential: AccountCredential.apiKey('key') })
    const codexID = Account.cardID(codex)
    await waitUntil(() => JSON.stringify(layout.displayGroups.map((group) => group.provider.id)) === JSON.stringify([codexID]))
    expect(layout.displayGroups[0]?.provider.accountLabel).toBe('Work')

    const claude = accounts.add({ kind: 'claude', label: 'Home', credential: AccountCredential.apiKey('key') })
    await waitUntil(() => layout.displayGroups.length === 2)
    expect(new Set(layout.displayGroups.map((group) => group.provider.id))).toEqual(new Set([codexID, Account.cardID(claude)]))

    accounts.rename(codex.id, 'Personal')
    await waitUntil(() => layout.displayGroups.find((group) => group.provider.id === codexID)?.provider.accountLabel === 'Personal')

    accounts.remove(claude.id)
    await waitUntil(() => JSON.stringify(layout.displayGroups.map((group) => group.provider.id)) === JSON.stringify([codexID]))

    expect(container.layout).toBe(layout)
    expect(container.dataStore).toBe(dataStore)
  })

  it('testReplacingAKeySavesOnlyAKeyTheProviderAcceptsAndKeepsTheAccount', async () => {
    const defaults = isolatedDefaults()
    const vault = new InMemoryCredentialVault()
    const accounts = makeAccountStore({ defaults, vault })
    const http = new RoutingHTTPClient((request) => {
      if (authorization(request) !== 'Bearer new-key') return new HTTPResponse(401)
      return acceptedRead(request)
    })
    const container = containerForTesting(accounts, defaults, http)
    const personal = accounts.add({ kind: 'openrouter', label: 'Personal', credential: AccountCredential.apiKey('old-key') })
    const work = accounts.add({ kind: 'openrouter', label: 'Work', credential: AccountCredential.apiKey('work-key') })
    const personalID = Account.cardID(personal)
    const dataStore = container.dataStore
    await waitUntil(() => dataStore.errorMessage(personalID) !== undefined && dataStore.errorMessage(Account.cardID(work)) !== undefined)

    const refused = await settle(container.replaceKey('refused-key', personalID))
    expect(refused.ok, 'a refused key was accepted').toBe(false)
    if (!refused.ok) expect(messageOf(refused.error)).toBe('OpenRouter rejected the API key.')
    expect(keyOf(vault, personal.id)).toEqual(AccountCredential.apiKey('old-key'))

    const taken = await settle(container.replaceKey('work-key', personalID))
    expect(taken.ok, "another account's key was accepted").toBe(false)
    if (!taken.ok) expect(messageOf(taken.error)).toBe('This account is already added as Work.')
    expect(keyOf(vault, personal.id)).toEqual(AccountCredential.apiKey('old-key'))
    vault.delete(personal.id)

    await container.replaceKey(' new-key ', personalID)

    expect(keyOf(vault, personal.id)).toEqual(AccountCredential.apiKey('new-key'))
    expect(accounts.accounts.map((account) => account.id)).toEqual([personal.id, work.id])
    expect(accounts.accounts.map((account) => account.label)).toEqual(['Personal', 'Work'])
    expect(dataStore.errorMessage(personalID)).toBeUndefined()
    expect(dataStore.snapshots[personalID]).toBeDefined()
  })

  it('testAnInFlightRateLimitFromTheOldKeyDoesNotHoldTheNewKey', async () => {
    const defaults = isolatedDefaults()
    const vault = new InMemoryCredentialVault()
    const accounts = makeAccountStore({ defaults, vault })
    const oldRead = new HeldResponse()
    const http = new RoutingHTTPClient(async (request) => {
      if (authorization(request) !== 'Bearer new-key') {
        await oldRead.hold()
        return new HTTPResponse(429, { 'retry-after': '3600' })
      }
      return acceptedRead(request)
    })
    const account = accounts.add({ kind: 'openrouter', label: 'Personal', credential: AccountCredential.apiKey('old-key') })
    const cardID = Account.cardID(account)
    const container = containerForTesting(accounts, defaults, http)
    const dataStore = container.dataStore
    const oldRefresh = dataStore.refresh(cardID, true)
    await oldRead.waitUntilHeld()
    expect([...dataStore.refreshingProviderIDs]).toEqual([cardID])

    const replace = container.replaceKey('new-key', cardID)
    await waitUntil(() => AccountCredential.equal(keyOf(vault, account.id), AccountCredential.apiKey('new-key')))
    oldRead.release()
    await replace
    const oldOutcome = await oldRefresh
    expect(oldOutcome).toBe('skipped')
    expect(dataStore.refreshingProviderIDs.size).toBe(0)

    expect(keyOf(vault, account.id)).toEqual(AccountCredential.apiKey('new-key'))
    expect(dataStore.backoffs[cardID]).toBeUndefined()
    expect(dataStore.snapshots[cardID]?.lines.map((line) => line.label)).toEqual(openRouterLabels)
  })

  it('testAReplacedKeyIsReadAtOnceWhileTheOldKeyIsRateLimited', async () => {
    const defaults = isolatedDefaults()
    const accounts = makeAccountStore({ defaults })
    const http = new RoutingHTTPClient((request) => {
      if (authorization(request) !== 'Bearer new-key') return new HTTPResponse(429, { 'retry-after': '3600' })
      return acceptedRead(request)
    })
    const container = containerForTesting(accounts, defaults, http)
    const account = accounts.add({ kind: 'openrouter', label: 'Personal', credential: AccountCredential.apiKey('old-key') })
    const cardID = Account.cardID(account)
    const dataStore = container.dataStore
    await waitUntil(() => dataStore.backoffs[cardID]?.providerAsked === true)

    await container.replaceKey('new-key', cardID)

    expect(dataStore.snapshots[cardID]?.lines.map((line) => line.label), "the old key's 429 held the new key").toEqual(openRouterLabels)
  })

  it('testReplacingAManagementKeyReplacesItsHistoricalWorkspaceUsage', async () => {
    const defaults = isolatedDefaults()
    const accounts = makeAccountStore({ defaults })
    // A completed day that would normally stay in the runtime's ledger until it ages out.
    const date = new Date(Date.now() - 7 * 86_400_000).toISOString().slice(0, 10)
    const http = new RoutingHTTPClient((request) => {
      if (new URL(request.url).pathname !== '/api/v1/activity') return OpenRouterFixtures.managementAccount(request)
      const old = authorization(request) === 'Bearer old-key'
      const model = old ? 'old-workspace-model' : 'new-workspace-model'
      const body = `{"data":[{"date":"${date}","model":"${model}","usage":${old ? 10 : 2},"requests":1,"prompt_tokens":3,"completion_tokens":2}]}`
      return OpenRouterFixtures.response(200, body)
    })
    const container = containerForTesting(accounts, defaults, http)
    const account = accounts.add({ kind: 'openrouter', label: 'Work', credential: AccountCredential.apiKey('old-key') })
    const cardID = Account.cardID(account)
    const descriptor = container.layout.registry.descriptors(cardID).find((candidate) => candidate.key === 'prior30')
    if (!descriptor) throw new Error('no prior30 descriptor')
    await waitUntil(() => container.dataStore.snapshots[cardID] !== undefined)
    expect(modelNames(container.dataStore.usageBreakdown(descriptor))).toEqual(['old-workspace-model'])

    await container.replaceKey('new-key', cardID)

    const breakdown = container.dataStore.usageBreakdown(descriptor)
    if (!breakdown) throw new Error('no breakdown')
    expect(modelNames(breakdown)).toEqual(['new-workspace-model'])
    expect(UsageTotals.get(breakdown.totals, 'spend')).toBe(2)
    const saved = new ProviderSnapshotCache(defaults).load()[cardID]
    if (!saved) throw new Error('nothing saved')
    const line = ProviderSnapshot.line(saved, descriptor.metricLabel)
    if (line?.type !== 'values') throw new Error("the replacement's usage was not saved")
    expect(line.values[0]?.number).toBe(2)
  })

  it('testAKeyAcceptedAfterTheAccountIsRemovedIsNotSaved', async () => {
    const defaults = isolatedDefaults()
    const vault = new InMemoryCredentialVault()
    const accounts = makeAccountStore({ defaults, vault })
    const newKeyRead = new HeldResponse()
    const http = new RoutingHTTPClient(async (request) => {
      if (authorization(request) !== 'Bearer new-key') return new HTTPResponse(401)
      await newKeyRead.hold()
      return acceptedRead(request)
    })
    const container = containerForTesting(accounts, defaults, http)
    const account = accounts.add({ kind: 'openrouter', label: 'Personal', credential: AccountCredential.apiKey('old-key') })

    const replace = container.replaceKey('new-key', Account.cardID(account))
    await newKeyRead.waitUntilHeld()
    accounts.remove(account.id)
    newKeyRead.release()
    await replace

    expect(keyOf(vault, account.id), "the removed account's key came back").toBeUndefined()
    expect(accounts.accounts.length).toBe(0)
  })

  it('testAKeyAddedToAnotherAccountDuringValidationIsRejected', async () => {
    const defaults = isolatedDefaults()
    const vault = new InMemoryCredentialVault()
    const accounts = makeAccountStore({ defaults, vault })
    const checking = new HeldResponse()
    const http = new RoutingHTTPClient(async (request) => {
      if (authorization(request) === 'Bearer shared') await checking.hold()
      return acceptedRead(request)
    })
    const container = containerForTesting(accounts, defaults, http)
    const first = accounts.add({ kind: 'openrouter', label: 'Personal', credential: AccountCredential.apiKey('original') })
    const replacement = settle(container.replaceKey('shared', Account.cardID(first)))
    await checking.waitUntilHeld()
    accounts.add({ kind: 'openrouter', label: 'Work', credential: AccountCredential.apiKey('shared') })
    checking.release()

    const result = await replacement
    expect(result.ok, 'The same key was saved to both accounts').toBe(false)
    if (!result.ok) expect(messageOf(result.error)).toBe('This account is already added as Work.')
    expect(keyOf(vault, first.id)).toEqual(AccountCredential.apiKey('original'))
  })

  it('testAnEarlierEditCannotOverwriteAKeyReplacedWhileItWasValidating', async () => {
    const defaults = isolatedDefaults()
    const vault = new InMemoryCredentialVault()
    const accounts = makeAccountStore({ defaults, vault })
    const checking = new HeldResponse()
    const http = new RoutingHTTPClient(async (request) => {
      if (authorization(request) === 'Bearer earlier') await checking.hold()
      return acceptedRead(request)
    })
    const container = containerForTesting(accounts, defaults, http)
    const account = accounts.add({ kind: 'openrouter', label: 'Personal', credential: AccountCredential.apiKey('original') })
    const cardID = Account.cardID(account)
    const earlier = settle(container.replaceKey('earlier', cardID))
    await checking.waitUntilHeld()
    await container.replaceKey('later', cardID)
    checking.release()

    const result = await earlier
    expect(result.ok, 'The superseded edit appeared to succeed').toBe(false)
    if (!result.ok) expect(messageOf(result.error)).toBe(`This account’s sign-in changed while ${AppInfo.name} was checking it. Try again.`)
    expect(keyOf(vault, account.id)).toEqual(AccountCredential.apiKey('later'))
  })
})
