import { ProviderError } from '../providers/ProviderError'
import type { HTTPClient, HTTPResponse } from '../services/HTTPClient'
import { AppLog } from '../support/AppLog'

export { MemoryCredentialVault as DemoCredentialVault } from '../services/AccountCredentialVault'
export { MemoryHubKeyVault as DemoHubKeyVault } from '../services/HubKeyVault'

/** A second boundary behind the disabled demo controls. This client never sends anything. */
export class DemoHTTPClient implements HTTPClient {
  async send(): Promise<HTTPResponse> {
    AppLog.error('http', 'Blocked a provider request while Sample Data is on')
    throw ProviderError.unavailable('Provider connections are unavailable while Sample Data is on.')
  }
}
