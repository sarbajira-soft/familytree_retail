import type { SubscriberArgs, SubscriberConfig } from "@medusajs/framework"
import type { Logger } from "@medusajs/framework/types"
import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils"

import { ShiprocketService } from "../services/shiprocket"

export default async function shiprocketOrderPlaced({
  event: { data },
  container,
}: SubscriberArgs<{ id: string }>) {
  const logger: Logger = container.resolve("logger")
  const orderService = container.resolve(Modules.ORDER)
  const query = container.resolve(ContainerRegistrationKeys.QUERY)
  const productModuleService = container.resolve(Modules.PRODUCT)

  const orderId = (data as any).id

  if (!orderId) {
    logger.warn("Shiprocket: order.placed event missing order id")
    return
  }

  let order: any
  try {
    const { data: graphData } = await query.graph({
      entity: "order",
      fields: [
        "id",
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

    order = Array.isArray(graphData) ? (graphData[0] as any) : null
  } catch (e: any) {
    logger.warn?.(
      `Shiprocket: order.placed failed to retrieve order ${orderId} via query.graph (${e?.message || "unknown error"})`
    )

    // Fallback: if graph query fails unexpectedly, try a plain retrieve.
    // Avoid relations here because MikroORM populate can fail depending on
    // the underlying module configuration.
    try {
      order = await orderService.retrieveOrder(orderId)
    } catch (e2: any) {
      logger.warn?.(
        `Shiprocket: order.placed failed to retrieve order ${orderId} (${e2?.message || "unknown error"})`
      )
      return
    }
  }

  if (!order) {
    logger.warn?.(`Shiprocket: order.placed could not load order ${orderId}`)
    return
  }

  // query.graph doesn't hydrate `items.variant` by default. We enrich the
  // order items with variant + product so Shiprocket weight/dimensions
  // estimation can use real data instead of env defaults.
  try {
    const items = ((order as any).items || []) as any[]
    const variantIds = Array.from(
      new Set(
        items
          .map((it) => (it as any).variant_id)
          .filter((id) => typeof id === "string" && id)
      )
    ) as string[]

    if (variantIds.length) {
      const variants = await productModuleService.listProductVariants(
        { id: variantIds },
        { relations: ["product"], take: variantIds.length }
      )

      const variantById = new Map<string, any>()
      for (const v of variants as any[]) {
        if (v && typeof (v as any).id === "string") {
          variantById.set((v as any).id, v)
        }
      }

      for (const it of items) {
        const vid = (it as any).variant_id
        if (typeof vid === "string" && variantById.has(vid)) {
          ;(it as any).variant = variantById.get(vid)
        }
      }
    }
  } catch (e: any) {
    logger.warn?.(
      `Shiprocket: failed to enrich order ${order.id} variants for dimension estimation (${e?.message || "unknown error"})`
    )
  }

  const existingMeta: any = order.metadata || {}

  // Idempotency: if we already have a Shiprocket shipment/order id, skip.
  if (
    existingMeta.shiprocket_shipment_id ||
    existingMeta.shiprocket_order_id
  ) {
    logger.info(
      `Shiprocket: shipment already exists for order ${order.id}, skipping creation`
    )
    return
  }

  const shiprocket = new ShiprocketService(logger)

  const result = await shiprocket.createShipmentForOrder(order)

  if (!result) {
    logger.warn(
      `Shiprocket: createShipmentForOrder returned null for order ${order.id}`
    )
    return
  }

  const {
    shiprocket_shipment_id,
    shiprocket_order_id,
    shiprocket_error_code,
    shiprocket_error_message,
  } = result as any

  const newMetadata = {
    ...(order.metadata || {}),
    ...(shiprocket_shipment_id || shiprocket_order_id
      ? {
          shiprocket_shipment_id,
          shiprocket_order_id,
        }
      : {}),
    ...(shiprocket_error_code
      ? {
          shiprocket_error_code,
          shiprocket_error_message,
        }
      : {}),
  }

  await orderService.updateOrders(order.id, {
    metadata: newMetadata,
  })

  if (shiprocket_error_code) {
    logger.warn(
      `Shiprocket: shipment had error for order ${order.id}: ${shiprocket_error_code} - ${shiprocket_error_message}`
    )
  } else {
    logger.info(
      `Shiprocket: shipment created for order ${order.id} (shipment_id=${shiprocket_shipment_id}, order_id=${shiprocket_order_id})`
    )
  }
}

export const config: SubscriberConfig = {
  event: "order.placed",
}
