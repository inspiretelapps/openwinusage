/** Swift's `Double.rounded()`: to nearest, ties away from zero. `Math.round` sends -0.5 to -0. */
export function rounded(value: number): number {
  if (!Number.isFinite(value)) return value
  return value < 0 ? -Math.round(-value) : Math.round(value)
}

/** Swift's `rounded(.up)` / `rounded(.down)`. */
export const roundedUp = Math.ceil
export const roundedDown = Math.floor

export function clamp(value: number, lower: number, upper: number): number {
  return Math.min(Math.max(value, lower), upper)
}

/** `truncatingRemainder(dividingBy:)` is the JS `%` operator; named for readable ports. */
export function truncatingRemainder(value: number, divisor: number): number {
  return value % divisor
}
