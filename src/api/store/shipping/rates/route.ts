import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import type { Logger, CartDTO } from "@medusajs/framework/types"
import { Modules } from "@medusajs/framework/utils"

import { ShiprocketService } from "../../../../services/shiprocket"

const DEFAULT_LENGTH = Number(process.env.SHIPROCKET_DEFAULT_LENGTH || 10)
const DEFAULT_BREADTH = Number(process.env.SHIPROCKET_DEFAULT_BREADTH || 10)
const DEFAULT_HEIGHT = Number(process.env.SHIPROCKET_DEFAULT_HEIGHT || 10)
const DEFAULT_WEIGHT = Number(process.env.SHIPROCKET_DEFAULT_WEIGHT_KG || 0.5)

const estimateCartWeight = (cart: CartDTO): number => {
  const items = (cart as any).items as any[] | undefined

  if (!Array.isArray(items) || items.length === 0) {
    return DEFAULT_WEIGHT
  }

  let total = 0

  for (const item of items) {
    const qty = typeof item.quantity === "number" && item.quantity > 0 ? item.quantity : 1
    const weightMeta = (item.metadata as any)?.weight_kg
    const perUnit = weightMeta ? Number(weightMeta) : DEFAULT_WEIGHT

    total += perUnit * qty
  }

  return total || DEFAULT_WEIGHT
}

const deriveCourierRate = (courier: any): number => {
  if (typeof courier.rate === "number" && !Number.isNaN(courier.rate)) {
    return courier.rate
  }
  if (
    typeof courier.freight_charge === "number" &&
    !Number.isNaN(courier.freight_charge)
  ) {
    return courier.freight_charge
  }
  return 0
}

const deriveEtaLabelAndDays = (
  rawEta: unknown
): { label: string | null; days: number | null } => {
  if (rawEta == null) {
    return { label: null, days: null }
  }

  if (typeof rawEta === "number" && Number.isFinite(rawEta)) {
    const days = Math.max(1, Math.round(rawEta))
    return { label: `${days} day${days > 1 ? "s" : ""}`, days }
  }

  if (typeof rawEta === "string" && rawEta.trim().length) {
    const match = rawEta.match(/(\d+)(?:\s*-\s*(\d+))?/)
    if (match) {
      const first = Number.parseInt(match[1], 10)
      const second = match[2] ? Number.parseInt(match[2], 10) : null
      if (!Number.isNaN(first)) {
        const avg = second && !Number.isNaN(second) ? Math.round((first + second) / 2) : first
        const days = Math.max(1, avg)
        return { label: rawEta, days }
      }
    }
    return { label: rawEta, days: null }
  }

  return { label: null, days: null }
}

type AggregatedRate = {
  amount: number
  eta: string | null
  eta_days: number | null
}

export const POST = async (req: MedusaRequest, res: MedusaResponse) => {
  const logger: Logger = req.scope.resolve("logger")
  const cartModuleService = req.scope.resolve(Modules.CART)

  const pickupPostcode = process.env.SHIPROCKET_PICKUP_POSTCODE

  if (!pickupPostcode) {
    logger.warn?.(
      "Shiprocket shipping rates: SHIPROCKET_PICKUP_POSTCODE is not configured, cannot calculate shipping rates"
    )
    return res.status(500).json({
      serviceable: false,
      error: "Shiprocket pickup postcode is not configured on the server",
    })
  }

  const body = (req.body || {}) as any
  const cartId: string | undefined = body.cart_id

  if (!cartId) {
    return res.status(400).json({
      serviceable: false,
      error: "cart_id is required",
    })
  }

  let cart: CartDTO
  try {
    cart = await cartModuleService.retrieveCart(cartId, {
      relations: ["items", "shipping_address"],
    })
  } catch (e: any) {
    const msg =
      "Shiprocket shipping rates: failed to retrieve cart" +
      (e?.message ? ` (${e.message})` : "")
    logger.warn?.(msg)
    return res.status(404).json({
      serviceable: false,
      error: "Cart not found",
    })
  }

  const shippingAddress = (cart as any).shipping_address as
    | { postal_code?: string | null }
    | undefined

  if (!shippingAddress?.postal_code) {
    return res.status(400).json({
      serviceable: false,
      error: "Cart is missing a shipping postal_code",
    })
  }

  const totalWeight = estimateCartWeight(cart)

  const declaredValue =
    (cart as any).subtotal?.numeric ?? (cart as any).total?.numeric ?? 0

  const context = (cart as any).context as Record<string, any> | undefined

  const bodyPayment =
    (typeof body.payment_type === "string" && body.payment_type) ||
    (typeof body.payment_mode === "string" && body.payment_mode) ||
    (typeof body.payment_method === "string" && body.payment_method) ||
    undefined

  const contextPayment =
    (typeof context?.payment_type === "string" && context.payment_type) ||
    (typeof context?.payment_mode === "string" && context.payment_mode) ||
    (typeof context?.payment_method === "string" && context.payment_method) ||
    undefined

  const paymentHint = (bodyPayment || contextPayment || "").toString().toLowerCase()

  const isCod =
    paymentHint.includes("cod") ||
    paymentHint.includes("cash_on_delivery") ||
    paymentHint.includes("cash-on-delivery")

  const shiprocket = new ShiprocketService(logger)

  const serviceability = await shiprocket.checkServiceability({
    pickup_postcode: pickupPostcode,
    delivery_postcode: shippingAddress.postal_code,
    weight: totalWeight,
    cod: isCod ? 1 : 0,
    length: DEFAULT_LENGTH,
    breadth: DEFAULT_BREADTH,
    height: DEFAULT_HEIGHT,
    declared_value:
      typeof declaredValue === "number" && declaredValue > 0
        ? declaredValue
        : undefined,
  })

  if (
    !serviceability ||
    !Array.isArray(serviceability.courier_company) ||
    serviceability.courier_company.length === 0
  ) {
    return res.json({
      serviceable: false,
      cart_id: cartId,
      standard: null,
      express: null,
    })
  }

  const enriched = serviceability.courier_company.map((courier: any) => {
    const rate = deriveCourierRate(courier)

    const { label: etaLabel, days: etaDays } = deriveEtaLabelAndDays(
      courier.estimated_delivery_days
    )

    return {
      courier,
      rate,
      etaLabel,
      etaDays,
    }
  })

  const valid = enriched.filter(
    (e) => typeof e.rate === "number" && !Number.isNaN(e.rate) && e.rate >= 0
  )

  const source = valid.length ? valid : enriched

  let standardChoice: (typeof enriched)[number] | null = null
  let expressChoice: (typeof enriched)[number] | null = null

  for (const entry of source) {
    if (!standardChoice) {
      standardChoice = entry
    } else if (entry.rate < standardChoice.rate) {
      standardChoice = entry
    } else if (entry.rate === standardChoice.rate) {
      const currentDays =
        typeof standardChoice.etaDays === "number" &&
        Number.isFinite(standardChoice.etaDays)
          ? standardChoice.etaDays
          : Number.POSITIVE_INFINITY
      const candidateDays =
        typeof entry.etaDays === "number" && Number.isFinite(entry.etaDays)
          ? entry.etaDays
          : Number.POSITIVE_INFINITY
      if (candidateDays < currentDays) {
        standardChoice = entry
      }
    }

    if (!expressChoice) {
      expressChoice = entry
    } else {
      const currentDays =
        typeof expressChoice.etaDays === "number" &&
        Number.isFinite(expressChoice.etaDays)
          ? expressChoice.etaDays
          : Number.POSITIVE_INFINITY
      const candidateDays =
        typeof entry.etaDays === "number" && Number.isFinite(entry.etaDays)
          ? entry.etaDays
          : Number.POSITIVE_INFINITY

      if (candidateDays < currentDays) {
        expressChoice = entry
      } else if (candidateDays === currentDays && entry.rate < expressChoice.rate) {
        expressChoice = entry
      }
    }
  }

  const toPayload = (choice: (typeof enriched)[number] | null): AggregatedRate | null => {
    if (!choice) {
      return null
    }

    const roundedAmount =
      typeof choice.rate === "number" && Number.isFinite(choice.rate)
        ? Math.max(0, Math.round(choice.rate))
        : 0

    return {
      amount: roundedAmount,
      eta: choice.etaLabel,
      eta_days:
        typeof choice.etaDays === "number" && Number.isFinite(choice.etaDays)
          ? choice.etaDays
          : null,
    }
  }

  const standard = toPayload(standardChoice)
  const express = toPayload(expressChoice)

  return res.json({
    serviceable: true,
    cart_id: cartId,
    delivery_postcode: shippingAddress.postal_code,
    payment_type: isCod ? "COD" : "PREPAID",
    standard,
    express,
  })
}
