import type { Logger, MedusaContainer } from "@medusajs/framework/types"
import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils"

import { ShiprocketService } from "./shiprocket"

const SHIPPED_LIKE_STATUSES = new Set([
  "pickup_scheduled",
  "picked_up",
  "in_transit",
  "delivered",
  "rto_initiated",
  "shipped",
])

function toNumericId(value: unknown) {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null
}

function stringifyError(error: unknown) {
  if (!error) {
    return "Unknown error"
  }

  if (typeof error === "string") {
    return error
  }

  if (error instanceof Error) {
    return error.message || "Unknown error"
  }

  try {
    return JSON.stringify(error)
  } catch {
    return "Unknown error"
  }
}

async function loadOrderForShiprocket(
  container: MedusaContainer,
  orderId: string,
  logger: Logger
) {
  const orderService = container.resolve(Modules.ORDER) as any
  const query = container.resolve(ContainerRegistrationKeys.QUERY) as any
  const productModuleService = container.resolve(Modules.PRODUCT) as any

  let order: any = null

  try {
    const { data: graphData } = await query.graph({
      entity: "order",
      fields: [
        "id",
        "status",
        "created_at",
        "email",
        "subtotal",
        "total",
        "shipping_total",
        "discount_total",
        "metadata",
        "billing_address.*",
        "shipping_address.*",
        "items.*",
        "items.variant_sku",
        "items.variant_id",
        "shipping_methods.*",
        "shipping_methods.data",
      ],
      filters: {
        id: [orderId],
      },
    })

    order = Array.isArray(graphData) ? graphData[0] || null : null
  } catch (e) {
    logger.warn?.(
      `Shiprocket sync: query.graph failed while loading order ${orderId} (${stringifyError(
        e
      )})`
    )
  }

  if (!order) {
    try {
      order = await orderService.retrieveOrder(orderId, {
        relations: [
          "billing_address",
          "shipping_address",
          "items",
          "items.variant",
          "shipping_methods",
          "payment_collections",
        ],
      })
    } catch (e) {
      logger.warn?.(
        `Shiprocket sync: retrieveOrder failed for ${orderId} (${stringifyError(e)})`
      )
      return null
    }
  }

  try {
    const items = ((order as any).items || []) as any[]
    const variantIds = Array.from(
      new Set(
        items
          .map((item) => item?.variant_id)
          .filter((id) => typeof id === "string" && id)
      )
    ) as string[]

    if (variantIds.length) {
      const variants = await productModuleService.listProductVariants(
        { id: variantIds },
        { relations: ["product"], take: variantIds.length }
      )

      const variantById = new Map<string, any>()
      for (const variant of variants as any[]) {
        if (variant?.id) {
          variantById.set(String(variant.id), variant)
        }
      }

      for (const item of items) {
        const variantId = item?.variant_id
        if (typeof variantId === "string" && variantById.has(variantId)) {
          item.variant = variantById.get(variantId)
        }
      }
    }
  } catch (e) {
    logger.warn?.(
      `Shiprocket sync: failed to enrich variants for order ${orderId} (${stringifyError(
        e
      )})`
    )
  }

  return order
}

export async function syncShiprocketOrderCreation(
  container: MedusaContainer,
  orderId: string,
  logger: Logger
) {
  const orderModuleService = container.resolve(Modules.ORDER) as any
  const order = await loadOrderForShiprocket(container, orderId, logger)

  if (!order) {
    return { status: "not_found" as const }
  }

  const existingMeta = ((order as any).metadata || {}) as Record<string, any>
  const orderStatus = String((order as any).status || "").toLowerCase()

  if (orderStatus === "canceled" || orderStatus === "cancelled") {
    await orderModuleService.updateOrders(order.id, {
      metadata: {
        ...existingMeta,
        shiprocket_sync_status: "skipped_cancelled",
        shiprocket_retry_needed: false,
        shiprocket_last_sync_at: new Date().toISOString(),
      },
    })

    return { status: "skipped_cancelled" as const }
  }

  if (existingMeta.shiprocket_shipment_id || existingMeta.shiprocket_order_id) {
    return { status: "already_created" as const }
  }

  const shiprocket = new ShiprocketService(logger)
  const result = await shiprocket.createShipmentForOrder(order)
  const nowIso = new Date().toISOString()

  if (!result) {
    await orderModuleService.updateOrders(order.id, {
      metadata: {
        ...existingMeta,
        shiprocket_sync_status: "create_failed",
        shiprocket_retry_needed: true,
        shiprocket_error_code: "UNKNOWN_ERROR",
        shiprocket_error_message: "Shiprocket returned no result while creating shipment",
        shiprocket_last_error_at: nowIso,
        shiprocket_last_sync_at: nowIso,
      },
    })

    return { status: "create_failed" as const }
  }

  const {
    shiprocket_shipment_id,
    shiprocket_order_id,
    shiprocket_awb_code,
    shiprocket_courier_name,
    shiprocket_error_code,
    shiprocket_error_message,
  } = result as any

  const nextMetadata = {
    ...existingMeta,
    ...(shiprocket_shipment_id || shiprocket_order_id || shiprocket_awb_code
      ? {
          shiprocket_shipment_id,
          shiprocket_order_id,
          shiprocket_awb_code,
          shiprocket_courier_name,
        }
      : {}),
    shiprocket_sync_status: shiprocket_error_code ? "create_failed" : "created",
    shiprocket_retry_needed: Boolean(shiprocket_error_code),
    shiprocket_last_sync_at: nowIso,
    shiprocket_last_error_at: shiprocket_error_code ? nowIso : null,
    shiprocket_error_code: shiprocket_error_code || null,
    shiprocket_error_message: shiprocket_error_message || null,
    ...(shiprocket_awb_code
      ? {
          shiprocket_tracking_url: `https://track.shiprocket.in/${shiprocket_awb_code}`,
        }
      : {}),
  }

  await orderModuleService.updateOrders(order.id, {
    metadata: nextMetadata,
  })

  return {
    status: shiprocket_error_code ? ("create_failed" as const) : ("created" as const),
    metadata: nextMetadata,
  }
}

export async function syncShiprocketOrderCancellation(
  container: MedusaContainer,
  orderId: string,
  logger: Logger
) {
  const orderModuleService = container.resolve(Modules.ORDER) as any

  let order: any
  try {
    order = await orderModuleService.retrieveOrder(orderId)
  } catch (e) {
    logger.warn?.(
      `Shiprocket cancel sync: failed to retrieve order ${orderId} (${stringifyError(
        e
      )})`
    )
    return { status: "not_found" as const }
  }

  const existingMeta = ((order as any).metadata || {}) as Record<string, any>
  const shiprocketOrderId = toNumericId(existingMeta.shiprocket_order_id)
  const normalizedStatus = String(
    existingMeta.shiprocket_status_normalized || ""
  ).toLowerCase()
  const nowIso = new Date().toISOString()

  if (existingMeta.shiprocket_cancel_status === "cancelled") {
    return { status: "already_cancelled" as const }
  }

  if (!shiprocketOrderId) {
    const nextMetadata = {
      ...existingMeta,
      shiprocket_cancel_status: "not_required",
      shiprocket_cancel_retry_needed: false,
      shiprocket_manual_cancellation_needed: false,
      shiprocket_last_cancel_attempt_at: nowIso,
    }

    await orderModuleService.updateOrders(order.id, {
      metadata: nextMetadata,
    })

    return { status: "not_required" as const, metadata: nextMetadata }
  }

  if (
    SHIPPED_LIKE_STATUSES.has(normalizedStatus) ||
    existingMeta.shiprocket_pickup_scheduled
  ) {
    const nextMetadata = {
      ...existingMeta,
      shiprocket_cancel_status: "blocked",
      shiprocket_cancel_retry_needed: false,
      shiprocket_manual_cancellation_needed: false,
      shiprocket_cancel_error_code: "SHIPMENT_ALREADY_IN_PROGRESS",
      shiprocket_cancel_error_message:
        "Shiprocket shipment is already in progress and can no longer be auto-cancelled.",
      shiprocket_last_cancel_attempt_at: nowIso,
    }

    await orderModuleService.updateOrders(order.id, {
      metadata: nextMetadata,
    })

    return { status: "blocked" as const, metadata: nextMetadata }
  }

  const shiprocket = new ShiprocketService(logger)
  const result = await shiprocket.cancelOrders([shiprocketOrderId])

  if (!result?.success) {
    const lowerMessage = String(result?.error_message || "").toLowerCase()
    const treatAsCancelled =
      lowerMessage.includes("already cancel") || lowerMessage.includes("already cancelled")

    const nextMetadata = {
      ...existingMeta,
      shiprocket_cancel_status: treatAsCancelled ? "cancelled" : "cancel_failed",
      shiprocket_cancel_retry_needed: !treatAsCancelled,
      shiprocket_manual_cancellation_needed: !treatAsCancelled,
      shiprocket_cancel_error_code: treatAsCancelled
        ? null
        : result?.error_code || "SHIPROCKET_API_ERROR",
      shiprocket_cancel_error_message: treatAsCancelled
        ? null
        : result?.error_message || "Shiprocket cancellation failed",
      shiprocket_cancelled_at: treatAsCancelled
        ? existingMeta.shiprocket_cancelled_at || nowIso
        : existingMeta.shiprocket_cancelled_at || null,
      shiprocket_last_cancel_attempt_at: nowIso,
    }

    await orderModuleService.updateOrders(order.id, {
      metadata: nextMetadata,
    })

    return {
      status: treatAsCancelled ? ("cancelled" as const) : ("cancel_failed" as const),
      metadata: nextMetadata,
    }
  }

  const nextMetadata = {
    ...existingMeta,
    shiprocket_cancel_status: "cancelled",
    shiprocket_cancel_retry_needed: false,
    shiprocket_manual_cancellation_needed: false,
    shiprocket_cancel_error_code: null,
    shiprocket_cancel_error_message: null,
    shiprocket_cancelled_at: nowIso,
    shiprocket_last_cancel_attempt_at: nowIso,
    shiprocket_last_status:
      existingMeta.shiprocket_last_status || "Cancelled in Shiprocket",
    shiprocket_status_normalized:
      normalizedStatus && SHIPPED_LIKE_STATUSES.has(normalizedStatus)
        ? normalizedStatus
        : "cancelled",
  }

  await orderModuleService.updateOrders(order.id, {
    metadata: nextMetadata,
  })

  return { status: "cancelled" as const, metadata: nextMetadata }
}
