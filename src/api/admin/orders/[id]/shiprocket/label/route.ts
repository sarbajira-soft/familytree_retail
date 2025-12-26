import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import type { Logger } from "@medusajs/framework/types"
import { Modules } from "@medusajs/framework/utils"

import { ShiprocketService } from "../../../../../../services/shiprocket"

/**
 * Admin endpoint to generate and retrieve a Shiprocket shipping label URL
 * for an order's shipment.
 *
 * POST /admin/orders/:id/shiprocket/label
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
    order = await orderModuleService.retrieveOrder(id)
  } catch (e: any) {
    logger.warn?.(
      `Shiprocket label: failed to retrieve order ${id} - ${e?.message || "unknown error"}`
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
        "Order has no shiprocket_shipment_id. Create the Shiprocket order and assign AWB before generating a label.",
    })
  }

  const shiprocket = new ShiprocketService(logger)

  const labelResult = await shiprocket.generateLabel([
    existingMeta.shiprocket_shipment_id as number,
  ])

  if (!labelResult) {
    const fallbackCode = "LABEL_GENERATION_FAILED"
    const fallbackMessage = "Shiprocket label generation returned no result"

    return res.status(502).json({
      success: false,
      code: fallbackCode,
      message: fallbackMessage,
    })
  }

  const { label_url, error_code, error_message } = labelResult

  if (!label_url) {
    const code = error_code || "LABEL_GENERATION_FAILED"
    const message =
      error_message || "Shiprocket label generation did not return a label_url"

    return res.status(502).json({
      success: false,
      code,
      message,
    })
  }

  const newMetadata = {
    ...existingMeta,
    shiprocket_label_url: label_url,
  }

  await orderModuleService.updateOrders(order.id, {
    metadata: newMetadata,
  })

  return res.json({
    success: true,
    label_url,
    metadata: newMetadata,
  })
}
