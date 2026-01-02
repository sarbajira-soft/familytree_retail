import type { SubscriberArgs, SubscriberConfig } from "@medusajs/framework"
import type { Logger } from "@medusajs/framework/types"
import { Modules } from "@medusajs/framework/utils"

import { ShiprocketService } from "../services/shiprocket"

export default async function shiprocketAwbOnShipped({
  event: { data },
  container,
}: SubscriberArgs<{ order_id: string; fulfillment_id: string }>) {
  const logger: Logger = container.resolve("logger")

  const orderService = container.resolve(Modules.ORDER)
  const fulfillmentService = container.resolve(Modules.FULFILLMENT)

  const raw: any = data as any

  const fulfillmentId: string | undefined =
    (raw?.fulfillment_id as string | undefined) ||
    (raw?.id as string | undefined)

  if (!fulfillmentId) {
    const keys = raw && typeof raw === "object" ? Object.keys(raw) : []
    logger.warn(
      `Shiprocket: order.fulfillment_created event missing fulfillment id (payload keys: ${keys.join(",")})`
    )
    return
  }

  let fulfillment: any
  try {
    fulfillment = await fulfillmentService.retrieveFulfillment(fulfillmentId)
  } catch (e: any) {
    logger.warn(
      `Shiprocket: failed to retrieve fulfillment ${fulfillmentId}: ${
        e?.message || "unknown error"
      }`
    )
    return
  }

  const orderId: string | undefined =
    (fulfillment as any).order_id || (fulfillment as any).order?.id

  if (!orderId) {
    logger.warn(
      `Shiprocket: fulfillment ${fulfillmentId} has no associated order_id`
    )
    return
  }

  /**
   * 2. Retrieve order
   */
  const order = await orderService.retrieveOrder(orderId)

  const meta = order.metadata || {}

  /**
   * 3. Guard checks
   */
  if (!meta.shiprocket_shipment_id) {
    logger.warn(
      `Shiprocket: order ${order.id} has no shiprocket_shipment_id. Order must be created earlier.`
    )
    return
  }

  if (meta.shiprocket_awb_code) {
    const awbCode = String(meta.shiprocket_awb_code)
    const courierName =
      (typeof meta.shiprocket_courier_name === "string" &&
        meta.shiprocket_courier_name) || null
    const trackingUrl: string =
      (typeof meta.shiprocket_tracking_url === "string" &&
        meta.shiprocket_tracking_url) ||
      `https://track.shiprocket.in/${awbCode}`

    try {
      const existingFulfillmentMeta = (fulfillment as any)?.metadata || {}

      await fulfillmentService.updateFulfillment(
        fulfillmentId,
        {
          tracking_links: [
            {
              tracking_number: awbCode,
              url: trackingUrl,
              metadata: {
                provider: "shiprocket",
                courier: courierName,
              },
            },
          ],
          metadata: {
            ...existingFulfillmentMeta,
            shiprocket_awb_code: awbCode,
            shiprocket_courier_name: courierName,
            shiprocket_tracking_url: trackingUrl,
          },
        } as any
      )

      logger.info(
        `Shiprocket: AWB ${awbCode} already existed for order ${order.id}, attached tracking to fulfillment ${fulfillmentId}`
      )
    } catch (e: any) {
      logger.warn(
        `Shiprocket: failed to attach existing AWB ${awbCode} to fulfillment ${fulfillmentId} for order ${order.id}: ${e?.message || "unknown error"}`
      )
    }

    return
  }

  /**
   * 4. Retrieve the target fulfillment to attach AWB to
   *    (we already have fulfillment_id from the event payload)
   */
  const targetFulfillment = fulfillment

  /**
   * 5. Assign AWB
   */
  const shiprocket = new ShiprocketService(logger)

  const awbResult = await shiprocket.assignAwb(
    (meta as any).shiprocket_shipment_id as number
  )

  if (!awbResult) {
    logger.warn(
      `Shiprocket: AWB assignment returned null for order ${order.id}`
    )
    return
  }

  const { awb_code, courier_name, error_code, error_message } = awbResult as any

  let labelUrl: string | undefined
  let pickupScheduled = false
  let pickupErrorCode: string | null = null
  let pickupErrorMessage: string | null = null

  if (awb_code && !error_code) {
    try {
      const labelResult = await shiprocket.generateLabel([
        (meta as any).shiprocket_shipment_id as number,
      ])

      if (labelResult?.label_url) {
        labelUrl = labelResult.label_url
      } else if (labelResult?.error_code) {
        logger.warn(
          `Shiprocket: label generation failed for order ${order.id}: ${labelResult.error_code} - ${labelResult.error_message}`
        )
      }
    } catch (e: any) {
      logger.warn(
        `Shiprocket: exception during label generation for order ${order.id}: ${e?.message || "unknown error"}`
      )
    }

    try {
      const pickupResult = await shiprocket.schedulePickup([
        (meta as any).shiprocket_shipment_id as number,
      ])

      if (pickupResult?.success) {
        pickupScheduled = true
      } else if (pickupResult && !pickupResult.success) {
        pickupErrorCode = pickupResult.error_code || "PICKUP_FAILED"
        pickupErrorMessage =
          pickupResult.error_message || "Shiprocket pickup scheduling failed"
      }
    } catch (e: any) {
      logger.warn(
        `Shiprocket: exception during pickup scheduling for order ${order.id}: ${e?.message || "unknown error"}`
      )
    }
  }

  /**
   * 6. Save result (IMPORTANT: save even if AWB fails)
   */
  const pickupMeta: any = {}

  if (pickupScheduled) {
    pickupMeta.shiprocket_pickup_scheduled = true
    pickupMeta.shiprocket_pickup_error_code = null
    pickupMeta.shiprocket_pickup_error_message = null
  } else if (pickupErrorCode) {
    pickupMeta.shiprocket_pickup_scheduled = false
    pickupMeta.shiprocket_pickup_error_code = pickupErrorCode
    pickupMeta.shiprocket_pickup_error_message = pickupErrorMessage
  }

  await orderService.updateOrders(order.id, {
    metadata: {
      ...meta,
      shiprocket_awb_code: awb_code || null,
      shiprocket_courier_name: courier_name || null,
      shiprocket_awb_status: awb_code ? "assigned" : "pending",
      shiprocket_error_code: error_code || null,
      shiprocket_error_message: error_message || null,
      ...(labelUrl
        ? {
            shiprocket_label_url: labelUrl,
          }
        : {}),
      ...(awb_code
        ? {
            shiprocket_tracking_url: `https://track.shiprocket.in/${awb_code}`,
          }
        : {}),
      ...pickupMeta,
    },
  })

  /**
   * 7. Attach tracking to fulfillment (only if AWB exists)
   */
  if (awb_code) {
    const existingFulfillmentMeta = (targetFulfillment as any)?.metadata || {}

    await fulfillmentService.updateFulfillment(
      fulfillmentId,
      {
        tracking_links: [
          {
            tracking_number: awb_code,
            url: `https://track.shiprocket.in/${awb_code}`,
            metadata: {
              provider: "shiprocket",
              courier: courier_name,
            },
          },
        ],
        metadata: {
          ...existingFulfillmentMeta,
          shiprocket_awb_code: awb_code,
          shiprocket_courier_name: courier_name || null,
          shiprocket_tracking_url: `https://track.shiprocket.in/${awb_code}`,
        },
      } as any
    )

    logger.info(
      `Shiprocket: AWB ${awb_code} assigned for order ${order.id}`
    )
  } else {
    logger.warn(
      `Shiprocket: AWB assignment failed for order ${order.id}: ${error_message}`
    )
  }
}

/**
 * ✅ ONLY this event
 */
export const config: SubscriberConfig = {
  event: "order.fulfillment_created",
}
