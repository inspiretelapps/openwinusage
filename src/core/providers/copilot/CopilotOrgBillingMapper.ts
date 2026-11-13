import { MetricLine } from '../../models/MetricLine'
import { metricValue } from '../../models/MetricValue'
import type { HTTPResponse } from '../../services/HTTPClient'
import { asArray, asString, isJSONObject, ProviderParse } from '../../support/ProviderParse'

/**
 * Organization-wide Copilot usage from GitHub's org billing: **Org Credits** counts the AI credits the
 * whole organization used this month (the endpoint reports no allotment, so no percentage), and
 * **Org Spend** is the dollars billed beyond the included pool.
 */
export const CopilotOrgBillingMapper = {
  /** `undefined` for a report that isn't GitHub's shape, so it never shows as zero usage. */
  usageLines(response: HTTPResponse): MetricLine[] | undefined {
    const items = asArray(ProviderParse.jsonObject(response.body)?.usageItems)
    if (!items || !items.every(isJSONObject)) return undefined
    let credits = 0.0
    let spend = 0.0
    for (const item of items) {
      if (asString(item.product) !== 'Copilot') continue
      const quantity = ProviderParse.number(item.grossQuantity)
      const amount = ProviderParse.number(item.netAmount)
      if (quantity === undefined || amount === undefined) return undefined
      credits += quantity
      spend += amount
    }
    return [
      MetricLine.values('Org Credits', [metricValue(credits, 'count', 'credits')]),
      MetricLine.values('Org Spend', [metricValue(spend, 'dollars')])
    ]
  }
}
