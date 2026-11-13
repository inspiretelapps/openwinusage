import { defaultsEnum, standardDefaults, type Defaults } from '../support/Defaults'

export type DashboardTab = 'priority' | 'allUsage'

export const DashboardTab = {
  /** The tab the panel opens to, no matter which tab it was closed on. */
  defaultKey: 'defaultDashboardTab',
  allCases: ['priority', 'allUsage'] as const satisfies readonly DashboardTab[],

  preferred(defaults: Defaults = standardDefaults()): DashboardTab {
    return defaultsEnum(defaults, DashboardTab.defaultKey, DashboardTab.allCases, 'priority')
  },

  label(tab: DashboardTab): string {
    return tab === 'priority' ? 'Priority' : 'All Usage'
  }
}
