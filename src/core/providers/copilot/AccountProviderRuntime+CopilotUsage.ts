import type { AccountCredential } from '../../models/Account'
import type { AccountProviderRuntime } from '../AccountProviderRuntime'
import { ProviderError } from '../ProviderError'
import { ProviderUsage } from '../ProviderRuntime'
import { CopilotUsageClient } from './CopilotUsageClient'
import { CopilotUsageMapper } from './CopilotUsageMapper'
import { GitHubDomain } from './GitHubDomain'

export async function refreshCopilot(rt: AccountProviderRuntime, credential: AccountCredential): Promise<ProviderUsage> {
  const organization = rt.account.organization
  if (organization !== undefined) {
    if (credential.type !== 'apiKey') throw ProviderError.invalidResponse
    return ProviderUsage.make(undefined, await new CopilotUsageClient(rt.http).organizationUsage(organization, credential.key))
  }
  if (credential.type !== 'oauth') throw ProviderError.invalidResponse
  const response = await new CopilotUsageClient(rt.http).fetchUsage(credential.tokens.accessToken, GitHubDomain.fromSaved(rt.account.domain))
  ProviderError.requireSuccess(response, 'copilot')
  return CopilotUsageMapper.map(response)
}
