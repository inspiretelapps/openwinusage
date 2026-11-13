import type { AccountCredential } from '../../models/Account'
import { GrokLogin } from '../../services/DeviceProviderLogins'
import type { HTTPResponse } from '../../services/HTTPClient'
import type { AccountProviderRuntime } from '../AccountProviderRuntime'
import { ProviderUsage } from '../ProviderRuntime'
import { GrokUsageClient } from './GrokUsageClient'
import { GrokUsageMapper } from './GrokUsageMapper'

export async function refreshGrok(rt: AccountProviderRuntime, credential: AccountCredential): Promise<ProviderUsage> {
  const client = new GrokUsageClient(rt.http)
  const { tokens, response: usage } = await rt.authorizedRead(
    credential,
    (refreshToken, http, now) => GrokLogin.refresh(refreshToken, http, now),
    (tokens) => client.fetchCreditsConfig(tokens.accessToken)
  )
  const mapped = GrokUsageMapper.mapCreditsConfig(usage)
  if (rt.planRead.isDue(rt.now())) {
    let settings: HTTPResponse | undefined
    try {
      settings = await client.fetchSettings(tokens.accessToken)
    } catch {
      settings = undefined
    }
    rt.planRead.record(settings === undefined ? undefined : GrokUsageMapper.planName(settings), rt.now())
  }
  return ProviderUsage.make(rt.planRead.value, mapped.lines, mapped.notice)
}
