import { AbstractFulfillmentProviderService } from "@medusajs/framework/utils"
import type {
  Logger,
  FulfillmentOption,
  CreateShippingOptionDTO,
  CalculateShippingOptionPriceDTO,
  CalculatedShippingOptionPrice,
  CreateFulfillmentResult,
  FulfillmentItemDTO,
  FulfillmentOrderDTO,
  FulfillmentDTO,
} from "@medusajs/framework/types"
import { ShiprocketService } from "../../services/shiprocket"

export type InjectedDependencies = {
  logger: Logger
}

export type ShiprocketFulfillmentProviderOptions = Record<string, any>

const DEFAULT_LENGTH = Number(process.env.SHIPROCKET_DEFAULT_LENGTH || 10)
const DEFAULT_BREADTH = Number(process.env.SHIPROCKET_DEFAULT_BREADTH || 10)
const DEFAULT_HEIGHT = Number(process.env.SHIPROCKET_DEFAULT_HEIGHT || 10)
const DEFAULT_WEIGHT = Number(process.env.SHIPROCKET_DEFAULT_WEIGHT_KG || 0.5)

const estimateItemsWeight = (items: any[]): number => {
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

const estimateItemsDimensions = (items: any[]): {
  length: number
  breadth: number
  height: number
} => {
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

const analyzeItemsWeightAndDimensionSources = (items: any[]): {
  hasRealWeight: boolean
  hasRealDimensions: boolean
} => {
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
        const avg =
          second && !Number.isNaN(second) ? Math.round((first + second) / 2) : first
        const days = Math.max(1, avg)

        return { label: rawEta, days }
      }
    }

    return { label: rawEta, days: null }
  }

  return { label: null, days: null }
}

class ShiprocketProviderService extends AbstractFulfillmentProviderService {
  static identifier = "shiprocket"

  protected logger_: Logger
  protected options_: ShiprocketFulfillmentProviderOptions

  constructor({ logger }: InjectedDependencies, options: ShiprocketFulfillmentProviderOptions) {
    super()

    this.logger_ = logger
    this.options_ = options || {}
  }

  async getFulfillmentOptions(): Promise<FulfillmentOption[]> {
    return [
      { id: "shiprocket_standard", name: "Shiprocket Standard" } as any,
      { id: "shiprocket_express", name: "Shiprocket Express" } as any,
    ]
  }

  async canCalculate(_data: CreateShippingOptionDTO): Promise<boolean> {
    return true
  }

  async calculatePrice(
    optionData: CalculateShippingOptionPriceDTO["optionData"],
    data: CalculateShippingOptionPriceDTO["data"],
    context: CalculateShippingOptionPriceDTO["context"]
  ): Promise<CalculatedShippingOptionPrice> {
    // 1) Backwards-compatible override: if an explicit amount is provided
    //    on the shipping method or option data, respect it.
    const fromMethod = (data as any)?.shiprocket_amount
    const fromOption = (optionData as any)?.shiprocket_amount

    const explicitRaw =
      typeof fromMethod === "number"
        ? fromMethod
        : typeof fromOption === "number"
        ? fromOption
        : undefined

    if (typeof explicitRaw === "number" && Number.isFinite(explicitRaw)) {
      return {
        calculated_amount: explicitRaw,
        is_calculated_price_tax_inclusive: false,
      }
    }

    // 2) Dynamic calculation via Shiprocket serviceability API.
    const ctx: any = context || {}

    const fromLocation = ctx.from_location as
      | { address?: { postal_code?: string | null } }
      | undefined

    const cartLike = ctx.cart as
      | { subtotal?: { numeric?: number }; total?: { numeric?: number }; context?: any }
      | undefined

    const shippingAddress =
      (ctx.shipping_address as { postal_code?: string | null } | undefined) ||
      (cartLike as any)?.shipping_address

    // IMPORTANT: use the same pickup postcode as the legacy /store/shipping/rates
    // route so that calculated prices match the Shiprocket shipping rates that
    // are known to be correct in production. That route always uses
    // SHIPROCKET_PICKUP_POSTCODE from the environment.
    const pickupPostcode = process.env.SHIPROCKET_PICKUP_POSTCODE

    if (!pickupPostcode || !shippingAddress?.postal_code) {
      ;(this.logger_ as any)?.warn?.(
        "Shiprocket provider: missing pickup or shipping postal code, returning 0 price"
      )

      return {
        calculated_amount: 0,
        is_calculated_price_tax_inclusive: false,
      }
    }

    const items = (ctx.items as any[] | undefined) || (cartLike as any)?.items || []

    const totalWeight = estimateItemsWeight(items)

    const { length, breadth, height } = estimateItemsDimensions(items)

    const { hasRealWeight, hasRealDimensions } =
      analyzeItemsWeightAndDimensionSources(items)

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
      // Only dimensions are known; ensure a sensible weight.
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

    const declaredValueSource =
      (cartLike as any)?.subtotal?.numeric ?? (cartLike as any)?.total?.numeric

    const declaredValue =
      typeof declaredValueSource === "number" && declaredValueSource > 0
        ? declaredValueSource
        : undefined

    const rawBodyPayment =
      (typeof (data as any)?.payment_mode === "string" && (data as any).payment_mode) ||
      (typeof (data as any)?.payment_type === "string" && (data as any).payment_type) ||
      undefined

    const ctxObj = (cartLike as any)?.context as Record<string, any> | undefined

    const rawContextPayment =
      (typeof ctxObj?.payment_mode === "string" && ctxObj.payment_mode) ||
      (typeof ctxObj?.payment_type === "string" && ctxObj.payment_type) ||
      undefined

    const paymentHint = (rawBodyPayment || rawContextPayment || "").toString().toLowerCase()

    const isCod =
      paymentHint.includes("cod") ||
      paymentHint.includes("cash_on_delivery") ||
      paymentHint.includes("cash-on-delivery")

    const shiprocket = new ShiprocketService(this.logger_)

    const cartId = (cartLike as any)?.id || (ctx as any)?.cart_id || null

    ;(this.logger_ as any)?.info?.(
      "Shiprocket provider: calculatePrice serviceability payload " +
        JSON.stringify({
          cart_id: cartId,
          shipping_option_data: optionData,
          payment_hint: paymentHint,
          is_cod: isCod,
          pickup_postcode: pickupPostcode,
          delivery_postcode: shippingAddress.postal_code,
          weight: effectiveWeight,
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
      delivery_postcode: shippingAddress.postal_code as string,
      weight: effectiveWeight,
      // Use COD flag when payment mode indicates COD, otherwise prepaid.
      cod: isCod ? 1 : 0,
      length: lengthForApi,
      breadth: breadthForApi,
      height: heightForApi,
      declared_value: declaredValue,
    })

    if (
      !serviceability ||
      !Array.isArray((serviceability as any).courier_company) ||
      (serviceability as any).courier_company.length === 0
    ) {
      ;(this.logger_ as any)?.warn?.(
        "Shiprocket provider: calculatePrice received no courier companies for payload " +
          JSON.stringify({
            cart_id: cartId,
            pickup_postcode: pickupPostcode,
            delivery_postcode: shippingAddress.postal_code,
            weight: totalWeight,
            is_cod: isCod,
          })
      )

      return {
        calculated_amount: 0,
        is_calculated_price_tax_inclusive: false,
      }
    }

    const enriched = (serviceability as any).courier_company.map((courier: any) => {
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
      (e: any) => typeof e.rate === "number" && !Number.isNaN(e.rate) && e.rate >= 0
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

    const toAmount = (choice: (typeof enriched)[number] | null): number => {
      if (!choice) {
        return 0
      }

      const raw = choice.rate

      if (typeof raw === "number" && Number.isFinite(raw)) {
        // We treat Shiprocket's rate as the final major-unit amount (e.g. rupees).
        return Math.max(0, Math.round(raw))
      }

      return 0
    }

    // Determine whether this shipping option should use the "express" or
    // "standard" Shiprocket rate.
    //
    // Priority:
    // 1) Explicit flags on the option's data: shiprocket_mode or shipping_type
    // 2) Fallback to inspecting the option's data.id / data.name, so options
    //    named "Shiprocket Express" or with id "shiprocket_express" are
    //    automatically treated as express without extra JSON config.
    let modeRaw: string = "standard"

    const dataObj = (optionData || {}) as any

    if (typeof dataObj.shiprocket_mode === "string" && dataObj.shiprocket_mode) {
      modeRaw = dataObj.shiprocket_mode
    } else if (typeof dataObj.shipping_type === "string" && dataObj.shipping_type) {
      modeRaw = dataObj.shipping_type
    } else {
      const idOrName =
        (typeof dataObj.id === "string" && dataObj.id) ||
        (typeof dataObj.name === "string" && dataObj.name) ||
        ""

      const lower = idOrName.toString().toLowerCase()

      if (lower.includes("express")) {
        modeRaw = "express"
      } else {
        modeRaw = "standard"
      }
    }

    modeRaw = modeRaw.toLowerCase()

    const useExpress = modeRaw === "express"

    const amount = useExpress ? toAmount(expressChoice) : toAmount(standardChoice)

    ;(this.logger_ as any)?.info?.(
      "Shiprocket provider: calculatePrice aggregated result " +
        JSON.stringify({
          cart_id: cartId,
          shipping_option_data: optionData,
          payment_hint: paymentHint,
          is_cod: isCod,
          standard:
            standardChoice && {
              rate: standardChoice.rate,
              eta: standardChoice.etaLabel,
              eta_days: standardChoice.etaDays,
            },
          express:
            expressChoice && {
              rate: expressChoice.rate,
              eta: expressChoice.etaLabel,
              eta_days: expressChoice.etaDays,
            },
          mode: useExpress ? "express" : "standard",
          chosen_amount: amount,
        })
    )

    return {
      calculated_amount: amount,
      is_calculated_price_tax_inclusive: false,
    }
  }

  async createFulfillment(
    data: Record<string, unknown>,
    _items: Partial<Omit<FulfillmentItemDTO, "fulfillment">>[],
    _order: Partial<FulfillmentOrderDTO> | undefined,
    fulfillment: Partial<Omit<FulfillmentDTO, "provider_id" | "data" | "items">>
  ): Promise<CreateFulfillmentResult> {
    return {
      data: {
        ...(((fulfillment as any)?.data as object | undefined) || {}),
        ...data,
      },
      labels: [],
    }
  }

  async createReturnFulfillment(
    fulfillment: Record<string, unknown>
  ): Promise<CreateFulfillmentResult> {
    return { data: fulfillment, labels: [] }
  }

  async cancelFulfillment(_data: Record<string, unknown>): Promise<any> {
    return {}
  }

  async getFulfillmentDocuments(_data: any): Promise<never[]> {
    return []
  }

  async getReturnDocuments(_data: any): Promise<never[]> {
    return []
  }

  async getShipmentDocuments(_data: any): Promise<never[]> {
    return []
  }

  async retrieveDocuments(_fulfillmentData: any, _documentType: any): Promise<void> {
    return
  }

  async validateFulfillmentData(optionData: any, data: any, _context: any): Promise<any> {
    return {
      ...data,
      option: optionData,
    }
  }

  async validateOption(_data: any): Promise<boolean> {
    return true
  }
}

export default ShiprocketProviderService
