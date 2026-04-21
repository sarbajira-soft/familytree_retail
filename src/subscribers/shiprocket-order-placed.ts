import type { SubscriberArgs, SubscriberConfig } from "@medusajs/framework"
import type { Logger } from "@medusajs/framework/types"

import { syncShiprocketOrderCreation } from "../services/shiprocket-order-sync"

export default async function shiprocketOrderPlaced({
  event: { data },
  container,
}: SubscriberArgs<{ id: string }>) {
  const logger: Logger = container.resolve("logger")
  const orderId = (data as any).id

  if (!orderId) {
    logger.warn?.("Shiprocket: order.placed event missing order id")
    return
  }

  const result = await syncShiprocketOrderCreation(container, orderId, logger)

  if (result.status === "created") {
    logger.info?.(`Shiprocket: shipment created for order ${orderId}`)
    return
  }

  if (result.status === "already_created") {
    logger.info?.(`Shiprocket: shipment already exists for order ${orderId}, skipping`)
    return
  }

  if (result.status === "skipped_cancelled") {
    logger.info?.(`Shiprocket: skipped creation because order ${orderId} is cancelled`)
    return
  }

  if (result.status === "create_failed") {
    logger.warn?.(`Shiprocket: shipment creation failed for order ${orderId}`)
    return
  }

  logger.warn?.(`Shiprocket: order ${orderId} could not be synchronized`)
}

export const config: SubscriberConfig = {
  event: "order.placed",
}
