import crypto from "crypto"

import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import type { Logger } from "@medusajs/framework/types"
import { Modules } from "@medusajs/framework/utils"

function getClientIp(req: MedusaRequest): string | undefined {
  const xff = (req.headers["x-forwarded-for"] as string | undefined)?.split(",")[0]?.trim()
  if (xff) {
    return xff
  }

  // @ts-ignore - express style IP helpers may exist
  if ((req as any).ip) {
    return (req as any).ip as string
  }

  // Node HTTP
  // @ts-ignore
  return req.socket?.remoteAddress as string | undefined
}

function normalizeShiprocketStatus(body: any): string {
  const base = body.shipment_status ?? body.current_status

  if (base === null || base === undefined) {
    return "unknown"
  }

  const raw = base.toString().toLowerCase().trim()

  if (!raw) {
    return "unknown"
  }

  // Handle known numeric status codes from Shiprocket tracking
  if (/^\d+$/.test(raw)) {
    // 42 is used by Shiprocket for "PICKED UP"
    if (raw === "42") {
      return "picked_up"
    }

    return "unknown"
  }

  if (raw.includes("picked up") || raw.includes("pickup done")) {
    return "picked_up"
  }

  if (raw.includes("pickup") || raw.includes("pick up")) {
    return "pickup_scheduled"
  }

  if (raw.includes("transit") || raw.includes("shipped")) {
    return "in_transit"
  }

  if (raw.includes("delivered")) {
    return "delivered"
  }

  if (raw.includes("rto") || raw.includes("return")) {
    return "rto_initiated"
  }

  if (raw.includes("cancel")) {
    return "cancelled"
  }

  return "unknown"
}

export const AUTHENTICATE = false

export const POST = async (req: MedusaRequest, res: MedusaResponse) => {
  const logger: Logger = req.scope.resolve("logger")
  const orderModuleService = req.scope.resolve(Modules.ORDER)

  const secret = process.env.SHIPROCKET_WEBHOOK_SECRET
  const ipWhitelistEnv = process.env.SHIPROCKET_WEBHOOK_IP_WHITELIST || ""
  const ipWhitelist = ipWhitelistEnv
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)

  const remoteIp = getClientIp(req)

  let shouldProcess = true

  if (ipWhitelist.length && remoteIp && !ipWhitelist.includes(remoteIp)) {
    logger.warn?.(`Shiprocket webhook: request from disallowed IP ${remoteIp}`)
    shouldProcess = false
  }

  if (secret) {
    const headerToken = req.headers["anx-api-key"] as string | undefined

    if (!headerToken || headerToken !== secret) {
      logger.warn?.("Shiprocket webhook: invalid or missing secret token")
      shouldProcess = false
    }
  }

  const body = req.body as any

  if (!body) {
    logger.warn?.("Shiprocket webhook: empty body")
    return res.sendStatus(200)
  }

  if (!shouldProcess) {
    return res.sendStatus(200)
  }

  const orderRef: string | undefined = body.order_id
  const awb: string | undefined = body.awb

  if (!orderRef && !awb) {
    logger.warn?.("Shiprocket webhook: missing order reference and AWB")
    return res.sendStatus(200)
  }

  let order: any = null

  try {
    if (orderRef) {
      order = await orderModuleService.retrieveOrder(orderRef)
    }
  } catch (e: any) {
    logger.error?.("Shiprocket webhook: failed to retrieve order", e)
  }

  if (!order) {
    logger.warn?.(`Shiprocket webhook: order not found for ref ${orderRef || awb}`)
    return res.sendStatus(200)
  }

  const normalized = normalizeShiprocketStatus(body)

  const existingMeta: any = order.metadata || {}
  const prevHistory = Array.isArray(existingMeta.shiprocket_status_history)
    ? existingMeta.shiprocket_status_history
    : []

  const nowIso = new Date().toISOString()

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

  const nextMetadata = {
    ...existingMeta,
    shiprocket_last_status: body.shipment_status || body.current_status,
    shiprocket_status_normalized: normalized,
    shiprocket_last_webhook_at: nowIso,
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
        at: nowIso,
        normalized_status: normalized,
        raw_status: body.shipment_status || body.current_status || null,
        awb: awb || null,
      },
    ],
  }

  try {
    await orderModuleService.updateOrders(order.id, {
      metadata: nextMetadata,
    })

    logger.info?.(
      `Shiprocket webhook processed for order ${order.id} with status ${normalized}`
    )
  } catch (e: any) {
    logger.error?.("Shiprocket webhook: failed to update order metadata", e)
  }

  return res.sendStatus(200)
}
