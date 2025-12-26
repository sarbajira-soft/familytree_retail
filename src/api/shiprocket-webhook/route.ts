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
  const raw = (body.shipment_status || body.current_status || "").toString().toLowerCase()

  if (!raw) {
    return "unknown"
  }

  if (raw.includes("pickup")) {
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

  if (ipWhitelist.length && remoteIp && !ipWhitelist.includes(remoteIp)) {
    logger.warn?.(`Shiprocket webhook: request from disallowed IP ${remoteIp}`)
    return res.sendStatus(401)
  }

  if (secret) {
    const headerToken =
      (req.headers["x-shiprocket-token"] as string | undefined) ||
      (req.headers["x-shiprocket-webhook-token"] as string | undefined)

    if (!headerToken || headerToken !== secret) {
      logger.warn?.("Shiprocket webhook: invalid or missing secret token")
      return res.sendStatus(401)
    }
  }

  const body = req.body as any

  if (!body) {
    logger.warn?.("Shiprocket webhook: empty body")
    return res.sendStatus(400)
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

  const nextMetadata = {
    ...existingMeta,
    shiprocket_last_status: body.shipment_status || body.current_status,
    shiprocket_status_normalized: normalized,
    shiprocket_last_webhook_at: new Date().toISOString(),
    shiprocket_status_history: [
      ...prevHistory,
      {
        at: new Date().toISOString(),
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
