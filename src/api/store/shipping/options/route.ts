import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import type { Logger, CartDTO } from "@medusajs/framework/types"
import { Modules } from "@medusajs/framework/utils"

import { ShiprocketService } from "../../../../services/shiprocket"

const DEFAULT_LENGTH = Number(process.env.SHIPROCKET_DEFAULT_LENGTH || 10)
const DEFAULT_BREADTH = Number(process.env.SHIPROCKET_DEFAULT_BREADTH || 10)
const DEFAULT_HEIGHT = Number(process.env.SHIPROCKET_DEFAULT_HEIGHT || 10)
const DEFAULT_WEIGHT = Number(process.env.SHIPROCKET_DEFAULT_WEIGHT_KG || 0.5)

const normalizeCodFlag = (rawCod: unknown, cart: CartDTO | null): 0 | 1 => {
  if (rawCod === 1 || rawCod === "1" || rawCod === true || rawCod === "true") {
    return 1
  }
  if (rawCod === 0 || rawCod === "0" || rawCod === false || rawCod === "false") {
    return 0
  }

  const context = (cart as any)?.context as Record<string, any> | undefined
  const paymentHint =
    context?.payment_type || context?.payment_method || context?.payment_mode

  if (typeof paymentHint === "string") {
    const lower = paymentHint.toLowerCase()
    if (lower.includes("cod") || lower.includes("cash_on_delivery")) {
      return 1
    }
  }

  return 0
}

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

export const POST = async (req: MedusaRequest, res: MedusaResponse) => {
  const logger: Logger = req.scope.resolve("logger")
  const cartModuleService = req.scope.resolve(Modules.CART)

  const pickupPostcode = process.env.SHIPROCKET_PICKUP_POSTCODE

  if (!pickupPostcode) {
    logger.warn?.(
      "Shiprocket shipping options: SHIPROCKET_PICKUP_POSTCODE is not configured, cannot calculate shipping options"
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
    logger.warn?.("Shiprocket shipping options: failed to retrieve cart", e)
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

  const codFlag = normalizeCodFlag(body.cod, cart)

  const shiprocket = new ShiprocketService(logger)

  const serviceability = await shiprocket.checkServiceability({
    pickup_postcode: pickupPostcode,
    delivery_postcode: shippingAddress.postal_code,
    weight: totalWeight,
    cod: codFlag,
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
      shipping_options: [],
    })
  }

  const shippingOptions = serviceability.courier_company.map((courier: any) => {
    const rate = deriveCourierRate(courier)

    const amountMinor = Math.max(0, Math.round(rate * 100))

    const { label: etaLabel, days: etaDays } = deriveEtaLabelAndDays(
      courier.estimated_delivery_days
    )

    const name = etaLabel
      ? `${courier.courier_name} (${etaLabel})`
      : courier.courier_name

    return {
      id: `shiprocket-${courier.courier_company_id}`,
      name,
      provider_id: "shiprocket",
      amount: amountMinor,
      currency_code: (cart as any).currency_code,
      metadata: {
        courier_id: courier.courier_company_id,
        courier_name: courier.courier_name,
        estimated_delivery_days: etaDays,
        etd: etaLabel,
        rate,
      },
    }
  })

  return res.json({
    serviceable: true,
    cart_id: cartId,
    shipping_options: shippingOptions,
  })
}
