import type { AccountCredential } from '../../models/Account'
import type { HTTPResponse } from '../../services/HTTPClient'
import type { AccountProviderRuntime } from '../AccountProviderRuntime'
import { ProviderError } from '../ProviderError'
import type { ProviderUsage } from '../ProviderRuntime'
import { refreshHistory } from '../UsageLedger'
import { OllamaHistorySource } from './OllamaHistorySource'
import { OllamaUsageClient } from './OllamaUsageClient'
import { OllamaUsageMapper } from './OllamaUsageMapper'

export async function refreshOllama(rt: AccountProviderRuntime, credential: AccountCredential): Promise<ProviderUsage> {
  if (credential.type !== 'apiKey') throw ProviderError.invalidResponse
  const key = credential.key
  const client = new OllamaUsageClient(rt.http)
  const balance = await client.fetchBalance(key)
  ProviderError.requireSuccess(balance, 'ollama')
  if (rt.planBodyRead.isDue(rt.now())) {
    let account: HTTPResponse | undefined
    try {
      account = await client.fetchAccount(key)
    } catch {
      account = undefined
    }
    rt.planBodyRead.record(rt.successBody(account), rt.now())
  }
  const usage = OllamaUsageMapper.map(balance.body, rt.planBodyRead.value)
  const history = await refreshHistory(rt, new OllamaHistorySource(client, key, rt.cardID))
  if (history) usage.history = history
  return usage
}
