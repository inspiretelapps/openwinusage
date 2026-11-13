import { createContext, useContext, useLayoutEffect, type ReactNode } from 'react'
import type { AddAccountFlowState } from '@core/models/AddAccountChoice'
import { api } from '../../bridge'
import { Button } from '../../components/Controls'
import { ProviderIcon } from '../../components/ProviderIcon'
import './accounts.css'

/** What the user has typed into the sheet. It stays in the panel and goes to the app with the action that uses it. */
export interface SheetFields {
  apiKey: string
  accountName: string
  pastedCode: string
  organization: string
  /** The address typed into Copilot's Domain step. */
  domain: string
  hubURL: string
}

export const emptySheetFields: SheetFields = { apiKey: '', accountName: '', pastedCode: '', organization: '', domain: '', hubURL: '' }

/** What every step of the sheet is given. */
export interface StepProps {
  flow: AddAccountFlowState
  fields: SheetFields
  setField: (name: keyof SheetFields, value: string) => void
  cancel: () => void
}

/** Asks the app to do something. A failure shows as the flow's own error, so a rejected call needs no handling here. */
export function send(call: Promise<unknown>): void {
  call.catch(() => undefined)
}

/** Links in the sheet open in the user's browser. */
export function SheetLink(props: { title: string; destination: string }): ReactNode {
  return (
    <button type="button" className="plain-button sheet-link" onClick={() => send(api.openExternal(props.destination))}>
      {props.title}
    </button>
  )
}

/** What Esc and Return do on the step that is showing (upstream's `.cancelAction` and `.defaultAction` shortcuts). */
export interface SheetKeys {
  cancel?: () => void
  primary?: () => void
}

export const SheetKeysContext = createContext<{ current: SheetKeys }>({ current: {} })

/** A step names its Esc and Return actions; they hold until another step names its own. */
export function useSheetKeys(cancel: (() => void) | undefined, primary: (() => void) | undefined): void {
  const keys = useContext(SheetKeysContext)
  useLayoutEffect(() => {
    keys.current = { cancel, primary }
  })
}

export function SheetHeader(props: { icon?: string; title: string; message: string; link?: ReactNode }): ReactNode {
  return (
    <div className="sheet-header">
      {props.icon !== undefined ? <ProviderIcon id={props.icon} side={32} inset={0.04} style={{ marginBottom: 8 }} /> : null}
      <div className="sheet-header-title">{props.title}</div>
      <div className="sheet-header-message">{props.message}</div>
      {props.link !== undefined ? <div className="sheet-header-link">{props.link}</div> : null}
    </div>
  )
}

export interface SheetAction {
  title: string
  isDisabled?: boolean
  action: () => void
}

/** The sheet's two buttons, sharing its width: the bordered one, then the prominent one, which Return presses. */
export function SheetButtons(props: { secondary: SheetAction; primary: SheetAction; cancel: (() => void) | undefined }): ReactNode {
  const { secondary, primary } = props
  useSheetKeys(props.cancel, primary.isDisabled ? undefined : primary.action)
  return (
    <div className="sheet-buttons">
      <Button onClick={secondary.action} disabled={secondary.isDisabled}>
        {secondary.title}
      </Button>
      <Button variant="prominent" onClick={primary.action} disabled={primary.isDisabled}>
        {primary.title}
      </Button>
    </div>
  )
}

export function CancelRow(props: { cancel: () => void }): ReactNode {
  return (
    <div className="sheet-cancel-row">
      <Button onClick={props.cancel}>Cancel</Button>
    </div>
  )
}
