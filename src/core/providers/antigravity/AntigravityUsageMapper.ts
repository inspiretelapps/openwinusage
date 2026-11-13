import { MetricLine } from '../../models/MetricLine'
import { AppLog, LogTags } from '../../support/AppLog'
import { MetricPeriod } from '../../support/MetricPeriod'
import { OpenUsageISO8601 } from '../../support/OpenUsageISO8601'
import { isJSONObject, nilIfEmpty, ProviderParse, titleCased } from '../../support/ProviderParse'
import type { Instant } from '../../support/time'
import { AntigravityMetric } from './AntigravityMetric'

interface QuotaSummaryGroup {
  displayName?: string
  buckets?: QuotaSummaryBucket[]
}

interface QuotaSummaryBucket {
  bucketId?: string
  remainingFraction?: number
  resetTime?: string
  window?: string
  disabled?: boolean
  hasInvalidDisabledFlag: boolean
}

interface CCLoadTier {
  id?: string
  name?: string
}

interface CCLoadEnvelope {
  cloudaicompanionProject?: string
  currentTier?: CCLoadTier
  paidTier?: CCLoadTier
}

/** Thrown where the Swift `Decodable` would throw: the field is there and has the wrong type. */
class DecodingError extends Error {}

const absent = (value: unknown): boolean => value === undefined || value === null

/** `try decodeIfPresent(String.self, ...)`: a missing or null field is undefined, any other type throws. */
function decodeString(value: unknown): string | undefined {
  if (absent(value)) return undefined
  if (typeof value !== 'string') throw new DecodingError()
  return value
}

/** `(try? decodeIfPresent(String.self, ...)) ?? nil`: a field of another type reads as missing. */
function lenientString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

/** `init(from:)` of a bucket never throws: every field it can't read is undefined, and only a malformed `disabled` is noted. */
function decodeBucket(value: unknown): QuotaSummaryBucket {
  const bucket: QuotaSummaryBucket = { hasInvalidDisabledFlag: false }
  if (!isJSONObject(value)) return bucket
  const bucketId = lenientString(value.bucketId)
  if (bucketId !== undefined) bucket.bucketId = bucketId
  if (typeof value.remainingFraction === 'number') bucket.remainingFraction = value.remainingFraction
  const resetTime = lenientString(value.resetTime)
  if (resetTime !== undefined) bucket.resetTime = resetTime
  const window = lenientString(value.window)
  if (window !== undefined) bucket.window = window
  if (typeof value.disabled === 'boolean') bucket.disabled = value.disabled
  else if (!absent(value.disabled)) bucket.hasInvalidDisabledFlag = true
  return bucket
}

function decodeGroup(value: unknown): QuotaSummaryGroup {
  if (!isJSONObject(value)) throw new DecodingError()
  const group: QuotaSummaryGroup = {}
  const displayName = lenientString(value.displayName)
  if (displayName !== undefined) group.displayName = displayName
  if (!absent(value.buckets)) {
    if (!Array.isArray(value.buckets)) throw new DecodingError()
    group.buckets = value.buckets.map(decodeBucket)
  }
  return group
}

function decodeGroups(value: unknown): QuotaSummaryGroup[] | undefined {
  if (absent(value)) return undefined
  if (!Array.isArray(value)) throw new DecodingError()
  return value.map(decodeGroup)
}

function summaryGroups(data: Uint8Array | string): QuotaSummaryGroup[] | undefined {
  try {
    const envelope = ProviderParse.json(data)
    if (!isJSONObject(envelope)) return undefined
    let response: QuotaSummaryGroup[] | undefined
    if (!absent(envelope.response)) {
      if (!isJSONObject(envelope.response)) throw new DecodingError()
      response = decodeGroups(envelope.response.groups)
    }
    const groups = decodeGroups(envelope.groups)
    return response ?? groups
  } catch {
    return undefined
  }
}

function decodeTier(value: unknown): CCLoadTier | undefined {
  if (absent(value)) return undefined
  if (!isJSONObject(value)) throw new DecodingError()
  const tier: CCLoadTier = {}
  const id = decodeString(value.id)
  if (id !== undefined) tier.id = id
  const name = decodeString(value.name)
  if (name !== undefined) tier.name = name
  return tier
}

function decodeLoadEnvelope(data: Uint8Array | string): CCLoadEnvelope | undefined {
  try {
    const object = ProviderParse.json(data)
    if (!isJSONObject(object)) return undefined
    const envelope: CCLoadEnvelope = {}
    const project = decodeString(object.cloudaicompanionProject)
    if (project !== undefined) envelope.cloudaicompanionProject = project
    const currentTier = decodeTier(object.currentTier)
    if (currentTier) envelope.currentTier = currentTier
    const paidTier = decodeTier(object.paidTier)
    if (paidTier) envelope.paidTier = paidTier
    return envelope
  } catch {
    return undefined
  }
}

const argonGroupName = 'Gemini 4 Argon'

const isWhitespace = (char: string): boolean => /\s/u.test(char)

const summaryBuckets: { bucketID: string; label: string; periodMs: number }[] = [
  { bucketID: 'gemini-5h', label: AntigravityMetric.sessionLabel, periodMs: MetricPeriod.sessionMs },
  { bucketID: 'gemini-weekly', label: AntigravityMetric.weeklyLabel, periodMs: MetricPeriod.weekMs },
  { bucketID: '3p-5h', label: AntigravityMetric.claudeLabel, periodMs: MetricPeriod.sessionMs },
  { bucketID: '3p-weekly', label: AntigravityMetric.claudeWeeklyLabel, periodMs: MetricPeriod.weekMs }
]

const paidTierPlans = new Map<string, string>([
  ['g1-pro-tier', 'Google AI Pro'],
  ['g1-ultra-tier', 'Google AI Ultra'],
  ['g1-ultra-lite-tier', 'Google AI Ultra Lite']
])

function argonWeeklyLine(groups: QuotaSummaryGroup[]): MetricLine | undefined {
  const argonGroups = groups.filter((group) => group.displayName === argonGroupName)
  if (argonGroups.length === 0) return undefined
  const buckets = argonGroups.flatMap((group) => group.buckets ?? [])
  for (const bucket of buckets) {
    if (bucket.window === 'weekly') continue
    AppLog.warn(LogTags.plugin('antigravity'), `Argon quota has unsupported window '${bucket.window ?? '<absent>'}'; skipping its bucket`)
  }
  const weekly = buckets.filter((bucket) => bucket.window === 'weekly')
  const bucket = weekly[0]
  const id = nilIfEmpty(bucket?.bucketId)
  if (weekly.length !== 1 || bucket === undefined || id === undefined || summaryBuckets.some((spec) => spec.bucketID === id)) {
    AppLog.warn(LogTags.plugin('antigravity'), 'Argon quota group has no unambiguous separate weekly bucket; dropping its line')
    return undefined
  }
  if (bucket.hasInvalidDisabledFlag) {
    AppLog.warn(LogTags.plugin('antigravity'), 'Argon weekly quota has an unusable disabled flag; dropping its line')
    return undefined
  }
  if (bucket.disabled === true) return undefined
  const fraction = bucket.remainingFraction
  if (fraction === undefined || !Number.isFinite(fraction)) {
    AppLog.warn(LogTags.plugin('antigravity'), 'Argon weekly quota has no usable remainingFraction; dropping its line')
    return undefined
  }
  return AntigravityUsageMapper.line(
    AntigravityMetric.argonWeeklyLabel,
    fraction,
    bucket.resetTime === undefined ? undefined : OpenUsageISO8601.date(bucket.resetTime),
    MetricPeriod.weekMs
  )
}

export const AntigravityUsageMapper = {
  summaryBuckets,

  parseQuotaSummaries(bodies: (Uint8Array | string)[]): MetricLine[] | undefined {
    const groupLists: QuotaSummaryGroup[][] = []
    for (const data of bodies) {
      const groups = summaryGroups(data)
      if (!groups) {
        AppLog.warn(LogTags.plugin('antigravity'), 'quota summary response has no decodable groups; treating as not-a-summary')
        continue
      }
      groupLists.push(groups)
    }
    if (groupLists.length === 0) return undefined

    const pooled = new Map<string, { fraction: number; resetTime?: Instant }>()
    const sharedBuckets = groupLists
      .flat()
      .filter((group) => group.displayName !== argonGroupName)
      .flatMap((group) => group.buckets ?? [])
    for (const bucket of sharedBuckets) {
      const id = bucket.bucketId
      if (id === undefined || !summaryBuckets.some((spec) => spec.bucketID === id)) {
        AppLog.warn(LogTags.plugin('antigravity'), `quota summary: skipping unrecognized bucket id '${bucket.bucketId ?? '<absent>'}'`)
        continue
      }
      if (pooled.has(id)) continue
      const fraction = bucket.remainingFraction
      if (fraction === undefined || !Number.isFinite(fraction)) {
        AppLog.warn(LogTags.plugin('antigravity'), `quota summary: bucket '${id}' has no usable remainingFraction; dropping its line`)
        continue
      }
      const entry: { fraction: number; resetTime?: Instant } = { fraction }
      const resetTime = bucket.resetTime === undefined ? undefined : OpenUsageISO8601.date(bucket.resetTime)
      if (resetTime !== undefined) entry.resetTime = resetTime
      pooled.set(id, entry)
    }

    const lines: MetricLine[] = []
    for (const spec of summaryBuckets) {
      const entry = pooled.get(spec.bucketID)
      if (!entry) continue
      lines.push(AntigravityUsageMapper.line(spec.label, entry.fraction, entry.resetTime, spec.periodMs))
    }
    let argon: MetricLine | undefined
    for (const groups of groupLists) {
      argon = argonWeeklyLine(groups)
      if (argon) break
    }
    if (argon) {
      const found = lines.findIndex((line) => line.label === AntigravityMetric.claudeLabel || line.label === AntigravityMetric.claudeWeeklyLabel)
      const index = found < 0 ? lines.length : found
      lines.splice(index, 0, argon)
    }
    return lines
  },

  isCompleteSummary(data: Uint8Array | string): boolean {
    const groups = summaryGroups(data)
    if (!groups) return false
    const shared = groups.filter((group) => group.displayName !== argonGroupName)
    const usable = new Set<string>()
    for (const bucket of shared.flatMap((group) => group.buckets ?? [])) {
      if (bucket.remainingFraction !== undefined && Number.isFinite(bucket.remainingFraction) && bucket.bucketId !== undefined) {
        usable.add(bucket.bucketId)
      }
    }
    return summaryBuckets.every((spec) => usable.has(spec.bucketID))
  },

  paidTierPlans,

  parseLoadCodeAssistPlan(data: Uint8Array | string): string | undefined {
    const envelope = decodeLoadEnvelope(data)
    if (!envelope) return undefined
    const id = envelope.paidTier?.id
    const plan = id === undefined ? undefined : paidTierPlans.get(id)
    if (plan !== undefined) return plan
    return AntigravityUsageMapper.formatPlan(envelope.paidTier?.name ?? envelope.currentTier?.name)
  },

  parseProject(data: Uint8Array | string): string | undefined {
    return nilIfEmpty(decodeLoadEnvelope(data)?.cloudaicompanionProject)
  },

  line(pool: string, fraction: number, resetTime: Instant | undefined, periodMs: number): MetricLine {
    const clamped = Math.max(0, Math.min(1, fraction))
    const used = (1 - clamped) * 100
    return MetricLine.percent(pool, used, resetTime, periodMs)
  },

  formatPlan(raw: string | undefined): string | undefined {
    const trimmed = nilIfEmpty(raw?.trim())
    if (trimmed === undefined) return undefined
    for (const tier of ['Ultra Lite', 'Ultra', 'Pro']) {
      if (trimmed.toLowerCase().includes(tier.toLowerCase())) return `Google AI ${tier}`
    }
    return titleCased(trimmed, isWhitespace)
  }
}
