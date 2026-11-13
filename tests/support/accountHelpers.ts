import { AppContainer } from '@core/app/AppContainer'
import type { AddAccountFlow } from '@core/app/AddAccountFlow'
import type { AccountCredential } from '@core/models/Account'
import { NetworkError } from '@core/models/ProviderSnapshot'
import type { CredentialVault } from '@core/services/AccountCredentialVault'
import type { HTTPClient, HTTPRequest, HTTPResponse } from '@core/services/HTTPClient'
import { MemoryHubKeyVault, type HubKeyVault } from '@core/services/HubKeyVault'
import { LoginError } from '@core/services/OAuthLoginSupport'
import type { LoginPrompt, ProviderLogin } from '@core/services/ProviderLogin'
import { AccountStore } from '@core/stores/AccountStore'
import type { Defaults } from '@core/support/Defaults'
import { InMemoryCredentialVault, isolatedDefaults } from '../TestSupport'

/**
 * `AccountStore(defaults:vault:hubKeys:makeID:)`, with upstream's defaults: an isolated preferences
 * store, an in-memory vault, and an in-memory hub key vault.
 */
export function makeAccountStore(
  options: { defaults?: Defaults; vault?: CredentialVault; hubKeys?: HubKeyVault; makeID?: () => string } = {}
): AccountStore {
  return new AccountStore({
    defaults: options.defaults ?? isolatedDefaults(),
    vault: options.vault ?? new InMemoryCredentialVault(),
    hubKeys: options.hubKeys ?? new MemoryHubKeyVault(),
    makeID: options.makeID
  })
}

/** A client that never reaches a server: the stand-in for upstream's default `URLSessionHTTPClient()`. */
export class OfflineHTTPClient implements HTTPClient {
  readonly requests: HTTPRequest[] = []

  async send(request: HTTPRequest): Promise<HTTPResponse> {
    this.requests.push(request)
    throw new NetworkError()
  }
}

/** `AppContainer.forTesting(accounts:defaults:http:)`. There is no telemetry in this port. */
export function containerForTesting(accounts: AccountStore, defaults: Defaults, http: HTTPClient = new OfflineHTTPClient()): AppContainer {
  return new AppContainer({ accounts, defaults, http })
}

/** One turn of the event loop: lets pending promises, I/O, and expired timers run. */
export function tick(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve))
}

/**
 * Upstream's `waitUntil(timeout:_:)`: yields to the event loop until `condition` holds, failing after
 * `timeout` seconds. It never sleeps; each pass is one turn of the loop.
 */
export async function waitUntil(condition: () => boolean, timeout = 2): Promise<void> {
  const deadline = Date.now() + timeout * 1000
  while (!condition()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting')
    await tick()
  }
}

/** The outcome of a promise without throwing: Swift's `await task.result`. */
export async function settle<T>(promise: Promise<T>): Promise<{ ok: true; value: T } | { ok: false; error: unknown }> {
  try {
    return { ok: true, value: await promise }
  } catch (error) {
    return { ok: false, error }
  }
}

/** The message an error shows: Swift's `error.localizedDescription`. */
export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Upstream's `StoredAccountList`: a stored account list with a Claude account and an entry of a kind this
 * build does not have, with a field this build does not know, as a build with another provider would save
 * it. Stored as this port stores it: JSON values, `addedAt` in epoch milliseconds.
 */
export const StoredAccountList = {
  /** `Date(timeIntervalSinceReferenceDate: 0)` */
  claude: {
    id: '8ad3b217-0000-4000-8000-000000000000',
    kind: 'claude',
    label: 'Work',
    addedAt: 978_307_200_000
  } as const,
  futureEntry: '{"id":"F00DF00D-0000-4000-8000-000000000000","kind":"future-provider","label":"Future","seats":[{"id":1}],"addedAt":1}',
  /** The stored list, parsed afresh for each use. */
  get data(): unknown[] {
    return JSON.parse(
      '[{"id":"8AD3B217-0000-4000-8000-000000000000","kind":"claude","label":"Work","addedAt":978307200000},' + StoredAccountList.futureEntry + ']'
    ) as unknown[]
  }
}

type LoginResult = { label: string; credential: AccountCredential }

/**
 * Upstream's private `StubLogin` (AddAccountFlowTests): shows `prompt` when it has one, then answers with
 * `finish`, which gets the pasted codes and the sign-in's abort signal.
 */
export class StubLogin implements ProviderLogin {
  constructor(
    readonly finish: (input: AsyncIterable<string>, signal: AbortSignal | undefined) => Promise<LoginResult>,
    readonly prompt?: LoginPrompt
  ) {}

  async login(
    show: (prompt: LoginPrompt) => Promise<void> | void,
    pastedCode: AsyncIterable<string>,
    signal?: AbortSignal
  ): Promise<LoginResult> {
    if (this.prompt) await show(this.prompt)
    return this.finish(pastedCode, signal)
  }
}

/** `Task.sleep` that only ends when the sign-in is cancelled: rejects with `LoginError.cancelled` on abort. */
export function untilCancelled(signal: AbortSignal | undefined): Promise<never> {
  return new Promise<never>((_, reject) => {
    if (signal?.aborted) {
      reject(LoginError.cancelled)
      return
    }
    signal?.addEventListener('abort', () => reject(LoginError.cancelled), { once: true })
  })
}

/** The sheet's `canAddKey`, from what the flow shows and what the user typed. */
export function canAddKey(flow: AddAccountFlow, apiKey: string, organization = ''): boolean {
  const state = flow.state
  return apiKey.trim().length > 0 && !state.isWorking && (state.method?.type !== 'organizationToken' || organization.trim().length > 0)
}

/** The sheet's `canSubmitCode`, from what the flow shows and what the user pasted. */
export function canSubmitCode(flow: AddAccountFlow, pastedCode: string): boolean {
  return pastedCode.trim().length > 0 && flow.state.acceptsCode
}
