import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import type { Logger } from "@medusajs/framework/types"
import { Modules } from "@medusajs/framework/utils"

import { ShiprocketService } from "../../../../../../services/shiprocket"

/**
 * Admin endpoint to generate and retrieve a Shiprocket invoice URL
 * for an order.
 *
 * POST /admin/orders/:id/shiprocket/invoice
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
      `Shiprocket invoice: failed to retrieve order ${id} - ${e?.message || "unknown error"}`
    )
    return res.status(404).json({
      success: false,
      code: "ORDER_NOT_FOUND",
      message: "Order not found",
    })
  }

  const existingMeta: any = order.metadata || {}

  if (!existingMeta.shiprocket_order_id) {
    return res.status(400).json({
      success: false,
      code: "NO_SHIPROCKET_ORDER_ID",
      message:
        "Order has no shiprocket_order_id. Create the Shiprocket order before generating an invoice.",
    })
  }

  const numericOrderId = Number(existingMeta.shiprocket_order_id)

  if (!Number.isFinite(numericOrderId) || numericOrderId <= 0) {
    return res.status(400).json({
      success: false,
      code: "INVALID_SHIPROCKET_ORDER_ID",
      message: "shiprocket_order_id metadata is not a valid numeric id",
    })
  }

  const shiprocket = new ShiprocketService(logger)

  const invoiceResult = await shiprocket.generateInvoice([numericOrderId])

  if (!invoiceResult) {
    const fallbackCode = "INVOICE_GENERATION_FAILED"
    const fallbackMessage = "Shiprocket invoice generation returned no result"

    return res.status(502).json({
      success: false,
      code: fallbackCode,
      message: fallbackMessage,
    })
  }

  const { invoice_url, error_code, error_message } = invoiceResult

  if (!invoice_url) {
    const code = error_code || "INVOICE_GENERATION_FAILED"
    const message =
      error_message || "Shiprocket invoice generation did not return an invoice_url"

    return res.status(502).json({
      success: false,
      code,
      message,
    })
  }

  const newMetadata = {
    ...existingMeta,
    shiprocket_invoice_url: invoice_url,
  }

  await orderModuleService.updateOrders(order.id, {
    metadata: newMetadata,
  })

  return res.json({
    success: true,
    invoice_url,
    metadata: newMetadata,
  })
}
