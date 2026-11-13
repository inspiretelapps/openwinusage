/**
 * Time conventions for the whole port.
 *
 * - An `Instant` is a point in time as epoch **milliseconds** (what `Date.now()` returns). It stands in
 *   for Swift's `Date` everywhere, so state serialises to JSON and crosses IPC unchanged.
 * - `Seconds` is a duration in **seconds**, exactly like Swift's `TimeInterval`. Durations that the
 *   Swift code keeps in milliseconds (`periodDurationMs`) stay in milliseconds and keep the `Ms` suffix.
 *
 * Use the helpers below instead of raw arithmetic, so the unit is always visible at the call site.
 */
export type Instant = number
export type Seconds = number

/** `later.timeIntervalSince(earlier)` */
export function secondsBetween(later: Instant, earlier: Instant): Seconds {
  return (later - earlier) / 1000
}

/** `instant.addingTimeInterval(seconds)` */
export function addSeconds(instant: Instant, seconds: Seconds): Instant {
  return instant + seconds * 1000
}

/** `Date(timeIntervalSince1970:)` */
export function fromUnixSeconds(seconds: number): Instant {
  return seconds * 1000
}

/** `date.timeIntervalSince1970` */
export function toUnixSeconds(instant: Instant): number {
  return instant / 1000
}

/** `Date.distantPast` / `Date.distantFuture`: the limits of what a JS `Date` can hold. */
export const DISTANT_PAST: Instant = -8.64e15
export const DISTANT_FUTURE: Instant = 8.64e15

export function nowInstant(): Instant {
  return Date.now()
}

export type Clock = () => Instant
