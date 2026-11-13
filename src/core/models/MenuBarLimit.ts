export type MenuBarLimit = 'iconOnly' | 'upToOne' | 'upToTwo' | 'upToThree' | 'upToFour' | 'upToFive'

const counts: Record<MenuBarLimit, number> = {
  iconOnly: 0,
  upToOne: 1,
  upToTwo: 2,
  upToThree: 3,
  upToFour: 4,
  upToFive: 5
}

export const MenuBarLimit = {
  allCases: ['iconOnly', 'upToOne', 'upToTwo', 'upToThree', 'upToFour', 'upToFive'] as const satisfies readonly MenuBarLimit[],

  count(limit: MenuBarLimit): number {
    return counts[limit]
  },

  label(limit: MenuBarLimit): string {
    return limit === 'iconOnly' ? 'App Icon Only' : `Up to ${counts[limit]}`
  }
}
