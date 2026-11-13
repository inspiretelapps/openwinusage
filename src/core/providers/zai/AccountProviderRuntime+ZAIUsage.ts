import type { AccountCredential } from '../../models/Account'
import type { HTTPResponse } from '../../services/HTTPClient'
import type { AccountProviderRuntime } from '../AccountProviderRuntime'
import { ProviderError } from '../ProviderError'
import type { ProviderUsage } from '../ProviderRuntime'
import { zaiResets } from './AccountProviderRuntime+ZAIResets'
import { ZAIResetsMapper } from './ZAIResets'
import { ZAIUsageClient } from './ZAIUsageClient'
import { ZAIUsageMapper } from './ZAIUsageMapper'

export async function refreshZAI(rt: AccountProviderRuntime, credential: AccountCredential): Promise<ProviderUsage> {
  if (credential.type !== 'apiKey') throw ProviderError.invalidResponse
  const key = credential.key
  const client = new ZAIUsageClient(rt.http)
  const quota = await client.fetchQuota(key)
  ProviderError.requireSuccess(quota, 'zai')
  if (rt.planBodyRead.isDue(rt.now())) {
    let subscription: HTTPResponse | undefined
    try {
      subscription = await client.fetchSubscription(key)
    } catch {
      subscription = undefined
    }
    rt.planBodyRead.record(rt.successBody(subscription), rt.now())
  }
  const usage = ZAIUsageMapper.map(quota.body, rt.planBodyRead.value)
  const resets = await zaiResets(rt, key)
  if (resets) {
    usage.lines.push(ZAIResetsMapper.line(resets))
  }
  return usage
}
