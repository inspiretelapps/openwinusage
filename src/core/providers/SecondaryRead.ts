import { RefreshSetting } from '../stores/RefreshSetting'
import { secondsBetween, type Instant } from '../support/time'

/** A read made at most once an hour (a plan name, reset credits): its last value and when it was read. */
export class SecondaryRead<Value> {
  private current: Value | undefined
  private readAt: Instant | undefined

  get value(): Value | undefined {
    return this.current
  }

  isDue(now: Instant): boolean {
    if (this.readAt === undefined) return true
    return secondsBetween(now, this.readAt) >= RefreshSetting.secondaryReadInterval
  }

  /** Notes the read. A read that came back empty keeps the last value. */
  record(fresh: Value | undefined, now: Instant): void {
    this.readAt = now
    if (fresh !== undefined) this.current = fresh
  }

  forget(): void {
    this.readAt = undefined
  }
}
