import { MetricLine } from '../../models/MetricLine'
import { metricValue } from '../../models/MetricValue'
import { AppLog, LogTags } from '../../support/AppLog'
import { asArray, asObject, asString, ProviderParse } from '../../support/ProviderParse'
import type { Instant } from '../../support/time'
import { ClaudeUsageMapper } from './ClaudeUsageMapper'

export interface ClaudeResetGrantStatusGrant {
  id: string
  resetsLeft: number
  endsAt?: Instant
  clears: string[]
}

export interface ClaudeResetGrantStatus {
  eligible: boolean
  grants: ClaudeResetGrantStatusGrant[]
  nextGrantID?: string
}

export const ClaudeResetGrantStatus = {
  parse(value: unknown): ClaudeResetGrantStatus | undefined {
    const object = asObject(value)
    if (!object) return undefined
    const grants: ClaudeResetGrantStatusGrant[] = []
    for (const entry of asArray(object.grants) ?? []) {
      const grant = asObject(entry)
      const id = asString(grant?.id)
      const number = ProviderParse.number(grant?.resets_left)
      const left = number === undefined ? undefined : ProviderParse.int(Math.floor(number))
      if (!grant || id === undefined || id.length === 0 || left === undefined) {
        AppLog.warn(LogTags.plugin('claude'), 'reset grants block has a malformed grant; ignoring the block')
        return undefined
      }
      const clears = asArray(grant.clears)
      const parsed: ClaudeResetGrantStatusGrant = {
        id,
        resetsLeft: Math.max(0, left),
        clears: clears && clears.every((window): window is string => typeof window === 'string') ? clears : []
      }
      const endsAt = ClaudeUsageMapper.resetDate(grant.ends_at)
      if (endsAt !== undefined) parsed.endsAt = endsAt
      grants.push(parsed)
    }
    const status: ClaudeResetGrantStatus = { eligible: object.eligible === true, grants }
    const nextGrantID = asString(object.next_grant_id)
    if (nextGrantID !== undefined && nextGrantID.length > 0) status.nextGrantID = nextGrantID
    return status
  },

  claimableGrantID(status: ClaudeResetGrantStatus): string | undefined {
    const nextGrantID = status.nextGrantID
    if (!status.eligible || nextGrantID === undefined || !status.grants.some((grant) => grant.id === nextGrantID && grant.resetsLeft > 0)) {
      return undefined
    }
    return nextGrantID
  },

  confirmDetail(status: ClaudeResetGrantStatus): string | undefined {
    const id = ClaudeResetGrantStatus.claimableGrantID(status)
    const grant = id === undefined ? undefined : status.grants.find((candidate) => candidate.id === id)
    if (!grant) return undefined
    const names = grant.clears.flatMap((window): string[] => {
      switch (window) {
        case 'five_hour':
          return ['session']
        case 'seven_day':
          return ['weekly']
        default:
          return []
      }
    })
    if (names.length === 0) return undefined
    return `Refills your ${names.join(' and ')} limits now. This can't be undone.`
  },

  lineLabel: 'Rate Limit Resets',

  line(status: ClaudeResetGrantStatus, now: Instant): MetricLine {
    let count = 0
    const expiries: Instant[] = []
    if (status.eligible) {
      for (const grant of status.grants) {
        if (!(grant.resetsLeft >= 1)) continue
        if (grant.endsAt !== undefined && grant.endsAt <= now) continue
        count += grant.resetsLeft
        if (grant.endsAt !== undefined) for (let index = 0; index < grant.resetsLeft; index++) expiries.push(grant.endsAt)
      }
    }
    return MetricLine.values(
      ClaudeResetGrantStatus.lineLabel,
      [metricValue(count, 'count', 'available')],
      expiries.sort((a, b) => a - b)
    )
  }
}
