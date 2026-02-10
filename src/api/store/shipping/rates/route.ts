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

    let perUnit = 0

    const meta = (item as any).metadata as Record<string, any> | undefined
    const metaWeight = meta?.weight_kg
    if (metaWeight !== undefined && metaWeight !== null && metaWeight !== "") {
      const parsed = Number(metaWeight)
      if (Number.isFinite(parsed) && parsed > 0) {
        perUnit = parsed
      }
    }

    if (!perUnit) {
      const variant = (item as any).variant as any | undefined
      const product = (variant as any)?.product || (item as any).product

      const variantWeightRaw = (variant as any)?.weight
      const productWeightRaw = product?.weight

      const variantWeightNum =
        typeof variantWeightRaw === "number" ? variantWeightRaw : Number(variantWeightRaw)
      const productWeightNum =
        typeof productWeightRaw === "number" ? productWeightRaw : Number(productWeightRaw)

      const grams =
        variantWeightNum && Number.isFinite(variantWeightNum) && variantWeightNum > 0
          ? variantWeightNum
          : productWeightNum && Number.isFinite(productWeightNum) && productWeightNum > 0
          ? productWeightNum
          : 0

      if (grams > 0) {
        perUnit = grams / 1000
      }
    }

    if (!perUnit || !Number.isFinite(perUnit) || perUnit <= 0) {
      perUnit = DEFAULT_WEIGHT
    }

    total += perUnit * qty
  }

  return total || DEFAULT_WEIGHT
}

const estimateCartDimensions = (cart: CartDTO): {
  length: number
  breadth: number
  height: number
} => {
  const items = (cart as any).items as any[] | undefined

  if (!Array.isArray(items) || items.length === 0) {
    return {
      length: DEFAULT_LENGTH,
      breadth: DEFAULT_BREADTH,
      height: DEFAULT_HEIGHT,
    }
  }

  let maxLength = 0
  let maxBreadth = 0
  let maxHeight = 0
  let totalVolume = 0

  const parse = (value: any): number => {
    const num = typeof value === "number" ? value : Number(value)
    return Number.isFinite(num) && num > 0 ? num : 0
  }

  for (const item of items) {
    const qty = typeof (item as any).quantity === "number" && (item as any).quantity > 0
      ? (item as any).quantity
      : 1

    const meta = (item as any).metadata as Record<string, any> | undefined

    const lengthCandidates = [meta?.length_cm]
    const widthCandidates = [meta?.breadth_cm]
    const heightCandidates = [meta?.height_cm]

    const variant = (item as any).variant as any | undefined
    const product = (variant as any)?.product || (item as any).product

    lengthCandidates.push((variant as any)?.length, (product as any)?.length)
    widthCandidates.push((variant as any)?.width, (product as any)?.width)
    heightCandidates.push((variant as any)?.height, (product as any)?.height)

    for (const candidate of lengthCandidates) {
      const n = parse(candidate)
      if (n > maxLength) {
        maxLength = n
      }
    }

    for (const candidate of widthCandidates) {
      const n = parse(candidate)
      if (n > maxBreadth) {
        maxBreadth = n
      }
    }

    for (const candidate of heightCandidates) {
      const n = parse(candidate)
      if (n > maxHeight) {
        maxHeight = n
      }
    }

    const perUnitLength = Math.max(...lengthCandidates.map((c) => parse(c)))
    const perUnitBreadth = Math.max(...widthCandidates.map((c) => parse(c)))
    const perUnitHeight = Math.max(...heightCandidates.map((c) => parse(c)))

    if (perUnitLength > 0 && perUnitBreadth > 0 && perUnitHeight > 0) {
      totalVolume += perUnitLength * perUnitBreadth * perUnitHeight * qty
    }
  }

  let packedHeight = 0
  if (totalVolume > 0 && maxLength > 0 && maxBreadth > 0) {
    packedHeight = Math.ceil(totalVolume / (maxLength * maxBreadth))
  }

  return {
    length: maxLength || DEFAULT_LENGTH,
    breadth: maxBreadth || DEFAULT_BREADTH,
    height: Math.max(maxHeight, packedHeight) || DEFAULT_HEIGHT,
  }
}

const analyzeCartWeightAndDimensionSources = (cart: CartDTO): {
  hasRealWeight: boolean
  hasRealDimensions: boolean
} => {
  const items = (cart as any).items as any[] | undefined

  if (!Array.isArray(items) || items.length === 0) {
    return { hasRealWeight: false, hasRealDimensions: false }
  }

  const parse = (value: any): number => {
    const num = typeof value === "number" ? value : Number(value)
    return Number.isFinite(num) && num > 0 ? num : 0
  }

  let hasRealWeight = false
  let hasRealDimensions = false

  for (const item of items) {
    const meta = (item as any).metadata as Record<string, any> | undefined

    const metaWeight = parse(meta?.weight_kg)
    if (metaWeight > 0 && Math.abs(metaWeight - DEFAULT_WEIGHT) > 1e-6) {
      hasRealWeight = true
    }

    const metaLength = parse(meta?.length_cm)
    const metaBreadth = parse(meta?.breadth_cm)
    const metaHeight = parse(meta?.height_cm)
    if (
      (metaLength > 0 && Math.abs(metaLength - DEFAULT_LENGTH) > 1e-6) ||
      (metaBreadth > 0 && Math.abs(metaBreadth - DEFAULT_BREADTH) > 1e-6) ||
      (metaHeight > 0 && Math.abs(metaHeight - DEFAULT_HEIGHT) > 1e-6)
    ) {
      hasRealDimensions = true
    }

    const variant = (item as any).variant as any | undefined
    const product = (variant as any)?.product || (item as any).product

    const variantWeight = parse((variant as any)?.weight)
    const productWeight = parse(product?.weight)

    if (variantWeight > 0 || productWeight > 0) {
      hasRealWeight = true
    }

    const lengthCandidates = [
      (variant as any)?.length,
      (product as any)?.length,
    ]
    const widthCandidates = [
      (variant as any)?.width,
      (product as any)?.width,
    ]
    const heightCandidates = [
      (variant as any)?.height,
      (product as any)?.height,
    ]

    if (
      lengthCandidates.some((c) => parse(c) > 0) ||
      widthCandidates.some((c) => parse(c) > 0) ||
      heightCandidates.some((c) => parse(c) > 0)
    ) {
      hasRealDimensions = true
    }

    if (hasRealWeight && hasRealDimensions) {
      break
    }
  }

  return { hasRealWeight, hasRealDimensions }
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
    // Prefer loading variant relations so we can use variant-level
    // weight/dimensions for Shiprocket, but fall back gracefully if the
    // underlying module does not support nested relations.
    cart = await cartModuleService.retrieveCart(cartId, {
      relations: ["items", "items.variant", "shipping_address"],
    })
  } catch (e: any) {
    const primaryMsg =
      "Shiprocket shipping rates: primary cart retrieval failed" +
      (e?.message ? ` (${e.message})` : "")
    logger.warn?.(primaryMsg)

    try {
      // Fallback: minimal relations that should always be available.
      cart = await cartModuleService.retrieveCart(cartId, {
        relations: ["items", "shipping_address"],
      })
    } catch (e2: any) {
      const msg =
        "Shiprocket shipping rates: failed to retrieve cart" +
        (e2?.message ? ` (${e2.message})` : "")
      logger.warn?.(msg)
      return res.status(404).json({
        serviceable: false,
        error: "Cart not found",
      })
    }
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
  const { length, breadth, height } = estimateCartDimensions(cart)

  const { hasRealWeight, hasRealDimensions } = analyzeCartWeightAndDimensionSources(cart)

  let effectiveWeight = totalWeight || DEFAULT_WEIGHT
  let lengthForApi: number | undefined
  let breadthForApi: number | undefined
  let heightForApi: number | undefined

  if (hasRealWeight && hasRealDimensions) {
    lengthForApi = length
    breadthForApi = breadth
    heightForApi = height
  } else if (hasRealWeight && !hasRealDimensions) {
    // Only weight is known from products/variants; omit dimensions.
  } else if (!hasRealWeight && hasRealDimensions) {
    // Only dimensions are known from products/variants; ensure a sensible weight.
    effectiveWeight = effectiveWeight || DEFAULT_WEIGHT
    lengthForApi = length
    breadthForApi = breadth
    heightForApi = height
  } else {
    // Neither real weight nor dimensions on products/variants; fall back to defaults.
    effectiveWeight = DEFAULT_WEIGHT
    lengthForApi = DEFAULT_LENGTH
    breadthForApi = DEFAULT_BREADTH
    heightForApi = DEFAULT_HEIGHT
  }

  const declaredValueRaw =
    (cart as any).subtotal?.numeric ?? (cart as any).total?.numeric ?? 0

  const declaredValue =
    typeof declaredValueRaw === "number" && declaredValueRaw > 0
      ? declaredValueRaw
      : undefined

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

  logger.info?.(
    "Shiprocket shipping rates: serviceability payload " +
      JSON.stringify({
        cart_id: cartId,
        pickup_postcode: pickupPostcode,
        delivery_postcode: shippingAddress.postal_code,
        weight: effectiveWeight,
        cod: isCod ? 1 : 0,
        length: lengthForApi,
        breadth: breadthForApi,
        height: heightForApi,
        declared_value: declaredValue,
        hasRealWeight,
        hasRealDimensions,
      })
  )

  const serviceability = await shiprocket.checkServiceability({
    pickup_postcode: pickupPostcode,
    delivery_postcode: shippingAddress.postal_code,
    weight: effectiveWeight,
    cod: isCod ? 1 : 0,
    length: lengthForApi,
    breadth: breadthForApi,
    height: heightForApi,
    declared_value: declaredValue,
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

  const sortedByRate = [...source].sort((a, b) => {
    const ar =
      typeof a.rate === "number" && !Number.isNaN(a.rate)
        ? a.rate
        : Number.POSITIVE_INFINITY
    const br =
      typeof b.rate === "number" && !Number.isNaN(b.rate)
        ? b.rate
        : Number.POSITIVE_INFINITY

    if (ar !== br) {
      return ar - br
    }

    const ad =
      typeof a.etaDays === "number" && Number.isFinite(a.etaDays)
        ? a.etaDays
        : Number.POSITIVE_INFINITY
    const bd =
      typeof b.etaDays === "number" && Number.isFinite(b.etaDays)
        ? b.etaDays
        : Number.POSITIVE_INFINITY

    return ad - bd
  })

  const sortedByEta = [...source].sort((a, b) => {
    const ad =
      typeof a.etaDays === "number" && Number.isFinite(a.etaDays)
        ? a.etaDays
        : Number.POSITIVE_INFINITY
    const bd =
      typeof b.etaDays === "number" && Number.isFinite(b.etaDays)
        ? b.etaDays
        : Number.POSITIVE_INFINITY

    if (ad !== bd) {
      return ad - bd
    }

    const ar =
      typeof a.rate === "number" && !Number.isNaN(a.rate)
        ? a.rate
        : Number.POSITIVE_INFINITY
    const br =
      typeof b.rate === "number" && !Number.isNaN(b.rate)
        ? b.rate
        : Number.POSITIVE_INFINITY

    return ar - br
  })

  const standardChoice: (typeof enriched)[number] | null =
    sortedByRate.length > 0 ? sortedByRate[0] : null

  let expressChoice: (typeof enriched)[number] | null =
    sortedByEta.length > 0 ? sortedByEta[0] : null

  if (standardChoice && expressChoice && sortedByEta.length > 1) {
    const standardRate = standardChoice.rate
    const standardEta = standardChoice.etaDays

    const altExpress = sortedByEta.find((entry) => {
      if (entry === standardChoice) {
        return false
      }

      const sameRate = entry.rate === standardRate
      const sameEta = entry.etaDays === standardEta

      // Prefer any alternative whose effective price or ETA differs from the
      // standard choice. We don't require a different courier_company_id
      // because Shiprocket can return multiple services for the same
      // courier (e.g. surface vs air) with distinct pricing.
      return !(sameRate && sameEta)
    })

    if (altExpress) {
      expressChoice = altExpress
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

  logger.info?.(
    "Shiprocket shipping rates: aggregated result " +
      JSON.stringify({
        cart_id: cartId,
        delivery_postcode: shippingAddress.postal_code,
        payment_type: isCod ? "COD" : "PREPAID",
        standard,
        express,
      })
  )

  return res.json({
    serviceable: true,
    cart_id: cartId,
    delivery_postcode: shippingAddress.postal_code,
    payment_type: isCod ? "COD" : "PREPAID",
    standard,
    express,
  })
}
