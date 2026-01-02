import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import type { Logger } from "@medusajs/framework/types"
import { Modules } from "@medusajs/framework/utils"

import { ShiprocketService } from "../../../../../../services/shiprocket"

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
    order = await orderModuleService.retrieveOrder(id)
  } catch (e: any) {
    logger.warn?.(
      `Shiprocket pickup: failed to retrieve order ${id} - ${e?.message || "unknown error"}`
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
        "Order has no shiprocket_shipment_id. Create the Shiprocket order and assign AWB before scheduling a pickup.",
    })
  }

  if (!existingMeta.shiprocket_awb_code) {
    return res.status(400).json({
      success: false,
      code: "NO_SHIPROCKET_AWB",
      message: "Order has no shiprocket_awb_code. Assign AWB before scheduling a pickup.",
    })
  }

  const shiprocket = new ShiprocketService(logger)

  const pickupResult = await shiprocket.schedulePickup([
    existingMeta.shiprocket_shipment_id as number,
  ])

  if (!pickupResult) {
    const fallbackCode = "PICKUP_FAILED"
    const fallbackMessage = "Shiprocket pickup scheduling returned no result"

    const newMetadata = {
      ...existingMeta,
      shiprocket_pickup_scheduled: false,
      shiprocket_pickup_error_code: fallbackCode,
      shiprocket_pickup_error_message: fallbackMessage,
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

  const { success, error_code, error_message } = pickupResult

  const newMetadata: any = {
    ...existingMeta,
  }

  if (success) {
    newMetadata.shiprocket_pickup_scheduled = true
    newMetadata.shiprocket_pickup_error_code = null
    newMetadata.shiprocket_pickup_error_message = null
  } else {
    newMetadata.shiprocket_pickup_scheduled = false
    newMetadata.shiprocket_pickup_error_code = error_code || "PICKUP_FAILED"
    newMetadata.shiprocket_pickup_error_message =
      error_message || "Shiprocket pickup scheduling failed"
  }

  await orderModuleService.updateOrders(order.id, {
    metadata: newMetadata,
  })

  if (!success) {
    logger.warn?.(
      `Shiprocket pickup failed for order ${order.id}: ${newMetadata.shiprocket_pickup_error_code} - ${newMetadata.shiprocket_pickup_error_message}`
    )

    return res.status(502).json({
      success: false,
      code: newMetadata.shiprocket_pickup_error_code,
      message: newMetadata.shiprocket_pickup_error_message,
      metadata: newMetadata,
    })
  }

  logger.info?.(
    `Shiprocket pickup scheduled for order ${order.id} (shipment_id=${existingMeta.shiprocket_shipment_id})`
  )

  return res.json({
    success: true,
    metadata: newMetadata,
  })
}
