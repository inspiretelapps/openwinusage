const dayMs = 24 * 60 * 60 * 1000

export const MetricPeriod = {
  sessionMs: 5 * 60 * 60 * 1000,
  dayMs,
  weekMs: 7 * dayMs,
  monthMs: 30 * dayMs
}
