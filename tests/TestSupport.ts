import type { AccountCredential } from '@core/models/Account'
import type { Provider } from '@core/models/Provider'
import type { ProviderSnapshot, RefreshFailure, RefreshResult } from '@core/models/ProviderSnapshot'
import type { WidgetDescriptor } from '@core/models/WidgetDescriptor'
import type { ProviderRuntime } from '@core/providers/ProviderRuntime'
import { CredentialVaultError, MemoryCredentialVault, type CredentialVault } from '@core/services/AccountCredentialVault'
import { HTTPResponse, type HTTPClient, type HTTPRequest } from '@core/services/HTTPClient'
import { MemoryDefaults } from '@core/support/Defaults'
import { DISTANT_PAST, type Instant } from '@core/support/time'

/** Answers every request through `handler` and records what was sent. */
export class RoutingHTTPClient implements HTTPClient {
  readonly requests: HTTPRequest[] = []

  constructor(private readonly handler: (request: HTTPRequest) => HTTPResponse | Promise<HTTPResponse>) {}

  async send(request: HTTPRequest): Promise<HTTPResponse> {
    this.requests.push(request)
    return this.handler(request)
  }
}

/** `HTTPResponse.json(_:status:)` */
export function jsonResponse(text: string, status = 200, headers: Record<string, string> = {}): HTTPResponse {
  return new HTTPResponse(status, headers, text)
}

/** The query string of a request's URL, without the `?`; empty when it has none. */
export function queryOf(request: HTTPRequest): string {
  const index = request.url.indexOf('?')
  return index < 0 ? '' : request.url.slice(index + 1)
}

/** Claude's hourly reset-grants check, which shares the usage endpoint's path. */
export function isClaudeResetGrantsCheck(request: HTTPRequest): boolean {
  return queryOf(request).includes('cedar_ember=1')
}

/** A clock the test moves by hand. Pass `clock.now` wherever a `Clock` is taken. */
export class TestClock {
  private value: Instant = DISTANT_PAST

  constructor(value: Instant) {
    this.value = value
  }

  readonly now = (): Instant => this.value

  set(value: Instant): void {
    this.value = value
  }

  /** Moves the clock forward by `seconds`. */
  advance(seconds: number): void {
    this.value += seconds * 1000
  }
}

export class TestSwitch<Value> {
  constructor(public value: Value) {}
}

type Answer = (refreshCount: number) => RefreshResult

export const success = (snapshot: ProviderSnapshot): RefreshResult => ({ ok: true, snapshot })
export const failure = (failure: RefreshFailure): RefreshResult => ({ ok: false, failure })

export class StubRuntime implements ProviderRuntime {
  readonly provider: Provider
  readonly widgetDescriptors: WidgetDescriptor[]
  answer: Answer
  refreshCount = 0

  constructor(provider: Provider, descriptors: WidgetDescriptor[], answer: Answer) {
    this.provider = provider
    this.widgetDescriptors = descriptors
    this.answer = answer
  }

  static snapshot(provider: Provider, descriptors: WidgetDescriptor[], snapshot: ProviderSnapshot): StubRuntime {
    return new StubRuntime(provider, descriptors, () => success(snapshot))
  }

  static failure(provider: Provider, descriptors: WidgetDescriptor[], refreshFailure: RefreshFailure): StubRuntime {
    return new StubRuntime(provider, descriptors, () => failure(refreshFailure))
  }

  static results(provider: Provider, descriptors: WidgetDescriptor[], results: RefreshResult[]): StubRuntime {
    return new StubRuntime(provider, descriptors, (count) => results[Math.min(count, results.length - 1)])
  }

  async refresh(): Promise<RefreshResult> {
    const result = this.answer(this.refreshCount)
    this.refreshCount += 1
    return result
  }

  forgetHourlyReads(): void {}
  restore(): void {}
  async refreshHourlyReads(): Promise<ProviderSnapshot | undefined> {
    return undefined
  }
}

/** A runtime whose refresh never answers until the test's timeout or `release()`. */
export class HangingProviderRuntime implements ProviderRuntime {
  readonly provider: Provider
  readonly widgetDescriptors: WidgetDescriptor[]
  private releaseHang: (() => void) | undefined

  constructor(provider: Provider, descriptors: WidgetDescriptor[]) {
    this.provider = provider
    this.widgetDescriptors = descriptors
  }

  async refresh(): Promise<RefreshResult> {
    await new Promise<void>((resolve) => {
      this.releaseHang = resolve
    })
    return failure({ message: 'hung', kind: { type: 'refused' } })
  }

  release(): void {
    this.releaseHang?.()
  }

  forgetHourlyReads(): void {}
  restore(): void {}
  async refreshHourlyReads(): Promise<ProviderSnapshot | undefined> {
    return undefined
  }
}

export { MemoryCredentialVault as InMemoryCredentialVault }

export class FailingVault implements CredentialVault {
  readonly loadError = new TestSwitch<Error | undefined>(undefined)
  readonly saveError = new TestSwitch<Error | undefined>(undefined)
  readonly updateError = new TestSwitch<Error | undefined>(undefined)
  readonly deleteError = new TestSwitch<Error | undefined>(undefined)
  private readonly stored = new MemoryCredentialVault()

  load(id: string): AccountCredential | undefined {
    if (this.loadError.value) throw this.loadError.value
    return this.stored.load(id)
  }

  save(credential: AccountCredential, id: string): void {
    if (this.saveError.value) throw this.saveError.value
    this.stored.save(credential, id)
  }

  update(credential: AccountCredential, id: string): void {
    if (this.updateError.value) throw this.updateError.value
    this.stored.update(credential, id)
  }

  delete(id: string): void {
    if (this.deleteError.value) throw this.deleteError.value
    this.stored.delete(id)
  }
}

export { CredentialVaultError }

/** A fresh, empty preferences store: `isolatedDefaults()`. */
export function isolatedDefaults(): MemoryDefaults {
  return new MemoryDefaults()
}

/** A response the test holds open until it calls `release()`. */
export class HeldResponse {
  private released = false
  private held: (() => void)[] = []
  private arrived = false
  private arrivalWaiters: (() => void)[] = []

  async hold(): Promise<void> {
    this.arrived = true
    for (const waiter of this.arrivalWaiters) waiter()
    this.arrivalWaiters = []
    if (this.released) return
    await new Promise<void>((resolve) => this.held.push(resolve))
  }

  async waitUntilHeld(): Promise<void> {
    if (this.arrived) return
    await new Promise<void>((resolve) => this.arrivalWaiters.push(resolve))
  }

  release(): void {
    this.released = true
    for (const resume of this.held) resume()
    this.held = []
  }
}

/** `Date(timeIntervalSince1970:)` for fixtures written in seconds. */
export function unix(seconds: number): Instant {
  return seconds * 1000
}

/** Parses an ISO 8601 timestamp for a fixture; throws on a typo. */
export function iso(text: string): Instant {
  const instant = Date.parse(text)
  if (Number.isNaN(instant)) throw new Error(`bad fixture date: ${text}`)
  return instant
}
