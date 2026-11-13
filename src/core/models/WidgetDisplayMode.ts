export type WidgetDisplayMode = 'used' | 'remaining'

export const WidgetDisplayMode = {
  allCases: ['used', 'remaining'] as const satisfies readonly WidgetDisplayMode[],

  label(mode: WidgetDisplayMode): string {
    return mode === 'used' ? 'Used' : 'Left'
  },

  toggled(mode: WidgetDisplayMode): WidgetDisplayMode {
    return mode === 'used' ? 'remaining' : 'used'
  }
}
