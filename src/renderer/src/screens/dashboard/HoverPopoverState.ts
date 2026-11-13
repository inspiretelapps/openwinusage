import { Observable } from '@core/support/Observable'

/**
 * When a hover detail shows: 0.4s after the pointer rests on its figure, until 0.18s after the pointer
 * has left both the figure and the detail. A click (or Space on the focused figure) opens it at once
 * and keeps it open until it is dismissed.
 */
export class HoverPopoverState extends Observable {
  isPresented = false
  overInline = false
  openedExplicitly = false

  /** Every live coordinator, so closing the panel can dismiss any open detail. */
  private static readonly live = new Set<HoverPopoverState>()

  static dismissAll(): void {
    for (const state of HoverPopoverState.live) state.dismiss()
  }

  private overDetail = false
  private pinned = false
  private showTask: ReturnType<typeof setTimeout> | undefined
  private hideTask: ReturnType<typeof setTimeout> | undefined

  constructor(
    private readonly revealDelayMs = 400,
    private readonly hideGraceMs = 180
  ) {
    super()
  }

  /** The owning view calls these as it mounts and unmounts. */
  attach(): void {
    HoverPopoverState.live.add(this)
  }

  detach(): void {
    HoverPopoverState.live.delete(this)
    this.dismiss()
  }

  inlineHover(active: boolean): void {
    if (this.overInline !== active) {
      this.overInline = active
      this.notify()
    }
    if (active) this.scheduleShow()
    else this.scheduleHide()
  }

  detailHover(inside: boolean): void {
    this.overDetail = inside
    if (inside) this.cancelHide()
    else this.scheduleHide()
  }

  /** While pinned (a reset is being confirmed or spent) the detail stays whatever the pointer does. */
  setPinned(active: boolean): void {
    if (this.pinned === active) return
    this.pinned = active
    if (active) this.cancelHide()
    else this.scheduleHide()
  }

  /** An explicit activation stays open until dismissed, even if the pointer is elsewhere. */
  openDetails(): void {
    this.cancelHide()
    this.openedExplicitly = true
    this.isPresented = true
    this.notify()
  }

  dismiss(): void {
    this.cancelShow()
    this.cancelHide()
    const changed = this.isPresented || this.overInline || this.openedExplicitly
    this.overInline = false
    this.overDetail = false
    this.openedExplicitly = false
    this.pinned = false
    this.isPresented = false
    if (changed) this.notify()
  }

  private cancelShow(): void {
    if (this.showTask !== undefined) clearTimeout(this.showTask)
    this.showTask = undefined
  }

  private cancelHide(): void {
    if (this.hideTask !== undefined) clearTimeout(this.hideTask)
    this.hideTask = undefined
  }

  private scheduleShow(): void {
    this.cancelHide()
    if (this.isPresented || this.showTask !== undefined) return
    this.showTask = setTimeout(() => {
      this.showTask = undefined
      if (!this.overInline) return
      this.isPresented = true
      this.notify()
    }, this.revealDelayMs)
  }

  private scheduleHide(): void {
    if (this.pinned || this.openedExplicitly) return
    this.cancelShow()
    this.cancelHide()
    this.hideTask = setTimeout(() => {
      this.hideTask = undefined
      if (this.overInline || this.overDetail || this.pinned) return
      this.isPresented = false
      this.notify()
    }, this.hideGraceMs)
  }
}
