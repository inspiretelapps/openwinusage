import type { WidgetData } from '../models/WidgetData'
import type { WidgetDescriptor } from '../models/WidgetDescriptor'
import { AppLog } from '../support/AppLog'
import { NotificationState, PaceMilestone, PaceNotificationLogic } from '../support/PaceNotificationLogic'
import type { Instant } from '../support/time'

/** Posts one notification: `(idPrefix, title, subtitle, body)`, answering whether it was delivered. */
export type NotificationPoster = (idPrefix: string, title: string, subtitle: string, body: string) => Promise<boolean>

/** Decides, after each refresh pass, which limit notifications to post. Each fires once per metric per reset window. */
export class QuotaNotificationEvaluator {
  private notificationState = new Map<string, NotificationState>()

  constructor(private readonly post: NotificationPoster) {}

  async evaluate(
    descriptors: WidgetDescriptor[],
    data: (descriptor: WidgetDescriptor) => WidgetData,
    isOn: (milestone: PaceMilestone) => boolean,
    now: Instant,
    providerName: (providerID: string) => string
  ): Promise<void> {
    const metrics = descriptors.map((descriptor) => ({ descriptor, data: data(descriptor) })).filter((metric) => metric.data.isBounded)
    const nextState = new Map<string, NotificationState>()
    for (const { descriptor, data: reading } of metrics) {
      const key = descriptor.id
      const state = reading.meterState(now)
      const previous = this.notificationState.get(key) ?? NotificationState.initial()
      const result = PaceNotificationLogic.transitions({
        state,
        severity: reading.severity,
        resetsAt: reading.resetsAt,
        unusedNearReset: PaceNotificationLogic.isUnusedNearReset(reading, now),
        previous
      })
      const next = result.newState
      let paceDelivered = false
      let levelDelivered = false
      for (const milestone of result.fire) {
        // A drop past both levels sends the lowest one that's switched on, not both.
        if (levelDelivered && PaceMilestone.isLevel(milestone)) {
          next.firedMilestones.add(milestone)
          continue
        }
        const delivered = isOn(milestone) ? await this.deliver(milestone, reading, descriptor.providerID, providerName) : false
        if (delivered) {
          if (PaceMilestone.isPace(milestone)) paceDelivered = true
          if (PaceMilestone.isLevel(milestone)) levelDelivered = true
          next.firedMilestones.add(milestone)
        }
      }
      const held = PaceNotificationLogic.carriedOver(previous, reading.resetsAt)
      if (result.fire.some(PaceMilestone.isPace) && !paceDelivered) next.previousBucket = held.previousBucket
      if (result.fire.some(PaceMilestone.isLevel) && !levelDelivered) next.previousSeverity = held.previousSeverity
      if (result.fire.length > 0) {
        AppLog.debug(
          'notifications',
          `${key}: ${previous.previousBucket} -> ${next.previousBucket}, fired ${result.fire.join(',')}, delivered pace=${paceDelivered} level=${levelDelivered}`
        )
      }
      nextState.set(key, next)
    }
    this.notificationState = nextState
  }

  private deliver(milestone: PaceMilestone, data: WidgetData, providerID: string, providerName: (providerID: string) => string): Promise<boolean> {
    const subtitle = `${providerName(providerID)} ${data.title}`
    return this.post(`${providerID}.${milestone}`, PaceMilestone.notificationTitle(milestone), subtitle, PaceMilestone.body(milestone, data.priorityLimits))
  }
}
