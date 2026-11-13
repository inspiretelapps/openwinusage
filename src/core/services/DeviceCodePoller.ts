import { NetworkError } from '../models/ProviderSnapshot'
import { AppLog, describeError } from '../support/AppLog'
import { addSeconds, secondsBetween, type Clock, type Seconds } from '../support/time'
import { LoginError, cancellable, throwIfCancelled } from './OAuthLoginSupport'

export type DeviceCodePollResult<Value> =
  | { type: 'pending' }
  | { type: 'slowDown' }
  | { type: 'complete'; value: Value }
  | { type: 'failed'; message: string }

export const DeviceCodePollResult = {
  pending: { type: 'pending' } as DeviceCodePollResult<never>,
  slowDown: { type: 'slowDown' } as DeviceCodePollResult<never>,

  complete<Value>(value: Value): DeviceCodePollResult<Value> {
    return { type: 'complete', value }
  },

  failed(message: string): DeviceCodePollResult<never> {
    return { type: 'failed', message }
  }
}

/** `Task.sleep(for: .seconds(seconds))`: ends early, with `LoginError.cancelled`, when the caller cancels. */
function sleepFor(seconds: Seconds, signal: AbortSignal | undefined): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(LoginError.cancelled)
      return
    }
    const onAbort = (): void => {
      clearTimeout(timer)
      reject(LoginError.cancelled)
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, seconds * 1000)
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

export const DeviceCodePoller = {
  /**
   * Asks `request` every `interval` seconds until it completes, fails, or the code expires. A poll that
   * never reached the server is tried again. Aborting `signal` stops the polling with `LoginError.cancelled`.
   */
  async poll<Value>(
    interval: Seconds,
    expiresIn: Seconds,
    request: () => Promise<DeviceCodePollResult<Value>> | DeviceCodePollResult<Value>,
    now: Clock = Date.now,
    sleep?: (seconds: Seconds) => Promise<void> | void,
    signal?: AbortSignal
  ): Promise<Value> {
    const deadline = addSeconds(now(), expiresIn)
    let delay = Math.max(1, interval)
    let networkError: NetworkError | undefined
    while (now() < deadline) {
      throwIfCancelled(signal)
      let result: DeviceCodePollResult<Value>
      try {
        result = await cancellable(signal, Promise.resolve().then(request))
        networkError = undefined
      } catch (error) {
        if (!(error instanceof NetworkError)) throw error
        AppLog.warn('auth', `device sign-in poll failed; polling again: ${describeError(error)}`)
        networkError = error
        result = DeviceCodePollResult.pending
      }
      switch (result.type) {
        case 'pending':
          break
        case 'slowDown':
          delay += 5
          break
        case 'complete':
          return result.value
        case 'failed':
          throw LoginError.failed(result.message)
      }
      const seconds = Math.min(delay, Math.max(0, secondsBetween(deadline, now())))
      if (sleep) await cancellable(signal, sleep(seconds))
      else await sleepFor(seconds, signal)
    }
    throw networkError ?? LoginError.failed('Device sign-in expired.')
  }
}
