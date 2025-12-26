import type { SubscriberArgs, SubscriberConfig } from "@medusajs/framework"
import type { Logger } from "@medusajs/framework/types"
import { Modules } from "@medusajs/framework/utils"

import { ShiprocketService } from "../services/shiprocket"

export default async function shiprocketOrderPlaced({
  event: { data },
  container,
}: SubscriberArgs<{ id: string }>) {
  const logger: Logger = container.resolve("logger")
  const orderService = container.resolve(Modules.ORDER)

  const orderId = (data as any).id

  if (!orderId) {
    logger.warn("Shiprocket: order.placed event missing order id")
    return
  }

  const order = await orderService.retrieveOrder(orderId, {
    relations: ["billing_address", "shipping_address", "items"],
  })

  const existingMeta: any = order.metadata || {}

  // Idempotency: if we already have a Shiprocket shipment/order id, skip.
  if (
    existingMeta.shiprocket_shipment_id ||
    existingMeta.shiprocket_order_id
  ) {
    logger.info(
      `Shiprocket: shipment already exists for order ${order.id}, skipping creation`
    )
    return
  }

  const shiprocket = new ShiprocketService(logger)

  const result = await shiprocket.createShipmentForOrder(order)

  if (!result) {
    logger.warn(
      `Shiprocket: createShipmentForOrder returned null for order ${order.id}`
    )
    return
  }

  const {
    shiprocket_shipment_id,
    shiprocket_order_id,
    shiprocket_error_code,
    shiprocket_error_message,
  } = result as any

  const newMetadata = {
    ...(order.metadata || {}),
    ...(shiprocket_shipment_id || shiprocket_order_id
      ? {
          shiprocket_shipment_id,
          shiprocket_order_id,
        }
      : {}),
    ...(shiprocket_error_code
      ? {
          shiprocket_error_code,
          shiprocket_error_message,
        }
      : {}),
  }

  await orderService.updateOrders(order.id, {
    metadata: newMetadata,
  })

  if (shiprocket_error_code) {
    logger.warn(
      `Shiprocket: shipment had error for order ${order.id}: ${shiprocket_error_code} - ${shiprocket_error_message}`
    )
  } else {
    logger.info(
      `Shiprocket: shipment created for order ${order.id} (shipment_id=${shiprocket_shipment_id}, order_id=${shiprocket_order_id})`
    )
  }
}

export const config: SubscriberConfig = {
  event: "order.placed",
}
