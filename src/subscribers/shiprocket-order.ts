import type { SubscriberArgs, SubscriberConfig } from "@medusajs/framework"
import type { Logger } from "@medusajs/framework/types"
import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils"

import { ShiprocketService } from "../services/shiprocket"

export default async function shiprocketShipmentHandler({
  event: { data },
  container,
}: SubscriberArgs<{ id: string }>) {
  const logger: Logger = container.resolve("logger")

  const orderModuleService = container.resolve(Modules.ORDER)
  const fulfillmentModuleService = container.resolve(Modules.FULFILLMENT)
  const query = container.resolve(ContainerRegistrationKeys.QUERY)

  const fulfillmentId = (data as any).id

  if (!fulfillmentId) {
    logger.warn?.(
      "Shiprocket subscriber: shipment.created event payload missing id (fulfillment/shipment id)"
    )
    return
  }

  // shipment.created currently only provides a fulfillment/shipment id, not the order id.
  // First, retrieve the fulfillment from the Fulfillment module to get its order_id.
  let fulfillment: any
  try {
    const fulfillments = await fulfillmentModuleService.listFulfillments({
      id: [fulfillmentId],
    })

    fulfillment = fulfillments[0]

    if (!fulfillment) {
      logger.warn?.(
        `Shiprocket subscriber: fulfillment not found for id ${fulfillmentId}`
      )
      return
    }
  } catch (e: any) {
    logger.warn?.(
      `Shiprocket subscriber: error retrieving fulfillment ${fulfillmentId} (${e?.message || "unknown error"})`
    )
    return
  }

  let orderId: string | undefined

  try {
    const { data: graphData } = await query.graph({
      entity: "fulfillment",
      fields: ["id", "order.id"],
      filters: {
        id: fulfillmentId,
      },
    })

    const node = Array.isArray(graphData) ? (graphData[0] as any) : undefined
    orderId = node?.order?.id as string | undefined
  } catch (e: any) {
    logger.warn?.(
      `Shiprocket subscriber: error resolving order for fulfillment ${fulfillmentId} via query.graph (${e?.message || "unknown error"})`
    )
    return
  }

  if (!orderId) {
    logger.warn?.(
      `Shiprocket subscriber: no order found via query.graph for fulfillment ${fulfillmentId}`
    )
    return
  }

  const order = await orderModuleService.retrieveOrder(orderId, {
    relations: ["billing_address", "shipping_address", "items"],
  })

  const existingMeta: any = order.metadata || {}

  // Idempotency: if we already have a Shiprocket shipment/order id, skip.
  if (
    existingMeta.shiprocket_shipment_id ||
    existingMeta.shiprocket_order_id
  ) {
    logger.info?.(
      `Shiprocket subscriber: shipment already exists for order ${order.id}, skipping creation`
    )
    return
  }

  const shiprocket = new ShiprocketService(logger)

  const result = await shiprocket.createShipmentForOrder(order)

  if (!result) {
    logger.warn?.(
      `Shiprocket subscriber: Shiprocket shipment creation returned null for order ${order.id}`
    )
    return
  }

  const {
    shiprocket_shipment_id,
    shiprocket_order_id,
    shiprocket_awb_code,
    shiprocket_courier_name,
    shiprocket_error_code,
    shiprocket_error_message,
  } = result as any

  const newMetadata = {
    ...(order.metadata || {}),
    ...(shiprocket_shipment_id || shiprocket_order_id || shiprocket_awb_code
      ? {
          shiprocket_shipment_id,
          shiprocket_order_id,
          shiprocket_awb_code,
          shiprocket_courier_name,
        }
      : {}),
    ...(shiprocket_error_code
      ? {
          shiprocket_error_code,
          shiprocket_error_message,
        }
      : {}),
  }

  await orderModuleService.updateOrders(order.id, {
    metadata: newMetadata,
  })

  // If Shiprocket returned an AWB without an error, attach basic tracking info
  // to the fulfillment's metadata for debugging/possible UI use.
  if (!shiprocket_error_code && shiprocket_awb_code) {
    try {
      const existingFulfillmentMeta = (fulfillment as any).metadata || {}

      await fulfillmentModuleService.updateFulfillment(fulfillmentId, {
        metadata: {
          ...existingFulfillmentMeta,
          shiprocket_awb_code,
          shiprocket_courier_name,
          shiprocket_tracking_url: `https://track.shiprocket.in/${shiprocket_awb_code}`,
        },
      })
    } catch (e: any) {
      logger.warn?.(
        `Shiprocket subscriber: failed to update fulfillment metadata for ${fulfillmentId} (${e?.message || "unknown error"})`
      )
    }
  }

  if (shiprocket_error_code) {
    logger.warn?.(
      `Shiprocket shipment failed for order ${order.id}: ${shiprocket_error_code} - ${shiprocket_error_message}`
    )
    return
  }

  logger.info?.(
    `Shiprocket shipment created and metadata updated for order ${order.id} (shipment_id=${shiprocket_shipment_id}, awb=${shiprocket_awb_code})`
  )
}

export const config: SubscriberConfig = {
  event: "shiprocket.disabled",
}