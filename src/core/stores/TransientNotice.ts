import { Observable } from '../support/Observable'
import type { Seconds } from '../support/time'

/** A value that shows briefly and clears itself, such as the "Copied" pill. */
export class TransientNotice<Value> extends Observable {
  value: Value
  trigger = 0

  private clearTimer: ReturnType<typeof setTimeout> | undefined

  constructor(
    private readonly clearedValue: Value,
    private readonly timeout: Seconds
  ) {
    super()
    this.value = clearedValue
  }

  present(newValue: Value): void {
    this.value = newValue
    this.trigger += 1
    if (this.clearTimer !== undefined) clearTimeout(this.clearTimer)
    this.clearTimer = setTimeout(() => {
      this.clearTimer = undefined
      this.value = this.clearedValue
      this.notify()
    }, this.timeout * 1000)
    this.notify()
  }

  clear(): void {
    this.value = this.clearedValue
    if (this.clearTimer !== undefined) clearTimeout(this.clearTimer)
    this.clearTimer = undefined
    this.notify()
  }
}
