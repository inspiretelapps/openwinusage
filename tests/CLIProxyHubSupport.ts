import type { HubLogin } from '@core/models/CLIProxyHub'
import { MemoryHubKeyVault } from '@core/services/HubKeyVault'

export { MemoryHubKeyVault as InMemoryHubKeyVault }

/** `HubLogin(id:authIndex:provider:label:isOAuth:isDisabled:chatGPTAccountID:)` */
export function hubLogin(fields: {
  id: string
  authIndex?: string
  provider: string
  label: string
  isOAuth?: boolean
  isDisabled?: boolean
  chatGPTAccountID?: string
}): HubLogin {
  const login: { -readonly [Key in keyof HubLogin]: HubLogin[Key] } = {
    id: fields.id,
    provider: fields.provider,
    label: fields.label,
    isOAuth: fields.isOAuth ?? true,
    isDisabled: fields.isDisabled ?? false
  }
  if (fields.authIndex !== undefined) login.authIndex = fields.authIndex
  if (fields.chatGPTAccountID !== undefined) login.chatGPTAccountID = fields.chatGPTAccountID
  return login
}

/**
 * `GET /v0/management/auth-files` as CLIProxyAPI v8.0.47 (90c447d) answered it, with dummy logins and
 * the per-entry counters, timestamps, and file paths left out.
 */
export const recordedListing = `
{"files":[
{"account":"alice@example.com","account_type":"oauth","auth_index":"b799da203df01af5","disabled":false,"email":"alice@example.com","id":"claude-alice@example.com.json","label":"alice@example.com","name":"claude-alice@example.com.json","provider":"claude","status":"active","status_message":"","type":"claude","unavailable":false},
{"account_type":"oauth","auth_index":"b9e9b8780e7ae25b","disabled":false,"id":"claude-apikey-file.json","label":"claude","name":"claude-apikey-file.json","provider":"claude","status":"active","status_message":"","type":"claude","unavailable":false},
{"account":"disabled@example.com","account_type":"oauth","auth_index":"c62b935696257364","disabled":true,"email":"disabled@example.com","id":"claude-disabled@example.com.json","label":"disabled@example.com","name":"claude-disabled@example.com.json","provider":"claude","status":"disabled","status_message":"","type":"claude","unavailable":false},
{"account":"notoken@example.com","account_type":"oauth","auth_index":"4af9debc50b6ca56","disabled":false,"email":"notoken@example.com","id":"claude-notoken@example.com.json","label":"notoken@example.com","name":"claude-notoken@example.com.json","provider":"claude","status":"active","status_message":"","type":"claude","unavailable":false},
{"account":"codex-user@example.com","account_type":"oauth","auth_index":"2eff6fcd14d4e964","disabled":false,"email":"codex-user@example.com","id":"codex-codex-user@example.com-plus.json","id_token":{"chatgpt_account_id":"acct-dummy-0001","plan_type":"plus"},"label":"codex-user@example.com","name":"codex-codex-user@example.com-plus.json","provider":"codex","status":"active","status_message":"","type":"codex","unavailable":false},
{"account":"kim@example.com","account_type":"oauth","auth_index":"e1c935aa6b063328","disabled":false,"email":"kim@example.com","id":"kimi-kim@example.com.json","label":"kim@example.com","name":"kimi-kim@example.com.json","provider":"kimi","status":"active","status_message":"","type":"kimi","unavailable":false}
]}
`
