import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import type { Logger } from "@medusajs/framework/types"
import { Modules } from "@medusajs/framework/utils"

import { ShiprocketService } from "../../../../../../services/shiprocket"

/**
 * Admin endpoint to (re)trigger Shiprocket shipment creation for an order.
 *
 * POST /admin/orders/:id/shiprocket/retry
 *
 * This will:
 * - Respect idempotency: if a successful Shiprocket shipment already exists,
 *   it will not create a duplicate and will just return existing metadata.
 * - On error, it will update order.metadata with shiprocket_error_code/message
 *   and return a 4xx/5xx response so the admin UI can display it.
 */
export const POST = async (req: MedusaRequest, res: MedusaResponse) => {
  const logger: Logger = req.scope.resolve("logger")
  const orderModuleService = req.scope.resolve(Modules.ORDER)

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
    order = await orderModuleService.retrieveOrder(id, {
      relations: ["billing_address", "shipping_address", "items"],
    })
  } catch (e: any) {
    logger.warn?.(
      `Shiprocket admin retry: failed to retrieve order ${id} - ${e?.message || "unknown error"}`
    )
    return res.status(404).json({
      success: false,
      code: "ORDER_NOT_FOUND",
      message: "Order not found",
    })
  }

  const existingMeta: any = order.metadata || {}

  const hasShipment =
    existingMeta.shiprocket_shipment_id ||
    existingMeta.shiprocket_order_id ||
    existingMeta.shiprocket_awb_code

  // If we already have a successful shipment and no error recorded,
  // do not create a duplicate. Just return the existing metadata.
  if (hasShipment && !existingMeta.shiprocket_error_code) {
    return res.json({
      success: true,
      already_exists: true,
      metadata: {
        shiprocket_shipment_id: existingMeta.shiprocket_shipment_id,
        shiprocket_order_id: existingMeta.shiprocket_order_id,
        shiprocket_awb_code: existingMeta.shiprocket_awb_code,
        shiprocket_courier_name: existingMeta.shiprocket_courier_name,
      },
    })
  }

  const shiprocket = new ShiprocketService(logger)

  const result = await shiprocket.createShipmentForOrder(order)

  if (!result) {
    const fallbackCode = "UNKNOWN_ERROR"
    const fallbackMessage = "Shiprocket returned no result"

    await orderModuleService.updateOrders(order.id, {
      metadata: {
        ...(order.metadata || {}),
        shiprocket_error_code: fallbackCode,
        shiprocket_error_message: fallbackMessage,
      },
    })

    return res.status(502).json({
      success: false,
      code: fallbackCode,
      message: fallbackMessage,
    })
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

  if (shiprocket_error_code) {
    logger.warn?.(
      `Shiprocket admin retry failed for order ${order.id}: ${shiprocket_error_code} - ${shiprocket_error_message}`
    )

    return res.status(502).json({
      success: false,
      code: shiprocket_error_code,
      message: shiprocket_error_message,
    })
  }

  logger.info?.(
    `Shiprocket admin retry succeeded for order ${order.id} (shipment_id=${shiprocket_shipment_id}, order_id=${shiprocket_order_id})`
  )

  return res.json({
    success: true,
    already_exists: false,
    metadata: {
      shiprocket_shipment_id,
      shiprocket_order_id,
      shiprocket_awb_code,
      shiprocket_courier_name,
    },
  })
}
