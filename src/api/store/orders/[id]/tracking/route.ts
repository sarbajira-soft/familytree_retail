import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import type { Logger } from "@medusajs/framework/types"

import { ShiprocketService } from "../../../../../services/shiprocket"
import { getOwnedOrder } from "../../retail-helpers"

export const GET = async (req: MedusaRequest, res: MedusaResponse) => {
  const { id } = req.params

  const logger: Logger = req.scope.resolve("logger")
  let order: any

  try {
    order = await getOwnedOrder(req, id)
  } catch (e: any) {
    logger.error?.("Shiprocket tracking: failed to retrieve order", e)
    return res.status(404).json({
      id,
      tracking: null,
      error: "Order not found",
    })
  }

  if (!order) {
    return res.status(404).json({
      id,
      tracking: null,
      error: "Order not found",
    })
  }

  const metadata = (order.metadata || {}) as any
  const awbCode: string | undefined = metadata.shiprocket_awb_code
  const courierName: string | undefined = metadata.shiprocket_courier_name

  let shiprocketTracking: any = null

  if (awbCode) {
    const shiprocket = new ShiprocketService(logger)
    shiprocketTracking = await shiprocket.trackAwb(awbCode)
  }

  return res.json({
    order_id: order.id,
    awb_code: awbCode || null,
    courier_name: courierName || null,
    shiprocket_status: metadata.shiprocket_status_normalized || null,
    shiprocket_raw_status: metadata.shiprocket_last_status || null,
    shiprocket_tracking: shiprocketTracking,
  })
}
