import { HTTPResponse, type HTTPRequest } from '@core/services/HTTPClient'
import { addSeconds, type Instant } from '@core/support/time'
import { iso } from './TestSupport'

/** `OpenRouterUsageHistoryTests.now`: yesterday is 28 October 2026 UTC. */
const historyNow: Instant = iso('2026-10-29T11:00:00Z')
const quietDay = '2026-10-20'

function activityRows(date: string): string[] {
  if (date === quietDay) return []
  return [
    `{"date":"${date}","model":"anthropic/claude-sonnet-4.5","model_permaslug":"anthropic/claude-sonnet-4.5","endpoint_id":"e1","provider_name":"Anthropic","usage":1.25,"byok_usage_inference":0.5,"requests":10,"prompt_tokens":1000,"completion_tokens":200,"reasoning_tokens":50,"cached_tokens":600}`,
    `{"date":"${date}","model":"openai/gpt-5","model_permaslug":"openai/gpt-5","endpoint_id":"e2","provider_name":"OpenAI","usage":0.25,"byok_usage_inference":0,"requests":2,"prompt_tokens":3000,"completion_tokens":100,"reasoning_tokens":0,"cached_tokens":0}`
  ]
}

function path(request: HTTPRequest): string {
  return new URL(request.url).pathname
}

/**
 * `/api/v1/key`, `/api/v1/credits`, and `/api/v1/keys` shaped as OpenRouter's API reference documents them.
 * Upstream declares this in `OpenRouterProviderTests.swift`; it lives in its own file here so other
 * test files can share it without importing a test file.
 */
export const OpenRouterFixtures = {
  managementKey: `
    {"data":{"label":"sk-or-v1-0e6...1c96","limit":null,"limit_remaining":null,"limit_reset":null,
    "include_byok_in_limit":false,"usage":0,"usage_daily":0,"usage_weekly":0,"usage_monthly":0,
    "byok_usage":0,"byok_usage_daily":0,"byok_usage_weekly":0,"byok_usage_monthly":0,
    "is_free_tier":false,"is_management_key":true,"is_provisioning_key":true}}
    `,
  standardKey: `
    {"data":{"label":"sk-or-v1-au7...890","limit":100,"limit_remaining":74.5,"limit_reset":"monthly",
    "include_byok_in_limit":false,"usage":25.5,"usage_daily":1.5,"usage_weekly":4,"usage_monthly":12,
    "byok_usage":17.38,"byok_usage_daily":17.38,"byok_usage_weekly":17.38,"byok_usage_monthly":17.38,
    "is_free_tier":false,"is_management_key":false,"is_provisioning_key":false,
    "effective_budget":{"scope":"member","guardrail_id":"0df9e665-d932-5740-b2c7-b52af166bc11","budget_id":null,"limit_usd":50,
    "spend_usd":32.5,"remaining_usd":17.5,"reset_interval":"weekly","resets_at":"2026-11-02T00:00:00.000Z","include_byok":false},
    "free_model_daily_requests":{"used":12,"limit":50,"remaining":38}}}
    `,
  credits: '{"data":{"total_credits":100,"total_usage":22.25}}',
  forbidden: '{"error":{"code":403,"message":"Forbidden"}}',

  keysPage(count: number, daily: number, weekly: number, monthly: number): string {
    const key = `
        {"hash":"f01d52606dc8f0a8303a7b5cc3fa07109c2e346cec7c0a16b40de462992ce943","name":"Agent",
        "label":"sk-or-v1-0e6...1c96","disabled":false,"limit":null,"limit_remaining":null,"limit_reset":null,
        "include_byok_in_limit":false,"usage":${monthly},"usage_daily":${daily},"usage_weekly":${weekly},
        "usage_monthly":${monthly},"byok_usage":0,"byok_usage_daily":0,"byok_usage_weekly":0,"byok_usage_monthly":0,
        "created_at":"2025-08-24T10:30:00Z","updated_at":"2025-08-24T15:45:00Z","expires_at":null}
        `
    return '{"data":[' + Array.from({ length: count }, () => key).join(',') + ']}'
  },

  managementAccount(request: HTTPRequest): HTTPResponse {
    switch (path(request)) {
      case '/api/v1/key':
        return OpenRouterFixtures.response(200, OpenRouterFixtures.managementKey)
      case '/api/v1/credits':
        return OpenRouterFixtures.response(200, OpenRouterFixtures.credits)
      case '/api/v1/keys':
        if (OpenRouterFixtures.offset(request) === '0') return OpenRouterFixtures.response(200, OpenRouterFixtures.keysPage(100, 0.25, 0.5, 1))
        if (OpenRouterFixtures.offset(request) === '100') return OpenRouterFixtures.response(200, OpenRouterFixtures.keysPage(1, 1.5, 4, 12))
        return OpenRouterFixtures.response(404)
      case '/api/v1/activity':
        return OpenRouterFixtures.activity(request)
      default:
        return OpenRouterFixtures.response(404)
    }
  },

  offset(request: HTTPRequest): string | undefined {
    return new URL(request.url).searchParams.get('offset') ?? undefined
  },

  response(status: number, body = ''): HTTPResponse {
    return new HTTPResponse(status, {}, body)
  },

  /** `OpenRouterUsageHistoryTests.now` */
  historyNow,

  /** `OpenRouterUsageHistoryTests.activity`: the last 30 finished UTC days, or the one `date` asks for. */
  activity(request: HTTPRequest): HTTPResponse {
    const date = new URL(request.url).searchParams.get('date')
    const dates =
      date !== null
        ? [date]
        : Array.from({ length: 30 }, (_, index) => new Date(addSeconds(historyNow, -(index + 1) * 86_400)).toISOString().slice(0, 10))
    return OpenRouterFixtures.response(200, '{"data":[' + dates.flatMap(activityRows).join(',') + ']}')
  }
}
