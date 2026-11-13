export type ResetDisplayMode = 'relative' | 'absolute'

export const ResetDisplayMode = {
  allCases: ['relative', 'absolute'] as const satisfies readonly ResetDisplayMode[],

  label(mode: ResetDisplayMode): string {
    return mode === 'relative' ? 'Countdown' : 'Exact Time'
  },

  toggled(mode: ResetDisplayMode): ResetDisplayMode {
    return mode === 'relative' ? 'absolute' : 'relative'
  }
}
