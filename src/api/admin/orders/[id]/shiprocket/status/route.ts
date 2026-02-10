import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import type { Logger } from "@medusajs/framework/types"
import { Modules } from "@medusajs/framework/utils"

import { ShiprocketService } from "../../../../../../services/shiprocket"

function normalizeShiprocketStatus(raw: string | number | null | undefined): string {
  if (raw === null || raw === undefined) {
    return "unknown"
  }

  const value = raw.toString().toLowerCase().trim()

  if (!value) {
    return "unknown"
  }

  // Handle known numeric status codes from Shiprocket tracking
  if (/^\d+$/.test(value)) {
    // Common Shiprocket numeric shipment status codes.
    // Important ones (based on Shiprocket tracking payloads):
    // - 7: DELIVERED
    // - 17: OUT FOR DELIVERY
    // - 18: IN TRANSIT
    // - 19: OUT FOR PICKUP
    // - 21: UNDELIVERED
    // - 38: REACHED AT DESTINATION HUB
    // - 42: PICKED UP
    switch (value) {
      case "7":
        return "delivered"
      case "17":
        return "out_for_delivery"
      case "18":
      case "38":
        return "in_transit"
      case "19":
        return "pickup_scheduled"
      case "21":
        return "undelivered"
      case "42":
        return "picked_up"
      default:
        return "unknown"
    }
  }

  // Explicitly treat phrases like "picked up" / "pickup done" as picked_up
  if (value.includes("picked up") || value.includes("pickup done")) {
    return "picked_up"
  }

  // Generic pickup keywords fall back to pickup_scheduled
  if (value.includes("pickup") || value.includes("pick up")) {
    return "pickup_scheduled"
  }

  if (value.includes("transit") || value.includes("shipped")) {
    return "in_transit"
  }

  if (value.includes("out for delivery") || value.includes("ofd")) {
    return "out_for_delivery"
  }

  if (value.includes("undelivered") || value.includes("un-delivered")) {
    return "undelivered"
  }

  if (value.includes("delivered")) {
    return "delivered"
  }

  if (value.includes("rto") || value.includes("return")) {
    return "rto_initiated"
  }

  if (value.includes("cancel")) {
    return "cancelled"
  }

  return "unknown"
}

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
      `Shiprocket status: failed to retrieve order ${id} - ${e?.message || "unknown error"}`
    )
    return res.status(404).json({
      success: false,
      code: "ORDER_NOT_FOUND",
      message: "Order not found",
    })
  }

  const existingMeta: any = order.metadata || {}

  const awb: string | undefined = existingMeta.shiprocket_awb_code

  if (!awb) {
    return res.status(400).json({
      success: false,
      code: "NO_SHIPROCKET_AWB",
      message: "Order has no shiprocket_awb_code. Assign AWB before refreshing status.",
    })
  }

  const shiprocket = new ShiprocketService(logger)

  const tracking = await shiprocket.trackAwb(awb)

  if (!tracking) {
    const fallbackCode = "TRACKING_FAILED"
    const fallbackMessage = "Shiprocket AWB tracking returned no result"

    return res.status(502).json({
      success: false,
      code: fallbackCode,
      message: fallbackMessage,
    })
  }

  const body: any = tracking

  const td: any = body?.tracking_data || {}

  let rawStatus: any =
    (typeof td.current_status === "string" && td.current_status) ||
    td.shipment_status ||
    body.shipment_status ||
    body.current_status ||
    null

  if (!rawStatus && Array.isArray(td.shipment_track) && td.shipment_track.length) {
    const lastScan = td.shipment_track[td.shipment_track.length - 1] || {}
    rawStatus =
      lastScan["sr-status-label"] ||
      lastScan["sr_status_label"] ||
      lastScan.activity ||
      lastScan.status ||
      rawStatus
  }

  const normalized = normalizeShiprocketStatus(rawStatus)

  const prevHistory = Array.isArray(existingMeta.shiprocket_status_history)
    ? existingMeta.shiprocket_status_history
    : []

  const timestamp = new Date().toISOString()

  const pickupDoneOrScheduled =
    normalized === "pickup_scheduled" ||
    normalized === "picked_up" ||
    normalized === "in_transit" ||
    normalized === "delivered" ||
    normalized === "rto_initiated"

  const isShippedLike =
    normalized === "picked_up" ||
    normalized === "in_transit" ||
    normalized === "delivered" ||
    normalized === "rto_initiated"

  const newMetadata = {
    ...existingMeta,
    shiprocket_last_status: rawStatus || null,
    shiprocket_status_normalized: normalized,
    shiprocket_last_track_at: timestamp,
    ...(pickupDoneOrScheduled
      ? {
          shiprocket_pickup_scheduled: true,
          shiprocket_pickup_error_code: null,
          shiprocket_pickup_error_message: null,
        }
      : {}),
    ...(isShippedLike && existingMeta.shiprocket_awb_status !== "shipped"
      ? { shiprocket_awb_status: "shipped" }
      : {}),
    shiprocket_status_history: [
      ...prevHistory,
      {
        at: timestamp,
        normalized_status: normalized,
        raw_status: rawStatus || null,
        awb,
      },
    ],
  }

  await orderModuleService.updateOrders(order.id, {
    metadata: newMetadata,
  })

  logger.info?.(
    `Shiprocket status refreshed for order ${order.id} (awb=${awb}, status=${normalized})`
  )

  return res.json({
    success: true,
    status: {
      raw: rawStatus,
      normalized,
    },
    metadata: newMetadata,
  })
}
