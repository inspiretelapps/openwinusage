import { createContext, useContext } from 'react'

/**
 * A confirmation dialog covers the panel, and the panel is only as tall as its page. A page under
 * `AccountsView` passes this to `ConfirmDialog`'s `onHeight` so the page grows to hold the dialog.
 */
export const DialogSpaceContext = createContext<(height: number | undefined) => void>(() => undefined)

export function useDialogSpace(): (height: number | undefined) => void {
  return useContext(DialogSpaceContext)
}
