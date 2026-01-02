import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import type { Logger } from "@medusajs/framework/types"
import { Modules } from "@medusajs/framework/utils"

/**
 * Admin endpoint to update Shiprocket-related weight and dimensions metadata
 * on an order. These overrides are consumed by ShiprocketService when
 * creating Shiprocket orders.
 *
 * POST /admin/orders/:id/shiprocket/weight-dimensions
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
      `Shiprocket weight/dimensions: failed to retrieve order ${id} - ${e?.message || "unknown error"}`
    )
    return res.status(404).json({
      success: false,
      code: "ORDER_NOT_FOUND",
      message: "Order not found",
    })
  }

  const existingMeta: any = order.metadata || {}

  if (existingMeta.shiprocket_awb_code) {
    return res.status(400).json({
      success: false,
      code: "AWB_ALREADY_ASSIGNED",
      message:
        "Shiprocket AWB is already assigned for this order. Weight and dimensions cannot be modified after AWB assignment.",
    })
  }

  const body = (req.body || {}) as any

  const weightRaw = body.weight_kg
  const lengthRaw = body.length_cm
  const breadthRaw = body.breadth_cm
  const heightRaw = body.height_cm

  const newMetadata: any = {
    ...existingMeta,
  }

  if (weightRaw === null) {
    delete newMetadata.shiprocket_weight_kg
  } else if (weightRaw !== undefined) {
    const parsed = Number(weightRaw)
    if (Number.isFinite(parsed) && parsed > 0) {
      newMetadata.shiprocket_weight_kg = parsed
    }
  }

  if (lengthRaw === null) {
    delete newMetadata.shiprocket_length_cm
  } else if (lengthRaw !== undefined) {
    const parsed = Number(lengthRaw)
    if (Number.isFinite(parsed) && parsed > 0) {
      newMetadata.shiprocket_length_cm = parsed
    }
  }

  if (breadthRaw === null) {
    delete newMetadata.shiprocket_breadth_cm
  } else if (breadthRaw !== undefined) {
    const parsed = Number(breadthRaw)
    if (Number.isFinite(parsed) && parsed > 0) {
      newMetadata.shiprocket_breadth_cm = parsed
    }
  }

  if (heightRaw === null) {
    delete newMetadata.shiprocket_height_cm
  } else if (heightRaw !== undefined) {
    const parsed = Number(heightRaw)
    if (Number.isFinite(parsed) && parsed > 0) {
      newMetadata.shiprocket_height_cm = parsed
    }
  }

  await orderModuleService.updateOrders(order.id, {
    metadata: newMetadata,
  })

  return res.json({
    success: true,
    metadata: newMetadata,
  })
}
