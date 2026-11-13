import { describe, it } from 'vitest'

/**
 * A Management key's card through the real runtime and store, with `/api/v1/activity` shaped as OpenRouter's
 * API reference documents it. Yesterday is 28 October 2026 UTC.
 *
 * Every case here drives `WidgetDataStore` (Stores), which is not ported yet. The `activity` fixture these
 * cases and `OpenRouterFixtures.managementAccount` share is ported, as `OpenRouterFixtures.activity`.
 */
describe('OpenRouterUsageHistoryTests', () => {
  it.todo('testAManagementKeyShowsReportedSpendAndTheActivityOfThePrior30Days')
  it.todo('testEachWindowRowHasABreakdownOfWhatOpenRouterReported')
  it.todo('testActivityIsReadAgainHourlyAndANewUTCDayAtOnce')
  it.todo('testAFailedActivityReadZeroesItsRangesKeepsTheCardAndWaitsAnHour')
})
