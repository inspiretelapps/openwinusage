import type { AccountCredential } from '../../models/Account'
import type { AccountProviderRuntime } from '../AccountProviderRuntime'
import { ProviderError } from '../ProviderError'
import type { ProviderUsage } from '../ProviderRuntime'
import { DevinUsageClient } from './DevinUsageClient'
import { DevinUsageMapper } from './DevinUsageMapper'

export async function refreshDevin(rt: AccountProviderRuntime, credential: AccountCredential): Promise<ProviderUsage> {
  if (credential.type !== 'oauth') throw ProviderError.invalidResponse
  const response = await new DevinUsageClient(rt.http).fetchUserStatus(credential.tokens)
  ProviderError.requireSuccess(response, 'devin')
  return DevinUsageMapper.map(response.body)
}
