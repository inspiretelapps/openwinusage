import type { AccountCredential } from '../../models/Account'
import type { AccountProviderRuntime } from '../AccountProviderRuntime'
import { ProviderError } from '../ProviderError'
import { ProviderUsage } from '../ProviderRuntime'
import { OpenCodeUsageClient } from './OpenCodeUsageClient'
import { OpenCodeUsageMapper } from './OpenCodeUsageMapper'

export async function refreshOpenCode(rt: AccountProviderRuntime, credential: AccountCredential): Promise<ProviderUsage> {
  if (credential.type !== 'apiKey') throw ProviderError.invalidResponse
  const key = credential.key
  const response = await new OpenCodeUsageClient(rt.http).fetchUsage(key)
  if (response.statusCode === 403 && OpenCodeUsageMapper.errorType(response) === 'EntitlementError') {
    throw ProviderError.unavailable('No OpenCode Go subscription on this account.')
  }
  ProviderError.requireSuccess(response, 'opencode')
  return ProviderUsage.make(OpenCodeUsageMapper.plan, OpenCodeUsageMapper.meterLines(response))
}
