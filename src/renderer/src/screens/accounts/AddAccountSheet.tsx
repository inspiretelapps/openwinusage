import { useEffect, useRef, useState, type ReactNode } from 'react'
import { AddAccountChoice, type AddAccountFlowState } from '@core/models/AddAccountChoice'
import { Account, ProviderKind, type ProviderAuthMethod } from '@core/models/Account'
import { CLIProxyHub } from '@core/models/CLIProxyHub'
import { GitHubDomain } from '@core/providers/copilot/GitHubDomain'
import { api } from '../../bridge'
import { Spinner } from '../../components/Controls'
import { Form, FormSection, FormTextField } from '../../components/Form'
import { Icon } from '../../components/Icon'
import { ProviderIcon } from '../../components/ProviderIcon'
import { usePopover, useStores } from '../../state/context'
import { HubConnectStep } from './AddHubStep'
import { ErrorText } from './ErrorText'
import {
  CancelRow,
  SheetButtons,
  SheetHeader,
  SheetKeysContext,
  SheetLink,
  emptySheetFields,
  send,
  useSheetKeys,
  type SheetAction,
  type SheetFields,
  type SheetKeys,
  type StepProps
} from './SheetParts'
import './accounts.css'

function choiceKey(choice: AddAccountChoice): string {
  return choice.type === 'provider' ? choice.kind : 'cliproxyHub'
}

/**
 * The Add Account sheet: pick a provider, then sign in the way it asks. The flow itself runs in the
 * app (`stores.state.addAccount`); this draws it, keeps what is typed, and sends each action.
 */
export function AddAccountSheet({ onClose }: { onClose: () => void }): ReactNode {
  const stores = useStores()
  const popover = usePopover()
  const [fields, setFields] = useState<SheetFields>(emptySheetFields)
  const keys = useRef<SheetKeys>({})
  const close = useRef(onClose)
  close.current = onClose

  // Until the app has opened the flow, draw the step it will open on.
  const signingInAgain = popover.signingInAgainProviderID !== undefined ? stores.account(popover.signingInAgainProviderID) : undefined
  const pending: AddAccountFlowState = {
    isConnectingHub: false,
    isWorking: false,
    isFinished: false,
    isSigningInAgain: signingInAgain !== undefined,
    acceptsCode: false,
    isCodeSubmitted: false,
    isEnteringDomain: false,
    canChangeDomain: false,
    ...(signingInAgain
      ? { provider: signingInAgain.kind, method: Account.authMethod(signingInAgain), gitHubDomain: GitHubDomain.fromSaved(signingInAgain.domain) }
      : {})
  }
  const flow = stores.state.addAccount ?? pending

  // The sheet closes when the flow finishes. A flow left finished by an earlier sheet doesn't count.
  const hasSeenUnfinished = useRef(false)
  useEffect(() => {
    if (!flow.isFinished) hasSeenUnfinished.current = true
    else if (hasSeenUnfinished.current) close.current()
  }, [flow.isFinished])

  // Esc is the step's Cancel and Return its default button. Registered once, ahead of the sheet's own Esc.
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopImmediatePropagation()
        ;(keys.current.cancel ?? close.current)()
      } else if (event.key === 'Enter' && !event.ctrlKey && !event.metaKey && !event.altKey) {
        const tag = (event.target as HTMLElement | null)?.tagName
        if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'BUTTON' || tag === 'A') return
        event.preventDefault()
        event.stopImmediatePropagation()
        keys.current.primary?.()
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [])

  const setField = (name: keyof SheetFields, value: string): void => {
    if (fields[name] === value) return
    setFields((current) => ({ ...current, [name]: value }))
    // Editing the field an error is about clears the error.
    const clears = name === 'hubURL' || (name === 'apiKey' && flow.isConnectingHub) || (name === 'domain' && flow.isEnteringDomain)
    if (clears && flow.errorMessage !== undefined) send(api.addAccountClearError())
  }

  const back = (): void => {
    setFields(emptySheetFields)
    send(api.addAccountBack())
  }
  const dismiss = (): void => close.current()

  const step: StepProps = { flow, fields, setField, cancel: back }
  let content: ReactNode
  if (flow.isConnectingHub) {
    content = <HubConnectStep {...step} />
  } else if (flow.provider !== undefined) {
    const provider = flow.provider
    const method = flow.method
    if (method === undefined) content = <MethodChoiceStep provider={provider} cancel={back} />
    else if (method.type === 'oauth' && flow.isEnteringDomain) content = <GitHubDomainStep {...step} provider={provider} />
    else if (method.type === 'oauth') content = <BrowserSignInStep {...step} provider={provider} cancel={flow.isSigningInAgain ? dismiss : back} />
    else if (method.type === 'apiKey') content = <APIKeyStep {...step} provider={provider} keyPage={method.keyPage} />
    else content = <OrganizationTokenStep {...step} provider={provider} />
  } else {
    content = <ProviderChoiceStep initialSelection={flow.selection} cancel={dismiss} />
  }

  return (
    <SheetKeysContext.Provider value={keys}>
      <div className="add-account-sheet">{content}</div>
    </SheetKeysContext.Provider>
  )
}

function ProviderChoiceStep(props: { initialSelection: AddAccountChoice | undefined; cancel: () => void }): ReactNode {
  const [selection, setSelection] = useState<AddAccountChoice | undefined>(props.initialSelection)
  return (
    <>
      <SheetHeader title="Add Account" message="Choose a provider to sign in to." />
      <ChoiceList
        items={AddAccountChoice.all}
        itemKey={choiceKey}
        selection={selection}
        select={setSelection}
        cancel={props.cancel}
        choose={(choice) => {
          setSelection(choice)
          if (choice.type === 'provider') send(api.addAccountChoose(choice.kind))
          else send(api.addAccountChooseHub())
        }}
        label={(choice) =>
          choice.type === 'provider' ? (
            <>
              <ProviderIcon id={choice.kind} side={20} inset={0.06} style={{ color: 'var(--choice-icon)' }} />
              <span>{ProviderKind.displayName(choice.kind)}</span>
            </>
          ) : (
            <>
              <ProviderIcon id={CLIProxyHub.markID} side={20} inset={0.06} style={{ color: 'var(--choice-icon)' }} />
              <span>CLIProxyAPI</span>
            </>
          )
        }
      />
      <CancelRow cancel={props.cancel} />
    </>
  )
}

function MethodChoiceStep(props: { provider: ProviderKind; cancel: () => void }): ReactNode {
  const [selection, setSelection] = useState<ProviderAuthMethod | undefined>(undefined)
  const name = ProviderKind.displayName(props.provider)
  return (
    <>
      <SheetHeader icon={props.provider} title={`Add ${name}`} message="Sign in to your own seat, or add your organization’s billing with a token." />
      <ChoiceList
        items={ProviderKind.authMethods(props.provider)}
        itemKey={(method) => method.type}
        selection={selection}
        select={setSelection}
        cancel={props.cancel}
        choose={(method) => {
          setSelection(method)
          send(api.addAccountChooseMethod(method))
        }}
        label={(method) => <span>{method.type === 'organizationToken' ? 'Organization Billing' : 'Sign In with GitHub'}</span>}
      />
      <CancelRow cancel={props.cancel} />
    </>
  )
}

/** A provider's or a sign-in method's list: an arrow key moves the selection, and a click or Return chooses. */
function ChoiceList<Item>(props: {
  items: readonly Item[]
  itemKey: (item: Item) => string
  selection: Item | undefined
  select: (item: Item) => void
  choose: (item: Item) => void
  cancel: () => void
  label: (item: Item) => ReactNode
}): ReactNode {
  const { items, itemKey, selection } = props
  const list = useRef<HTMLDivElement>(null)
  const [isFocused, setIsFocused] = useState(true)
  const selectedKey = selection !== undefined ? itemKey(selection) : undefined
  const selectedIndex = items.findIndex((item) => itemKey(item) === selectedKey)

  useEffect(() => {
    list.current?.focus({ preventScroll: true })
  }, [])
  useSheetKeys(props.cancel, selection !== undefined ? () => props.choose(selection) : undefined)

  const move = (by: number): void => {
    if (items.length === 0) return
    const next = selectedIndex < 0 ? (by > 0 ? 0 : items.length - 1) : Math.min(Math.max(selectedIndex + by, 0), items.length - 1)
    props.select(items[next])
  }

  return (
    <div
      ref={list}
      className={`choice-list${isFocused ? ' is-focused' : ''}`}
      role="listbox"
      tabIndex={0}
      aria-activedescendant={selectedKey !== undefined ? `choice-${selectedKey}` : undefined}
      style={{ height: items.length * 28 + 20 }}
      onFocus={() => setIsFocused(true)}
      onBlur={() => setIsFocused(false)}
      onKeyDown={(event) => {
        if (event.key === 'ArrowDown') move(1)
        else if (event.key === 'ArrowUp') move(-1)
        else if (event.key === 'Home') move(-items.length)
        else if (event.key === 'End') move(items.length)
        else return
        event.preventDefault()
      }}
    >
      {items.map((item) => {
        const key = itemKey(item)
        const isSelected = key === selectedKey
        return (
          <div
            key={key}
            id={`choice-${key}`}
            role="option"
            aria-selected={isSelected}
            className={`choice-row${isSelected ? ' is-selected' : ''}`}
            onClick={() => props.choose(item)}
          >
            {props.label(item)}
            <span style={{ flex: 1 }} />
            <Icon name="chevron.forward" size={10} weight="semibold" className="choice-chevron" />
          </div>
        )
      })}
    </div>
  )
}

function BrowserSignInStep({ flow, fields, setField, cancel, provider }: StepProps & { provider: ProviderKind }): ReactNode {
  const name = ProviderKind.displayName(provider)
  const prompt = flow.prompt
  const error = flow.errorMessage
  const enterpriseDomain = flow.gitHubDomain ? GitHubDomain.saved(flow.gitHubDomain) : undefined
  const whenSignedIn = 'Continue in your browser. This sheet closes when you’re signed in.'

  let message: string
  if (prompt?.type === 'deviceCode') {
    message =
      enterpriseDomain !== undefined
        ? `Open ${enterpriseDomain}/login/device in your browser and enter this code.`
        : 'Open the verification page in your browser and enter this code.'
  } else if (prompt?.type === 'browserToken') {
    message = 'Continue in your browser, then paste the token it shows here.'
  } else if (prompt?.type === 'browser') {
    message = whenSignedIn
  } else {
    message = enterpriseDomain !== undefined ? `Signing in at ${enterpriseDomain}.` : whenSignedIn
  }

  let pasteField: { name: string; footer?: string } | undefined
  if (prompt?.type === 'browser' && prompt.acceptsPastedCode) pasteField = { name: 'Code', footer: 'Paste the code here if your browser shows one.' }
  else if (prompt?.type === 'browserToken') pasteField = { name: 'Token' }

  const hasPastedCode = fields.pastedCode.trim().length > 0
  const canSubmitCode = hasPastedCode && flow.acceptsCode
  const submitCode = (): void => {
    if (canSubmitCode) send(api.addAccountSubmitCode(fields.pastedCode))
  }
  const copy = (text: string): void => send(api.copyText(text))

  let secondary: SheetAction
  if (error !== undefined && flow.canChangeDomain) secondary = { title: 'Change Domain', action: () => send(api.addAccountChangeDomain()) }
  else if (prompt?.type === 'deviceCode') secondary = { title: 'Copy Code', action: () => copy(prompt.userCode) }
  else if (prompt !== undefined) secondary = { title: 'Copy Link', action: () => copy(prompt.url) }
  else secondary = { title: 'Copy Link', isDisabled: true, action: () => undefined }

  let primary: SheetAction
  if (error !== undefined) {
    primary = {
      title: 'Try Again',
      action: () => {
        setField('pastedCode', '')
        send(api.addAccountSignIn())
      }
    }
  } else if (hasPastedCode) {
    primary = { title: 'Continue', isDisabled: !canSubmitCode, action: submitCode }
  } else {
    primary = { title: 'Open Browser', isDisabled: prompt === undefined, action: () => send(api.addAccountOpenBrowser()) }
  }

  const statusText = prompt === undefined ? 'Preparing sign-in…' : flow.isCodeSubmitted ? 'Signing in…' : 'Waiting for your browser…'

  return (
    <div style={{ position: 'relative' }}>
      <SheetHeader icon={provider} title={`Sign In to ${name}`} message={message} />
      {prompt?.type === 'deviceCode' ? <div className="device-code-box">{prompt.userCode}</div> : null}
      {error === undefined && pasteField !== undefined ? (
        <Form style={{ margin: '4px 20px' }}>
          <FormSection footer={pasteField.footer !== undefined ? <div className="sheet-footnote">{pasteField.footer}</div> : undefined}>
            <FormTextField
              label={pasteField.name}
              value={fields.pastedCode}
              onChange={(value) => setField('pastedCode', value)}
              prompt={`Paste ${pasteField.name.toLowerCase()}`}
              secure={prompt?.type === 'browserToken'}
              disabled={flow.isCodeSubmitted}
              onSubmit={submitCode}
            />
          </FormSection>
        </Form>
      ) : null}
      <SheetButtons cancel={cancel} secondary={secondary} primary={primary} />
      <div className="sign-in-status">
        {error !== undefined ? (
          <ErrorText message={error} alignment="center" />
        ) : (
          <>
            {flow.isWorking ? <Spinner size={14} /> : null}
            <span className="secondary">{statusText}</span>
          </>
        )}
      </div>
      <button type="button" className="plain-button sheet-close" aria-label="Cancel" onClick={cancel}>
        <svg width="20" height="20" viewBox="0 0 20 20" aria-hidden>
          <circle cx="10" cy="10" r="9" fill="currentColor" opacity="0.28" />
          <path d="M6.9 6.9l6.2 6.2M13.1 6.9l-6.2 6.2" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
        </svg>
      </button>
    </div>
  )
}

function APIKeyStep({ flow, fields, setField, cancel, provider, keyPage }: StepProps & { provider: ProviderKind; keyPage: string }): ReactNode {
  const name = ProviderKind.displayName(provider)
  const canAddKey = fields.apiKey.trim().length > 0 && !flow.isWorking
  const addKey = (): void => {
    if (canAddKey) send(api.addAccountAddKey(fields.apiKey, fields.accountName, fields.organization))
  }
  return (
    <>
      <SheetHeader
        icon={provider}
        title={`Add ${name}`}
        message={`Enter an API key from your ${name} account. It’s stored in Windows secure storage.`}
        link={<SheetLink title="Get Your API Key" destination={keyPage} />}
      />
      <Form style={{ margin: '4px 20px' }}>
        <FormSection footer={flow.errorMessage !== undefined ? <ErrorText message={flow.errorMessage} /> : undefined}>
          <FormTextField label="API Key" value={fields.apiKey} onChange={(value) => setField('apiKey', value)} prompt="Required" secure autoFocus onSubmit={addKey} />
          <FormTextField label="Name" value={fields.accountName} onChange={(value) => setField('accountName', value)} prompt={name} onSubmit={addKey} />
        </FormSection>
      </Form>
      <div style={{ paddingBottom: 20 }}>
        <SheetButtons cancel={cancel} secondary={{ title: 'Cancel', action: cancel }} primary={{ title: 'Add Account', isDisabled: !canAddKey, action: addKey }} />
      </div>
    </>
  )
}

/** Copilot's first sign-in step: blank signs in at github.com, or a company's GHE.com domain. */
function GitHubDomainStep({ flow, fields, setField, cancel, provider }: StepProps & { provider: ProviderKind }): ReactNode {
  const continueToSignIn = (): void => {
    setField('pastedCode', '')
    send(api.addAccountContinueToSignIn(fields.domain))
  }
  return (
    <>
      <SheetHeader
        icon={provider}
        title={`Sign In to ${ProviderKind.displayName(provider)}`}
        message="Leave the domain blank for GitHub.com, or enter your company’s GitHub Enterprise address."
      />
      <Form style={{ margin: '4px 20px' }}>
        <FormSection
          footer={
            <div className="sheet-footnote">
              {flow.errorMessage !== undefined ? <ErrorText message={flow.errorMessage} /> : 'Only needed for GitHub Enterprise on GHE.com.'}
            </div>
          }
        >
          <FormTextField label="Domain" value={fields.domain} onChange={(value) => setField('domain', value)} prompt="github.com" autoFocus onSubmit={continueToSignIn} />
        </FormSection>
      </Form>
      <div style={{ paddingBottom: 20 }}>
        <SheetButtons cancel={cancel} secondary={{ title: 'Cancel', action: cancel }} primary={{ title: 'Continue', action: continueToSignIn }} />
      </div>
    </>
  )
}

function OrganizationTokenStep({ flow, fields, setField, cancel, provider }: StepProps & { provider: ProviderKind }): ReactNode {
  const canAddKey = fields.apiKey.trim().length > 0 && !flow.isWorking && fields.organization.trim().length > 0
  const addKey = (): void => {
    if (canAddKey) send(api.addAccountAddKey(fields.apiKey, fields.accountName, fields.organization))
  }
  return (
    <>
      <SheetHeader
        icon={provider}
        title={`Add ${ProviderKind.displayName(provider)}`}
        message="Enter your organization and a token that can read its billing. It’s stored in Windows secure storage."
      />
      <Form style={{ margin: '4px 20px' }}>
        <FormSection
          footer={
            <div className="sheet-footnote sheet-footnote-stack">
              <span>
                Shows your organization’s Copilot credits and spend. Use a personal access token from an organization owner or billing manager: fine-grained,
                with Organization permissions → Administration → Read-only.
              </span>
              <SheetLink title="Create a Token" destination="https://github.com/settings/personal-access-tokens/new" />
              {flow.errorMessage !== undefined ? <ErrorText message={flow.errorMessage} /> : null}
            </div>
          }
        >
          <FormTextField
            label="Organization"
            value={fields.organization}
            onChange={(value) => setField('organization', value)}
            prompt="Required"
            autoFocus
            onSubmit={addKey}
          />
          <FormTextField label="Token" value={fields.apiKey} onChange={(value) => setField('apiKey', value)} prompt="Required" secure onSubmit={addKey} />
        </FormSection>
      </Form>
      <div style={{ paddingBottom: 20 }}>
        <SheetButtons cancel={cancel} secondary={{ title: 'Cancel', action: cancel }} primary={{ title: 'Add Account', isDisabled: !canAddKey, action: addKey }} />
      </div>
    </>
  )
}
