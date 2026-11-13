import type { AccountCredential } from '../../models/Account'
import { UsageHistory } from '../../models/UsageHistory'
import type { AccountProviderRuntime } from '../AccountProviderRuntime'
import { ProviderError } from '../ProviderError'
import { ProviderUsage } from '../ProviderRuntime'
import { refreshHistory } from '../UsageLedger'
import { OpenRouterActivitySource } from './OpenRouterActivitySource'
import { OpenRouterUsageClient } from './OpenRouterUsageClient'
import { OpenRouterUsageMapper } from './OpenRouterUsageMapper'

export async function refreshOpenRouter(rt: AccountProviderRuntime, credential: AccountCredential): Promise<ProviderUsage> {
  if (credential.type !== 'apiKey') throw ProviderError.invalidResponse
  const apiKey = credential.key
  const client = new OpenRouterUsageClient(rt.http)
  const key = await client.key(apiKey, rt.now())
  switch (key.kind.type) {
    case 'standard': {
      const history = UsageHistory.make(OpenRouterUsageMapper.utc, rt.now())
      history.reported = key.kind.spend
      const usage = ProviderUsage.make(key.plan, key.lines)
      usage.history = history
      return usage
    }
    case 'management': {
      const credits = await client.creditsLines(apiKey)
      const spend = await client.listedKeysSpend(apiKey)
      const source = new OpenRouterActivitySource(client, apiKey, rt.cardID)
      const history = (await refreshHistory(rt, source)) ?? UsageHistory.make(OpenRouterUsageMapper.utc, rt.now())
      history.reported = spend
      const usage = ProviderUsage.make(key.plan, [...credits, ...key.lines])
      usage.history = history
      return usage
    }
  }
}
