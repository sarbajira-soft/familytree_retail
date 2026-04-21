import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import type { Logger } from "@medusajs/framework/types"

import { cancelOrderWorkflow } from "@medusajs/core-flows"
import { Modules, MedusaError } from "@medusajs/framework/utils"

import { getOwnedOrder, requireStoreCustomerId } from "../../retail-helpers"
import { syncShiprocketOrderCancellation } from "../../../../../services/shiprocket-order-sync"

const BLOCKED_FULFILLMENT_STATUSES = new Set([
  "fulfilled",
  "partially_fulfilled",
  "shipped",
  "partially_shipped",
  "delivered",
  "partially_delivered",
  "returned",
  "partially_returned",
])

export const POST = async (req: MedusaRequest, res: MedusaResponse) => {
  const logger: Logger = req.scope.resolve("logger")
  const orderId = (req.params?.id || "").toString()

  if (!orderId) {
    throw new MedusaError(MedusaError.Types.INVALID_DATA, "Order id is required")
  }

  const customerId = await requireStoreCustomerId(req)
  const order = await getOwnedOrder(req, orderId)

  const orderStatus = String((order as any)?.status || "").toLowerCase()
  const fulfillmentStatus = String(
    (order as any)?.fulfillment_status || ""
  ).toLowerCase()
  const metadata = ((order as any)?.metadata || {}) as Record<string, any>

  if (orderStatus === "canceled" || orderStatus === "cancelled") {
    throw new MedusaError(
      MedusaError.Types.INVALID_DATA,
      "This order has already been cancelled."
    )
  }

  if (BLOCKED_FULFILLMENT_STATUSES.has(fulfillmentStatus)) {
    throw new MedusaError(
      MedusaError.Types.INVALID_DATA,
      "This order can no longer be cancelled because shipment processing has already started."
    )
  }

  if (metadata.shiprocket_awb_code || metadata.shiprocket_pickup_scheduled) {
    throw new MedusaError(
      MedusaError.Types.INVALID_DATA,
      "This order can no longer be cancelled because shipment processing has already started."
    )
  }

  await cancelOrderWorkflow(req.scope).run({
    input: {
      order_id: orderId,
    } as any,
  })

  const orderModuleService = req.scope.resolve(Modules.ORDER) as any

  await orderModuleService.updateOrders(orderId, {
    metadata: {
      ...metadata,
      customer_cancelled_at: new Date().toISOString(),
      customer_cancelled_by: customerId,
      shiprocket_manual_cancellation_needed: Boolean(
        metadata.shiprocket_shipment_id || metadata.shiprocket_order_id
      ),
      shiprocket_cancel_status:
        metadata.shiprocket_shipment_id || metadata.shiprocket_order_id
          ? "pending"
          : "not_required",
      shiprocket_cancel_retry_needed: Boolean(
        metadata.shiprocket_shipment_id || metadata.shiprocket_order_id
      ),
    },
  })

  try {
    await syncShiprocketOrderCancellation(req.scope as any, orderId, logger)
  } catch (e: any) {
    logger.warn?.(
      `Shiprocket store cancel sync failed for order ${orderId} (${e?.message || "unknown error"})`
    )
  }

  const updatedOrder = await getOwnedOrder(req, orderId)

  res.status(200).json({
    order: updatedOrder,
    cancelled: true,
  })
}
