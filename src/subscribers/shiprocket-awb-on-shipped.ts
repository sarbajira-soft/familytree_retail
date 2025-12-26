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

  const orderId: string | undefined = raw?.order_id as string | undefined
  const fulfillmentId: string | undefined = raw?.fulfillment_id as string | undefined

  if (!orderId || !fulfillmentId) {
    const keys = raw && typeof raw === "object" ? Object.keys(raw) : []
    logger.warn(
      `Shiprocket: order.fulfillment_created event missing order_id or fulfillment_id (payload keys: ${keys.join(",")})`
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
    logger.info(
      `Shiprocket: AWB already assigned for order ${order.id}, skipping`
    )
    return
  }

  /**
   * 4. Retrieve the target fulfillment to attach AWB to
   *    (we already have fulfillment_id from the event payload)
   */
  const targetFulfillment = await fulfillmentService.retrieveFulfillment(fulfillmentId)

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
  }

  /**
   * 6. Save result (IMPORTANT: save even if AWB fails)
   */
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
