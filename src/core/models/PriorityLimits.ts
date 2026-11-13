import { rounded } from '../support/numbers'

function stride(from: number, through: number, by: number): number[] {
  const out: number[] = []
  for (let value = from; by < 0 ? value >= through : value <= through; value += by) out.push(value)
  return out
}

function snapped(value: number, range: readonly [number, number]): number {
  const stepped = rounded(value / PriorityLimits.step) * PriorityLimits.step
  return Math.min(Math.max(stepped, range[0]), range[1])
}

/**
 * The % left at or under which a limit turns Warning (orange) and Critical (red). Critical always sits
 * under Warning: moving one onto or past the other pushes the other one step along.
 */
export interface PriorityLimits {
  readonly warning: number
  readonly critical: number
}

export const PriorityLimits = {
  step: 5,
  warningRange: [20, 70] as const,
  criticalRange: [5, 25] as const,
  standard: { warning: 30, critical: 10 } as PriorityLimits,
  warningOptions: stride(70, 20, -5),
  criticalOptions: stride(25, 5, -5),

  make(warning: number, critical: number): PriorityLimits {
    const snappedWarning = snapped(warning, PriorityLimits.warningRange)
    return {
      warning: snappedWarning,
      critical: Math.min(snapped(critical, PriorityLimits.criticalRange), snappedWarning - PriorityLimits.step)
    }
  },

  /** Sets Warning, pushing Critical down a step when Warning lands on or under it. */
  settingWarning(limits: PriorityLimits, warning: number): PriorityLimits {
    return { warning, critical: limits.critical >= warning ? warning - PriorityLimits.step : limits.critical }
  },

  /** Sets Critical, pushing Warning up a step when Critical lands on or over it. */
  settingCritical(limits: PriorityLimits, critical: number): PriorityLimits {
    return { critical, warning: limits.warning <= critical ? critical + PriorityLimits.step : limits.warning }
  },

  equal(a: PriorityLimits, b: PriorityLimits): boolean {
    return a.warning === b.warning && a.critical === b.critical
  }
}
