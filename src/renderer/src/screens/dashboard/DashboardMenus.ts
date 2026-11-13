import { DashboardAccount, type DashboardFamily } from '@core/models/DashboardFamilies'
import { Provider } from '@core/models/Provider'
import type { MenuItemSpec } from '@shared/ipc'
import { showMenu } from '../../components/Controls'

export type DashboardCommand =
  | { type: 'refresh'; accountIDs: string[] }
  | { type: 'manageAccounts' }
  | { type: 'open'; url: string }
  | { type: 'rename'; accountID: string }
  | { type: 'editAccount'; accountID: string }
  | { type: 'shareScreenshot'; accountIDs: string[] }
  | { type: 'setPinned'; metricID: string; pinned: boolean }
  | { type: 'hide'; metricID: string }

export interface DashboardMenuItem {
  readonly title: string
  /** Left out for a line that only informs, such as why an account failed. */
  readonly command?: DashboardCommand
  /** The SF Symbol upstream draws beside the title. A native Windows menu shows the title alone. */
  readonly systemImage?: string
}

export type DashboardMenuSections = DashboardMenuItem[][]

function links(provider: Provider): DashboardMenuItem[] {
  return Provider.links(provider).map((link) => ({ title: link.label, command: { type: 'open', url: link.url } }))
}

export const DashboardMenus = {
  provider(family: DashboardFamily): DashboardMenuSections {
    const accountIDs = family.accounts.map(DashboardAccount.id)
    const sections: DashboardMenuSections = [
      [{ title: 'Refresh', command: { type: 'refresh', accountIDs } }],
      [{ title: 'Manage Accounts…', command: { type: 'manageAccounts' } }],
      [{ title: 'Share Screenshot', command: { type: 'shareScreenshot', accountIDs } }],
      links(family.provider)
    ]
    return sections.filter((section) => section.length > 0)
  },

  metric(metricID: string, pinned: boolean): DashboardMenuItem[] {
    return [
      pinned
        ? { title: 'Unpin', command: { type: 'setPinned', metricID, pinned: false }, systemImage: 'pin.slash' }
        : { title: 'Pin', command: { type: 'setPinned', metricID, pinned: true }, systemImage: 'pin' },
      { title: 'Hide', command: { type: 'hide', metricID }, systemImage: 'eye.slash' }
    ]
  },

  account(account: DashboardAccount, status: string | undefined): DashboardMenuSections {
    const id = DashboardAccount.id(account)
    const billing = Provider.organizationBillingPage(account.provider)
    const sections: DashboardMenuSections = [
      status !== undefined ? [{ title: status }] : [],
      [
        { title: 'Refresh', command: { type: 'refresh', accountIDs: [id] } },
        { title: 'Rename', command: { type: 'rename', accountID: id } },
        { title: 'Edit Account…', command: { type: 'editAccount', accountID: id } }
      ],
      [{ title: 'Share Screenshot', command: { type: 'shareScreenshot', accountIDs: [id] } }],
      billing !== undefined ? [{ title: 'Organization Billing', command: { type: 'open', url: billing } }] : []
    ]
    return sections.filter((section) => section.length > 0)
  },

  /** The sections as one native menu, a separator between each two. An item's id is its place in `commands`. */
  items(sections: DashboardMenuSections): { items: MenuItemSpec[]; commands: DashboardCommand[] } {
    const items: MenuItemSpec[] = []
    const commands: DashboardCommand[] = []
    sections.forEach((section, index) => {
      if (index > 0) items.push({ type: 'separator' })
      for (const entry of section) {
        if (entry.command === undefined) {
          items.push({ label: entry.title, enabled: false, isInformational: true })
        } else {
          items.push({ id: String(commands.length), label: entry.title })
          commands.push(entry.command)
        }
      }
    })
    return { items, commands }
  }
}

/** Upstream's `DashboardMenu`: shows the sections as a native menu at the pointer and performs what is chosen. */
export async function showDashboardMenu(sections: DashboardMenuSections, perform: (command: DashboardCommand) => void): Promise<void> {
  if (sections.length === 0) return
  const { items, commands } = DashboardMenus.items(sections)
  const chosen = await showMenu(items)
  if (chosen === undefined) return
  const command = commands[Number(chosen)]
  if (command !== undefined) perform(command)
}
