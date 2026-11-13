import type { Account } from '@core/models/Account'
import { Observable } from '@core/support/Observable'

export interface RenameEdit {
  readonly providerID: string
  readonly serial: number
}

/** Which account name is being edited, and the text typed so far. */
export class AccountRenameStore extends Observable {
  edit: RenameEdit | undefined
  private draftText = ''
  private serial = 0

  constructor(
    private readonly account: (providerID: string) => Account | undefined,
    private readonly rename: (providerID: string, label: string) => void
  ) {
    super()
  }

  get draft(): string {
    return this.draftText
  }
  set draft(text: string) {
    this.draftText = text
    this.notify()
  }

  begin(providerID: string): void {
    const account = this.account(providerID)
    if (!account) return
    this.commit()
    this.serial += 1
    this.edit = { providerID, serial: this.serial }
    this.draftText = account.label
    this.notify()
  }

  commit(edit?: RenameEdit): void {
    const open = this.close(edit)
    if (!open) return
    const label = this.draftText.trim()
    const account = this.account(open.providerID)
    if (label.length === 0 || !account || account.label === label) return
    this.rename(open.providerID, label)
  }

  cancel(edit?: RenameEdit): void {
    this.close(edit)
  }

  private close(edit: RenameEdit | undefined): RenameEdit | undefined {
    const open = this.edit
    if (!open || (edit !== undefined && edit.serial !== open.serial)) return undefined
    this.edit = undefined
    this.notify()
    return open
  }
}
