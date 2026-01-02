import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import type { Logger, OrderDTO } from "@medusajs/framework/types"
import { Modules } from "@medusajs/framework/utils"

import { ShiprocketService } from "../../../../../../services/shiprocket"

export const GET = async (req: MedusaRequest, res: MedusaResponse) => {
  const { id } = req.params as { id?: string }

  const logger: Logger = req.scope.resolve("logger")
  const orderModuleService = req.scope.resolve(Modules.ORDER)

  if (!id) {
    return res.status(400).json({
      id,
      tracking: null,
      error: "Order id is required",
    })
  }

  let order: OrderDTO | undefined

  try {
    order = await orderModuleService.retrieveOrder(id)
  } catch (e: any) {
    logger.error?.("Shiprocket admin tracking: failed to retrieve order", e)
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
