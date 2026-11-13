import type { ReactNode } from 'react'
import { CLIProxyHub } from '@core/models/CLIProxyHub'
import { api } from '../../bridge'
import { Form, FormSection, FormTextField } from '../../components/Form'
import { useStores } from '../../state/context'
import { ErrorText } from './ErrorText'
import { SheetButtons, SheetHeader, send, type StepProps } from './SheetParts'

/**
 * Connects a CLIProxyAPI hub by its address and management key. There is no login checklist: the hub
 * decides which logins exist, and each supported one appears as an account once the hub answers.
 */
export function HubConnectStep({ flow, fields, setField, cancel }: StepProps): ReactNode {
  const appName = useStores().state.app.name
  const canConnectHub = fields.hubURL.trim().length > 0 && fields.apiKey.trim().length > 0 && !flow.isWorking
  const connect = (): void => {
    if (canConnectHub) send(api.addAccountConnectHub(fields.hubURL, fields.apiKey))
  }
  return (
    <>
      <SheetHeader
        icon={CLIProxyHub.markID}
        title="Connect CLIProxyAPI"
        message="Enter your CLIProxyAPI server’s address and management key. Its Claude, ChatGPT, Antigravity, Devin, and Grok logins appear as accounts. The key is stored in Windows secure storage."
      />
      <Form disabled={flow.isWorking} style={{ margin: '4px 20px' }}>
        <FormSection
          footer={
            <div className="sheet-footnote">
              {flow.errorMessage !== undefined ? (
                <ErrorText message={flow.errorMessage} />
              ) : (
                `The hub needs remote management turned on. ${appName} uses https unless you type http://, which works only for this PC, your local network, or Tailscale.`
              )}
            </div>
          }
        >
          <FormTextField
            label="URL"
            value={fields.hubURL}
            onChange={(value) => setField('hubURL', value)}
            prompt="https://hub.example.com"
            autoFocus
            disabled={flow.isWorking}
            onSubmit={connect}
          />
          <FormTextField
            label="Management Key"
            value={fields.apiKey}
            onChange={(value) => setField('apiKey', value)}
            prompt="Required"
            secure
            disabled={flow.isWorking}
            onSubmit={connect}
          />
        </FormSection>
      </Form>
      <div style={{ paddingBottom: 20 }}>
        <SheetButtons
          cancel={cancel}
          secondary={{ title: 'Cancel', action: cancel }}
          primary={{ title: flow.isWorking ? 'Connecting…' : 'Connect', isDisabled: !canConnectHub, action: connect }}
        />
      </div>
    </>
  )
}
