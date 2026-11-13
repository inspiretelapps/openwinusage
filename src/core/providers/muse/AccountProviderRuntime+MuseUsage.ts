import type { AccountCredential } from '../../models/Account'
import type { AccountProviderRuntime } from '../AccountProviderRuntime'
import { ProviderError } from '../ProviderError'
import type { ProviderUsage } from '../ProviderRuntime'
import { MuseUsageClient } from './MuseUsageClient'
import { MuseUsageMapper } from './MuseUsageMapper'

export async function refreshMuse(rt: AccountProviderRuntime, credential: AccountCredential): Promise<ProviderUsage> {
  if (credential.type !== 'oauth') throw ProviderError.invalidResponse
  const account = await new MuseUsageClient(rt.http).account(credential.tokens.accessToken)
  const usage = MuseUsageMapper.map(account, rt.museLastKnown, rt.now())
  rt.museLastKnown = usage.lines
  return usage
}
