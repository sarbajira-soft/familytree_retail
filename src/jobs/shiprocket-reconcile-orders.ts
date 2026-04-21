import type { MedusaContainer } from "@medusajs/framework/types"
import { Modules } from "@medusajs/framework/utils"

import {
  syncShiprocketOrderCancellation,
  syncShiprocketOrderCreation,
} from "../services/shiprocket-order-sync"

export default async function shiprocketReconcileOrders(container: MedusaContainer) {
  const logger: any = container.resolve("logger")
  const orderModuleService = container.resolve(Modules.ORDER) as any
  const limit = Number(process.env.SHIPROCKET_RECONCILE_LIMIT || 100)

  const orders = await orderModuleService.listOrders(
    {},
    {
      take: limit,
    }
  )

  const candidates = (Array.isArray(orders) ? orders : []).filter((order: any) => {
    const metadata = (order?.metadata || {}) as Record<string, any>
    const orderStatus = String(order?.status || "").toLowerCase()

    const needsCreateRetry =
      orderStatus !== "canceled" &&
      orderStatus !== "cancelled" &&
      !metadata.shiprocket_shipment_id &&
      !metadata.shiprocket_order_id &&
      (metadata.shiprocket_retry_needed ||
        metadata.shiprocket_sync_status === "create_failed")

    const needsCancelRetry =
      (orderStatus === "canceled" || orderStatus === "cancelled") &&
      (metadata.shiprocket_cancel_retry_needed ||
        metadata.shiprocket_manual_cancellation_needed)

    return needsCreateRetry || needsCancelRetry
  })

  logger.info?.(
    JSON.stringify({
      message: "Shiprocket reconcile: start",
      count: candidates.length,
    })
  )

  for (const order of candidates) {
    const metadata = (order?.metadata || {}) as Record<string, any>
    const orderStatus = String(order?.status || "").toLowerCase()

    try {
      if (
        (orderStatus === "canceled" || orderStatus === "cancelled") &&
        (metadata.shiprocket_cancel_retry_needed ||
          metadata.shiprocket_manual_cancellation_needed)
      ) {
        await syncShiprocketOrderCancellation(container, order.id, logger)
        continue
      }

      if (
        !metadata.shiprocket_shipment_id &&
        !metadata.shiprocket_order_id &&
        (metadata.shiprocket_retry_needed ||
          metadata.shiprocket_sync_status === "create_failed")
      ) {
        await syncShiprocketOrderCreation(container, order.id, logger)
      }
    } catch (error: any) {
      logger.warn?.(
        JSON.stringify({
          message: "Shiprocket reconcile: failed to sync order",
          order_id: order?.id || null,
          error_message: error?.message || "unknown error",
        })
      )
    }
  }

  logger.info?.(
    JSON.stringify({
      message: "Shiprocket reconcile: end",
      processed: candidates.length,
    })
  )
}

export const config = {
  name: "shiprocket-reconcile-orders",
  schedule: process.env.SHIPROCKET_RECONCILE_SCHEDULE || "*/5 * * * *",
}
