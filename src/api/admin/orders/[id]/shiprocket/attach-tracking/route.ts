import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import type { Logger } from "@medusajs/framework/types"
import { Modules } from "@medusajs/framework/utils"

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
      `Shiprocket attach-tracking: failed to retrieve order ${id} - ${
        e?.message || "unknown error"
      }`
    )
    return res.status(404).json({
      success: false,
      code: "ORDER_NOT_FOUND",
      message: "Order not found",
    })
  }

  const meta: any = order.metadata || {}
  const awbCode: string | undefined = meta.shiprocket_awb_code

  if (!awbCode) {
    return res.status(400).json({
      success: false,
      code: "NO_SHIPROCKET_AWB",
      message: "Order has no Shiprocket AWB code in metadata.",
    })
  }

  const courierName: string | undefined = meta.shiprocket_courier_name
  const trackingUrl: string =
    (typeof meta.shiprocket_tracking_url === "string" &&
      meta.shiprocket_tracking_url) ||
    `https://track.shiprocket.in/${awbCode}`

  const body = (req.body || {}) as { fulfillment_id?: string }
  const requestedFulfillmentId: string | undefined = body.fulfillment_id

  let fulfillments: any[] = []

  try {
    const orderWithFulfillments = await orderModuleService.retrieveOrder(order.id, {
      relations: ["fulfillments"],
    })

    order = orderWithFulfillments
    fulfillments = ((orderWithFulfillments as any).fulfillments || []) as any[]
  } catch (e: any) {
    logger.warn?.(
      `Shiprocket attach-tracking: failed to load fulfillments for order ${order.id} - ${
        e?.message || "unknown error"
      }`
    )
  }

  if (!Array.isArray(fulfillments) || fulfillments.length === 0) {
    return res.status(400).json({
      success: false,
      code: "NO_FULFILLMENTS",
      message: "Order has no fulfillments to attach tracking to.",
    })
  }

  let targets = fulfillments

  if (requestedFulfillmentId) {
    targets = fulfillments.filter((f: any) => f.id === requestedFulfillmentId)

    if (!targets.length) {
      return res.status(404).json({
        success: false,
        code: "FULFILLMENT_NOT_FOUND",
        message: "Specified fulfillment not found for this order.",
      })
    }
  } else {
    const withoutTracking = fulfillments.filter((f: any) => {
      const links = (f as any).tracking_links || []
      return !Array.isArray(links) || !links.length
    })

    if (withoutTracking.length) {
      targets = withoutTracking
    }
  }

  const updatedIds: string[] = []

  for (const f of targets) {
    const existingMeta: any = (f as any).metadata || {}

    try {
      await fulfillmentModuleService.updateFulfillment(f.id, {
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
          ...existingMeta,
          shiprocket_awb_code: awbCode,
          shiprocket_courier_name: courierName || null,
          shiprocket_tracking_url: trackingUrl,
        },
      } as any)

      updatedIds.push(f.id)
    } catch (e: any) {
      logger.warn?.(
        `Shiprocket attach-tracking: failed to update fulfillment ${f.id} for order ${order.id} - ${
          e?.message || "unknown error"
        }`
      )
    }
  }

  if (!updatedIds.length) {
    return res.status(500).json({
      success: false,
      code: "ATTACH_TRACKING_FAILED",
      message: "Failed to attach tracking to any fulfillment.",
    })
  }

  return res.json({
    success: true,
    order_id: order.id,
    awb_code: awbCode,
    courier_name: courierName || null,
    tracking_url: trackingUrl,
    updated_fulfillment_ids: updatedIds,
    metadata: order.metadata || {},
  })
}
