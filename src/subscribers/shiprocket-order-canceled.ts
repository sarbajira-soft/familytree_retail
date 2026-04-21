import type { SubscriberArgs, SubscriberConfig } from "@medusajs/framework"
import type { Logger } from "@medusajs/framework/types"

import { syncShiprocketOrderCancellation } from "../services/shiprocket-order-sync"

export default async function shiprocketOrderCanceled({
  event: { data },
  container,
}: SubscriberArgs<{ id: string }>) {
  const logger: Logger = container.resolve("logger")
  const orderId = (data as any).id

  if (!orderId) {
    logger.warn?.("Shiprocket: order.canceled event missing order id")
    return
  }

  const result = await syncShiprocketOrderCancellation(container, orderId, logger)

  if (result.status === "cancelled") {
    logger.info?.(`Shiprocket: cancellation synced for order ${orderId}`)
    return
  }

  if (result.status === "already_cancelled" || result.status === "not_required") {
    logger.info?.(`Shiprocket: cancellation already settled for order ${orderId}`)
    return
  }

  if (result.status === "blocked") {
    logger.warn?.(
      `Shiprocket: cancellation for order ${orderId} requires manual handling because shipment is already in progress`
    )
    return
  }

  if (result.status === "cancel_failed") {
    logger.warn?.(`Shiprocket: cancellation failed for order ${orderId}, retry queued`)
    return
  }

  logger.warn?.(`Shiprocket: cancellation sync could not load order ${orderId}`)
}

export const config: SubscriberConfig = {
  event: "order.canceled",
}
