import { describe, expect, it } from 'vitest'
import { TransientNotice } from '@core/stores/TransientNotice'
import { PopoverState } from '../src/renderer/src/state/PopoverState'

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

describe('TransientNoticeTests', () => {
  it('testCopyingAgainRestartsTheConfirmation', async () => {
    const timeoutMs = 80
    const notice = new TransientNotice<boolean>(false, timeoutMs / 1000)
    notice.present(true)
    await sleep(40)

    const copiedAgain = performance.now()
    notice.present(true)
    expect(notice.value).toBe(true)
    expect(notice.trigger).toBe(2)

    // The confirmation clears after the second copy.
    const dismissedAfter = await new Promise<number>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('the confirmation never cleared')), 2000)
      const unsubscribe = notice.subscribe(() => {
        if (notice.value) return
        clearTimeout(timer)
        unsubscribe()
        resolve(performance.now() - copiedAgain)
      })
    })
    // Timers can fire up to a millisecond early against `performance.now()`.
    expect(dismissedAfter).toBeGreaterThanOrEqual(timeoutMs - 1)
    expect(notice.value).toBe(false)
  })

  it('testClosingDismissesTheConfirmationImmediately', () => {
    const popover = new PopoverState()
    popover.shareNotice.present(true)
    popover.reset()
    expect(popover.shareNotice.value).toBe(false)
  })
})
