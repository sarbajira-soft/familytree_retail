import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import type { Logger } from "@medusajs/framework/types"
import { Modules } from "@medusajs/framework/utils"

import { ShiprocketService } from "../../../../../../../services/shiprocket"

/**
 * Admin endpoint to (re)trigger Shiprocket AWB assignment for an order.
 *
 * POST /admin/orders/:id/shiprocket/awb/retry
 */
export const POST = async (req: MedusaRequest, res: MedusaResponse) => {
  const logger: Logger = req.scope.resolve("logger")
  const orderModuleService = req.scope.resolve(Modules.ORDER)
  const fulfillmentModuleService = req.scope.resolve(Modules.FULFILLMENT)

  const { id } = req.params as { id?: string }

  if (!id) {
    return res.status(400).json({
      success: false,
      code: "ORDER_ID_REQUIRED",
      message: "Order id is required",
    })
  }

  let order: any

  try {
    order = await orderModuleService.retrieveOrder(id)
  } catch (e: any) {
    logger.warn?.(
      `Shiprocket admin AWB retry: failed to retrieve order ${id} - ${e?.message || "unknown error"}`
    )
    return res.status(404).json({
      success: false,
      code: "ORDER_NOT_FOUND",
      message: "Order not found",
    })
  }

  const existingMeta: any = order.metadata || {}

  if (!existingMeta.shiprocket_shipment_id) {
    return res.status(400).json({
      success: false,
      code: "NO_SHIPROCKET_SHIPMENT",
      message:
        "Order has no shiprocket_shipment_id. Create the Shiprocket order first before assigning an AWB.",
    })
  }

  if (existingMeta.shiprocket_awb_code && !existingMeta.shiprocket_error_code) {
    return res.json({
      success: true,
      already_exists: true,
      metadata: {
        shiprocket_shipment_id: existingMeta.shiprocket_shipment_id,
        shiprocket_order_id: existingMeta.shiprocket_order_id,
        shiprocket_awb_code: existingMeta.shiprocket_awb_code,
        shiprocket_courier_name: existingMeta.shiprocket_courier_name,
        shiprocket_awb_status: existingMeta.shiprocket_awb_status || "assigned",
      },
    })
  }

  const shiprocket = new ShiprocketService(logger)

  const awbResult = await shiprocket.assignAwb(
    existingMeta.shiprocket_shipment_id as number
  )

  if (!awbResult) {
    const fallbackCode = "AWB_ASSIGN_FAILED"
    const fallbackMessage = "Shiprocket AWB assignment returned no result"

    const newMetadata = {
      ...existingMeta,
      shiprocket_awb_status: "pending",
      shiprocket_error_code: fallbackCode,
      shiprocket_error_message: fallbackMessage,
    }

    await orderModuleService.updateOrders(order.id, {
      metadata: newMetadata,
    })

    return res.status(502).json({
      success: false,
      code: fallbackCode,
      message: fallbackMessage,
    })
  }

  const { awb_code, courier_name, error_code, error_message } = awbResult as any

  const newMetadata: any = {
    ...existingMeta,
  }

  if (awb_code) {
    newMetadata.shiprocket_awb_code = awb_code
    newMetadata.shiprocket_courier_name = courier_name
    newMetadata.shiprocket_awb_status = "assigned"
    newMetadata.shiprocket_error_code = null
    newMetadata.shiprocket_error_message = null
    newMetadata.shiprocket_tracking_url = `https://track.shiprocket.in/${awb_code}`
  } else {
    newMetadata.shiprocket_awb_status = "pending"
    newMetadata.shiprocket_error_code = error_code || "AWB_ASSIGN_FAILED"
    newMetadata.shiprocket_error_message =
      error_message || "Shiprocket AWB assignment failed"
  }

  await orderModuleService.updateOrders(order.id, {
    metadata: newMetadata,
  })

  // Best-effort: attach tracking to the first fulfillment for this order if we have an AWB.
  if (awb_code) {
    try {
      const fulfillments = await fulfillmentModuleService.listFulfillments({
        order_id: [order.id],
      } as any)

      if (Array.isArray(fulfillments) && fulfillments.length) {
        const fulfillment = fulfillments[0] as any

        await fulfillmentModuleService.updateFulfillment(fulfillment.id, {
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
        } as any)
      }
    } catch (e: any) {
      logger.warn?.(
        `Shiprocket admin AWB retry: failed to update fulfillment tracking links for order ${order.id} (${e?.message || "unknown error"})`
      )
    }
  }

  if (!awb_code) {
    logger.warn?.(
      `Shiprocket admin AWB retry failed for order ${order.id}: ${newMetadata.shiprocket_error_code} - ${newMetadata.shiprocket_error_message}`
    )

    return res.status(502).json({
      success: false,
      code: newMetadata.shiprocket_error_code,
      message: newMetadata.shiprocket_error_message,
    })
  }

  logger.info?.(
    `Shiprocket admin AWB retry succeeded for order ${order.id} (shipment_id=${existingMeta.shiprocket_shipment_id}, awb=${awb_code})`
  )

  return res.json({
    success: true,
    already_exists: false,
    metadata: {
      shiprocket_shipment_id: existingMeta.shiprocket_shipment_id,
      shiprocket_order_id: existingMeta.shiprocket_order_id,
      shiprocket_awb_code: awb_code,
      shiprocket_courier_name: courier_name,
      shiprocket_awb_status: "assigned",
    },
  })
}
