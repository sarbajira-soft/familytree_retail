import type { Logger, OrderDTO } from "@medusajs/framework/types"
import type { AxiosInstance } from "axios"

import { ShiprocketTokenManager } from "../utils/shiprocket-token"

export type ShiprocketOrderMeta = {
  shiprocket_shipment_id?: number
  shiprocket_order_id?: number
  shiprocket_awb_code?: string
  shiprocket_courier_name?: string
}

export type ShiprocketOrderErrorMeta = {
  shiprocket_error_code?: string
  shiprocket_error_message?: string
}

export type ShiprocketOrderResult = ShiprocketOrderMeta & ShiprocketOrderErrorMeta

// Minimal subset of Shiprocket responses we care about
export type ShiprocketServiceabilityCourier = {
  courier_company_id: number
  courier_name: string
  estimated_delivery_days?: number | string
  rate?: number
  freight_charge?: number
}

export type ShiprocketServiceabilityResponse = {
  status: number
  // Normalized list of available courier companies.
  // Internally we map Shiprocket's data.available_courier_companies here.
  courier_company: ShiprocketServiceabilityCourier[]
}

export type ShiprocketOrderCreateResponse = {
  order_id: number
  shipment_id: number
}

export type ShiprocketAssignAwbResponse = {
  awb_assign_status: number
  response: {
    data: {
      awb_code: string
      courier_company_id: number
      courier_name: string
    }
  }
}

export class ShiprocketService {
  private logger: Logger
  private tokenManager: ShiprocketTokenManager

  private static serviceabilityCache = new Map<
    string,
    { ts: number; value: ShiprocketServiceabilityResponse | null }
  >()

  constructor(logger: Logger) {
    this.logger = logger
    this.tokenManager = ShiprocketTokenManager.getInstance()
  }

  private async getClient(): Promise<AxiosInstance> {
    return this.tokenManager.getAuthenticatedClient()
  }

  /**
   * Small helper to retry transient Shiprocket API calls.
   * Retries on network errors and 5xx responses, but not on most 4xx.
   */
  private async withRetry<T>(
    fn: () => Promise<T>,
    context: string,
    maxRetries = 2
  ): Promise<T> {
    let lastError: any

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        if (attempt > 0) {
          this.logger.warn?.(`Shiprocket ${context} retry (attempt ${attempt})`)
        }
        return await fn()
      } catch (e: any) {
        lastError = e
        const status = e?.response?.status as number | undefined

        // Do not retry on most client errors except 429 (rate limit)
        if (status && status < 500 && status !== 429) {
          break
        }

        if (attempt === maxRetries) {
          break
        }

        // Exponential backoff with small cap (in ms)
        const delayMs = Math.min(1000, 300 * (attempt + 1))
        await new Promise((resolve) => setTimeout(resolve, delayMs))
      }
    }

    this.logger.error?.(`Shiprocket ${context} failed after retries`, lastError)
    throw lastError
  }

  /**
   * Check courier availability between origin and destination pincodes
   * before creating an order.
   *
   * Shiprocket requires either an order_id OR the combination of
   * cod + weight. Since we're calling this before creating the order
   * in Shiprocket, we must always provide cod and weight here.
   */
  async checkServiceability(args: {
    pickup_postcode: string
    delivery_postcode: string
    weight: number
    cod?: boolean | 0 | 1
    length?: number
    breadth?: number
    height?: number
    declared_value?: number
    mode?: string
    is_return?: number
    couriers_type?: number
    only_local?: number
    qc_check?: number
  }): Promise<ShiprocketServiceabilityResponse | null> {
    const client = await this.getClient()

    const params: Record<string, any> = {
      pickup_postcode: args.pickup_postcode,
      delivery_postcode: args.delivery_postcode,
      weight: args.weight,
    }

    // Shiprocket: 1 for COD, 0 for Prepaid. Default to Prepaid (0)
    const rawCod = args.cod
    const codFlag =
      rawCod === 1 || rawCod === true
        ? 1
        : rawCod === 0 || rawCod === false
        ? 0
        : 0
    params.cod = codFlag

    const cacheKey = JSON.stringify({
      pickup_postcode: params.pickup_postcode,
      delivery_postcode: params.delivery_postcode,
      weight: params.weight,
      cod: params.cod,
      length: args.length,
      breadth: args.breadth,
      height: args.height,
      declared_value: args.declared_value,
      mode: args.mode,
      is_return: args.is_return,
      couriers_type: args.couriers_type,
      only_local: args.only_local,
      qc_check: args.qc_check,
    })

    const now = Date.now()
    const cached = ShiprocketService.serviceabilityCache.get(cacheKey)
    const CACHE_TTL_MS = 30_000

    if (cached && now - cached.ts < CACHE_TTL_MS) {
      return cached.value
    }

    if (typeof args.length === "number") params.length = args.length
    if (typeof args.breadth === "number") params.breadth = args.breadth
    if (typeof args.height === "number") params.height = args.height
    if (typeof args.declared_value === "number") params.declared_value = args.declared_value
    if (typeof args.mode === "string") params.mode = args.mode
    if (typeof args.is_return === "number") params.is_return = args.is_return
    if (typeof args.couriers_type === "number") params.couriers_type = args.couriers_type
    if (typeof args.only_local === "number") params.only_local = args.only_local
    if (typeof args.qc_check === "number") params.qc_check = args.qc_check

    try {
      const { data } = await this.withRetry(
        () =>
          client.get<ShiprocketServiceabilityResponse>(
            "/v1/external/courier/serviceability/",
            {
              params,
            }
          ),
        "serviceability"
      )

      if (!data || (data as any).status !== 200) {
        this.logger.warn?.("Shiprocket serviceability check returned non-200 status")
        return null
      }

      const raw: any = data

      let companies: any[] | undefined = raw.courier_company

      // Shiprocket currently returns available couriers under
      // data.available_courier_companies. Normalize that here so
      // downstream code can always rely on courier_company.
      if (!Array.isArray(companies) && raw.data?.available_courier_companies) {
        const fromAvailable = raw.data.available_courier_companies
        if (Array.isArray(fromAvailable)) {
          companies = fromAvailable
        }
      }

      const normalized: ShiprocketServiceabilityResponse = {
        status: Number(raw.status ?? 0),
        courier_company: Array.isArray(companies) ? companies : [],
      }

      // Debug log: what Shiprocket actually returned for this
      // serviceability check. This helps us understand why
      // standard/express aggregation may result in identical
      // prices/ETAs.
      this.logger.info?.(
        "Shiprocket serviceability: normalized response " +
          JSON.stringify({
            params,
            status: normalized.status,
            courier_count: normalized.courier_company.length,
            courier_company: normalized.courier_company,
          })
      )

      ShiprocketService.serviceabilityCache.set(cacheKey, {
        ts: Date.now(),
        value: normalized,
      })

      return normalized
    } catch (e: any) {
      this.logger.error?.("Shiprocket serviceability check failed", e)
      return null
    }
  }

  private formatOrderDate(date: Date | string): string {
    const d = new Date(date)

    const year = d.getFullYear()
    const month = String(d.getMonth() + 1).padStart(2, "0")
    const day = String(d.getDate()).padStart(2, "0")
    const hours = String(d.getHours()).padStart(2, "0")
    const minutes = String(d.getMinutes()).padStart(2, "0")
    const seconds = String(d.getSeconds()).padStart(2, "0")

    // Shiprocket examples use "YYYY-MM-DD HH:mm" format. Including seconds is
    // tolerated by their API and keeps the value precise.
    return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`
  }

  private mapCountryForShiprocket(code?: string | null): string | undefined {
    if (!code) {
      return undefined
    }

    const upper = code.toUpperCase()

    // Shiprocket examples typically use full country names, at least for India.
    if (upper === "IN") {
      return "India"
    }

    // Fallback to ISO code in upper case if we don't have a specific mapping.
    return upper
  }

  private inferPaymentMethod(order: OrderDTO): "Prepaid" | "COD" {
  /**
   * 1️⃣ STRONGEST SIGNAL — payment_status
   * If Medusa says it's paid/authorized, it IS prepaid.
   */
  const shippingMethods = (order as any).shipping_methods as any[] | undefined

  if (Array.isArray(shippingMethods) && shippingMethods.length > 0) {
    for (const sm of shippingMethods) {
      const data = (sm as any).data as Record<string, any> | undefined
      if (!data) continue

      const shippingHintRaw =
        (typeof data.payment_type === "string" && data.payment_type) ||
        (typeof data.payment_mode === "string" && data.payment_mode) ||
        (typeof data.payment_method === "string" && data.payment_method) ||
        undefined

      if (!shippingHintRaw) continue

      const lower = shippingHintRaw.toLowerCase()

      if (
        lower.includes("cod") ||
        lower.includes("cash_on_delivery") ||
        lower.includes("cash-on-delivery")
      ) {
        return "COD"
      }

      if (
        lower.includes("razorpay") ||
        lower.includes("online") ||
        lower.includes("prepaid") ||
        lower.includes("card") ||
        lower.includes("upi")
      ) {
        return "Prepaid"
      }
    }
  }

  const context = (order as any).context as Record<string, any> | undefined

  const contextHintRaw =
    (typeof context?.payment_type === "string" && context.payment_type) ||
    (typeof context?.payment_mode === "string" && context.payment_mode) ||
    (typeof context?.payment_method === "string" && context.payment_method) ||
    undefined

  if (contextHintRaw) {
    const lower = contextHintRaw.toLowerCase()

    if (
      lower.includes("cod") ||
      lower.includes("cash_on_delivery") ||
      lower.includes("cash-on-delivery")
    ) {
      return "COD"
    }

    if (
      lower.includes("razorpay") ||
      lower.includes("online") ||
      lower.includes("prepaid") ||
      lower.includes("card") ||
      lower.includes("upi")
    ) {
      return "Prepaid"
    }
  }

  const paymentStatus = ((order as any).payment_status || "").toLowerCase()

  if (
    [
      "captured",
      "paid",
      "completed",
      "succeeded",
      "partially_captured",
      "partially_paid",
    ].includes(paymentStatus)
  ) {
    return "Prepaid"
  }

  /**
   * 3️⃣ MEDUSA v2 — transactions (MOST RELIABLE after payment_status)
   */
  const transactions = (order as any).transactions as any[] | undefined

  if (Array.isArray(transactions) && transactions.length > 0) {
    const hasPaidTransaction = transactions.some((tx) => {
      const status = (tx.status || "").toLowerCase()
      return [
        "captured",
        "paid",
        "succeeded",
        "completed",
        "partially_captured",
        "partially_paid",
      ].includes(status)
    })

    if (hasPaidTransaction) {
      return "Prepaid"
    }
  }

  /**
   * 4️⃣ LEGACY / v1 SUPPORT — payments (optional safety net)
   */
  const payments: any[] = []

  const paymentCollections = ((order as any).payment_collections || []) as Array<
    { payments?: any[] } | undefined
  >

  for (const pc of paymentCollections) {
    if (pc?.payments && Array.isArray(pc.payments)) {
      payments.push(...pc.payments)
    }
  }

  const legacyPayments = (order as any).payments as any[] | undefined
  if (Array.isArray(legacyPayments) && legacyPayments.length > 0) {
    payments.push(...legacyPayments)
  }

  if (payments.length > 0) {
    const hasOnlineProvider = payments.some((p) => {
      const provider = (p as any).provider_id as string | undefined
      if (!provider) return false

      const lower = provider.toLowerCase()
      return (
        lower.includes("razorpay") ||
        lower.includes("stripe") ||
        lower.includes("online") ||
        lower.includes("card") ||
        lower.includes("upi")
      )
    })

    if (hasOnlineProvider) {
      return "Prepaid"
    }

    const hasCaptured = payments.some((p) => {
      const status = ((p as any).status || "").toLowerCase()
      return (
        (p as any).captured_at ||
        [
          "captured",
          "succeeded",
          "completed",
          "paid",
          "partially_captured",
          "partially_paid",
        ].includes(status)
      )
    })

    if (hasCaptured) {
      return "Prepaid"
    }

    return "COD"
  }

  /**
   * 5️⃣ FINAL FALLBACK
   * If nothing clearly indicates COD, treat as Prepaid.
   * This avoids misclassifying online payments as COD in Shiprocket.
   */
  return "Prepaid"
}


  /**
   * Create a Shiprocket order + shipment from a Medusa OrderDTO.
   *
   * IMPORTANT:
   * - This method only creates the Shiprocket order & shipment.
   * - AWB assignment is handled separately (e.g. when admin fulfills items)
   *   via `assignAwb`.
   */
  async createShipmentForOrder(order: OrderDTO): Promise<ShiprocketOrderResult | null> {
    const client = await this.getClient()

    const billing = order.billing_address
    const shipping = order.shipping_address || billing

    if (!shipping?.postal_code || !shipping?.country_code) {
      const message =
        "Missing shipping postal_code/country_code, cannot create Shiprocket order"
      this.logger.warn?.(`Order ${order.id}: ${message}`)
      return {
        shiprocket_error_code: "INVALID_ADDRESS",
        shiprocket_error_message: message,
      }
    }

    const pickupPostcode = process.env.SHIPROCKET_PICKUP_POSTCODE
    const pickupLocation = process.env.SHIPROCKET_PICKUP_LOCATION

    if (!pickupPostcode || !pickupLocation) {
      const message =
        "Shiprocket pickup configuration missing (SHIPROCKET_PICKUP_POSTCODE / SHIPROCKET_PICKUP_LOCATION)"
      this.logger.warn?.(message)
      return {
        shiprocket_error_code: "MISSING_PICKUP_CONFIG",
        shiprocket_error_message: message,
      }
    }

    const meta = (order as any).metadata as Record<string, any> | undefined

    let totalWeight = this.estimateOrderWeight(order)

    const weightOverrideRaw = meta?.shiprocket_weight_kg
    if (weightOverrideRaw !== undefined && weightOverrideRaw !== null) {
      const parsed = Number(weightOverrideRaw)
      if (Number.isFinite(parsed) && parsed > 0) {
        totalWeight = parsed
      }
    }

    const paymentMethod = this.inferPaymentMethod(order)
    const isPrepaid = paymentMethod === "Prepaid"

    let { length, breadth, height } = this.estimateOrderDimensions(order)

    const lengthOverrideRaw = meta?.shiprocket_length_cm
    if (lengthOverrideRaw !== undefined && lengthOverrideRaw !== null) {
      const parsed = Number(lengthOverrideRaw)
      if (Number.isFinite(parsed) && parsed > 0) {
        length = parsed
      }
    }

    const breadthOverrideRaw = meta?.shiprocket_breadth_cm
    if (breadthOverrideRaw !== undefined && breadthOverrideRaw !== null) {
      const parsed = Number(breadthOverrideRaw)
      if (Number.isFinite(parsed) && parsed > 0) {
        breadth = parsed
      }
    }

    const heightOverrideRaw = meta?.shiprocket_height_cm
    if (heightOverrideRaw !== undefined && heightOverrideRaw !== null) {
      const parsed = Number(heightOverrideRaw)
      if (Number.isFinite(parsed) && parsed > 0) {
        height = parsed
      }
    }

    const declaredRaw = Number((order as any).total ?? order.subtotal ?? 0)
    const declaredValue = Number.isFinite(declaredRaw)
      ? Math.round(declaredRaw)
      : 0

    const shippingRaw = Number((order as any).shipping_total ?? 0)
    const shippingCharges = Number.isFinite(shippingRaw)
      ? Math.round(shippingRaw)
      : 0

    const discountRaw = Number((order as any).discount_total ?? 0)
    const totalDiscount = Number.isFinite(discountRaw)
      ? Math.round(discountRaw)
      : 0

    const serviceability = await this.checkServiceability({
      pickup_postcode: pickupPostcode,
      delivery_postcode: shipping.postal_code,
      weight: totalWeight,
      cod: isPrepaid ? 0 : 1,
      length,
      breadth,
      height,
      declared_value: declaredValue > 0 ? declaredValue : undefined,
    })

    if (!serviceability) {
      const message = `Shiprocket serviceability check failed or returned null for order ${order.id}`
      this.logger.warn?.(message)
      return {
        shiprocket_error_code: "SERVICEABILITY_ERROR",
        shiprocket_error_message: message,
      }
    }

    if (!serviceability.courier_company || serviceability.courier_company.length === 0) {
      const message = `No Shiprocket courier available for order ${order.id} from ${pickupPostcode} to ${shipping.postal_code}`
      this.logger.info?.(message)
      return {
        shiprocket_error_code: "NO_COURIER_AVAILABLE",
        shiprocket_error_message: message,
      }
    }

    const lineItems = (order.items || []).map((item) => {
      const quantity = typeof item.quantity === "number" && item.quantity > 0 ? item.quantity : 1
      const totalRaw = Number((item as any).total ?? (item as any).subtotal ?? 0)
      const unitRaw = Number(
        (item as any).unit_price ?? (item as any).original_price ?? 0
      )

      const effectiveTotal =
        totalRaw > 0 ? totalRaw : unitRaw > 0 ? unitRaw * quantity : 0

      const perUnit =
        quantity > 0 ? Math.round(effectiveTotal / quantity) : Math.round(effectiveTotal)

      return {
        name: item.title,
        sku: item.variant_sku || item.id,
        units: quantity,
        selling_price: perUnit,
        discount: 0,
        tax: 0,
      }
    })

    const itemsTotal = lineItems.reduce((sum, li) => {
      const units = Number((li as any).units ?? 0) || 0
      const price = Number((li as any).selling_price ?? 0) || 0
      return sum + units * price
    }, 0)

    const billingCountry = this.mapCountryForShiprocket(
      billing?.country_code || shipping.country_code
    )
    const shippingCountry = this.mapCountryForShiprocket(shipping.country_code)

    const subTotal = itemsTotal - totalDiscount > 0
      ? itemsTotal - totalDiscount
      : itemsTotal > 0
      ? itemsTotal
      : 1

    const payableAmount =
      itemsTotal + shippingCharges - totalDiscount > 0
        ? itemsTotal + shippingCharges - totalDiscount
        : subTotal

    const collectableAmount = isPrepaid ? 0 : payableAmount

    const payload: any = {
      // Use Medusa order ID so we can reliably map Shiprocket webhooks back.
      order_id: order.id,
      order_date: this.formatOrderDate(order.created_at),
      pickup_location: pickupLocation,
      comment: "Medusa order",
      billing_customer_name: billing?.first_name || shipping.first_name,
      billing_last_name: billing?.last_name || shipping.last_name,
      billing_address: billing?.address_1 || shipping.address_1,
      billing_address_2: billing?.address_2 || shipping.address_2,
      billing_city: billing?.city || shipping.city,
      billing_pincode: billing?.postal_code || shipping.postal_code,
      billing_state: billing?.province || shipping.province,
      billing_country: billingCountry,
      billing_email: order.email,
      billing_phone: billing?.phone || shipping.phone,
      shipping_is_billing: !!(billing && shipping && billing.id === shipping.id),
      shipping_customer_name: shipping.first_name,
      shipping_last_name: shipping.last_name,
      shipping_address: shipping.address_1,
      shipping_address_2: shipping.address_2,
      shipping_city: shipping.city,
      shipping_pincode: shipping.postal_code,
      shipping_country: shippingCountry,
      shipping_state: shipping.province,
      shipping_email: order.email,
      shipping_phone: shipping.phone,
      order_items: lineItems,
      payment_method: paymentMethod,
      collectable_amount: collectableAmount,
      shipping_charges: shippingCharges,
      giftwrap_charges: 0,
      transaction_charges: 0,
      total_discount: totalDiscount,
      sub_total: subTotal,
      length,
      breadth,
      height,
      weight: totalWeight,
    }

    this.logger.info?.(
      `Shiprocket payment mapping for order ${order.id}: payment_status=${String(
        (order as any).payment_status || "n/a"
      )}, inferred=${paymentMethod}, is_prepaid=${isPrepaid}, collectable_amount=${collectableAmount}`
    )

    try {
      const { data: orderRes } = await this.withRetry(
        () =>
          client.post<ShiprocketOrderCreateResponse>(
            "/v1/external/orders/create/adhoc",
            payload
          ),
        "order-create"
      )

      if (!orderRes?.shipment_id) {
        const message =
          "Shiprocket order creation did not return shipment_id"
        this.logger.error?.(message, orderRes as any)
        return {
          shiprocket_error_code: "ORDER_CREATE_FAILED",
          shiprocket_error_message: message,
        }
      }

      // At this point the Shiprocket order exists. We only return the
      // core identifiers here; AWB will be assigned later.
      const baseMeta: ShiprocketOrderResult = {
        shiprocket_shipment_id: orderRes.shipment_id,
        shiprocket_order_id: orderRes.order_id,
      }

      return baseMeta
    } catch (e: any) {
      const errPayload = e?.response?.data || e
      this.logger.error?.("Shiprocket order creation failed", errPayload)
      return {
        shiprocket_error_code: "SHIPROCKET_API_ERROR",
        shiprocket_error_message:
          typeof errPayload === "string"
            ? errPayload
            : JSON.stringify(errPayload),
      }
    }
  }

  /**
   * Approximate weight in kg for the order.
   * If item weight metadata exists, sum it, otherwise fall back to product/variant
   * weight (in grams) or a configured default.
   */
  private estimateOrderWeight(order: OrderDTO): number {
    const defaultWeight = Number(process.env.SHIPROCKET_DEFAULT_WEIGHT_KG || 0.5)

    let total = 0

    for (const item of order.items || []) {
      const qty =
        typeof item.quantity === "number" && item.quantity > 0 ? item.quantity : 1

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
          typeof variantWeightRaw === "number"
            ? variantWeightRaw
            : Number(variantWeightRaw)
        const productWeightNum =
          typeof productWeightRaw === "number"
            ? productWeightRaw
            : Number(productWeightRaw)

        const grams =
          variantWeightNum && Number.isFinite(variantWeightNum) && variantWeightNum > 0
            ? variantWeightNum
            : productWeightNum &&
              Number.isFinite(productWeightNum) &&
              productWeightNum > 0
            ? productWeightNum
            : 0

        if (grams > 0) {
          perUnit = grams / 1000
        }
      }

      if (!perUnit || !Number.isFinite(perUnit) || perUnit <= 0) {
        perUnit = defaultWeight
      }

      total += perUnit * qty
    }

    return total || defaultWeight
  }

  private estimateOrderDimensions(order: OrderDTO): {
    length: number
    breadth: number
    height: number
  } {
    const defaultLength = Number(process.env.SHIPROCKET_DEFAULT_LENGTH || 10)
    const defaultBreadth = Number(process.env.SHIPROCKET_DEFAULT_BREADTH || 10)
    const defaultHeight = Number(process.env.SHIPROCKET_DEFAULT_HEIGHT || 10)

    let maxLength = 0
    let maxBreadth = 0
    let maxHeight = 0

    const parse = (value: any): number => {
      const num = typeof value === "number" ? value : Number(value)
      return Number.isFinite(num) && num > 0 ? num : 0
    }

    for (const item of order.items || []) {
      const meta = (item as any).metadata as Record<string, any> | undefined
      const variant = (item as any).variant as any | undefined
      const product = (variant as any)?.product || (item as any).product

      const lengthCandidates = [
        meta?.length_cm,
        (variant as any)?.length,
        (product as any)?.length,
      ]
      const widthCandidates = [
        meta?.breadth_cm,
        (variant as any)?.width,
        (product as any)?.width,
      ]
      const heightCandidates = [
        meta?.height_cm,
        (variant as any)?.height,
        (product as any)?.height,
      ]

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
    }

    return {
      length: maxLength || defaultLength,
      breadth: maxBreadth || defaultBreadth,
      height: maxHeight || defaultHeight,
    }
  }

  /**
   * Assigns an AWB to an existing Shiprocket shipment.
   */
  async assignAwb(
    shipmentId: number
  ): Promise<{
    awb_code?: string
    courier_name?: string
    error_code?: string
    error_message?: string
  } | null> {
    const client = await this.getClient()

    try {
      const { data: awbRes } = await this.withRetry(
        () =>
          client.post<ShiprocketAssignAwbResponse>(
            "/v1/external/courier/assign/awb",
            {
              shipment_id: shipmentId,
            }
          ),
        "assign-awb",
        4
      )

      const awbData = awbRes?.response?.data as any

      if (!awbData?.awb_code) {
        const detailedMessage =
          (awbRes as any)?.message ||
          awbData?.awb_assign_error ||
          "Shiprocket AWB assignment did not return awb_code"

        this.logger.error?.(detailedMessage, awbRes as any)
        return {
          error_code: "AWB_ASSIGN_FAILED",
          error_message: detailedMessage,
        }
      }

      return {
        awb_code: awbData.awb_code,
        courier_name: awbData.courier_name,
      }
    } catch (e: any) {
      const errPayload = e?.response?.data || e
      this.logger.error?.("Shiprocket AWB assignment failed", errPayload)
      return {
        error_code: "SHIPROCKET_API_ERROR",
        error_message:
          typeof errPayload === "string"
            ? errPayload
            : JSON.stringify(errPayload),
      }
    }
  }

  async schedulePickup(
    shipmentIds: number[]
  ): Promise<{
    success: boolean
    error_code?: string
    error_message?: string
  } | null> {
    if (!shipmentIds.length) {
      return {
        success: false,
        error_code: "NO_SHIPMENT_IDS",
        error_message: "No shipment ids provided for pickup generation",
      }
    }

    const client = await this.getClient()

    try {
      await this.withRetry(
        () =>
          client.post("/v1/external/courier/generate/pickup", {
            shipment_id: shipmentIds,
          }),
        "generate-pickup"
      )

      return {
        success: true,
      }
    } catch (e: any) {
      const errPayload = e?.response?.data || e
      this.logger.error?.("Shiprocket pickup generation failed", errPayload)
      return {
        success: false,
        error_code: "SHIPROCKET_API_ERROR",
        error_message:
          typeof errPayload === "string"
            ? errPayload
            : JSON.stringify(errPayload),
      }
    }
  }

  /**
   * Track shipment by AWB code.
   */
  async trackAwb(awb_code: string): Promise<any | null> {
    const client = await this.getClient()

    try {
      const { data } = await this.withRetry(
        () => client.get(`/v1/external/courier/track/awb/${awb_code}`),
        "track-awb"
      )
      return data
    } catch (e: any) {
      this.logger.error?.("Shiprocket track AWB failed", e?.response?.data || e)
      return null
    }
  }

  /**
   * Generate a shipping label PDF for one or more Shiprocket shipments.
   *
   * Shiprocket's API expects an object with a `shipment_id` array and
   * returns a PDF URL for the label. We try to extract `label_url` from
   * the response, but also return meaningful error metadata if we
   * cannot find it.
   */
  async generateLabel(
    shipmentIds: number[]
  ): Promise<{
    label_url?: string
    error_code?: string
    error_message?: string
  } | null> {
    if (!shipmentIds.length) {
      return {
        error_code: "NO_SHIPMENT_IDS",
        error_message: "No shipment ids provided for label generation",
      }
    }

    const client = await this.getClient()

    try {
      const { data } = await this.withRetry(
        () =>
          client.post(
            "/v1/external/courier/generate/label",
            {
              shipment_id: shipmentIds,
            }
          ),
        "generate-label"
      )

      const raw: any = data

      const labelUrl: string | undefined =
        (raw && typeof raw.label_url === "string" && raw.label_url) ||
        (Array.isArray(raw?.label_url) && typeof raw.label_url[0] === "string"
          ? raw.label_url[0]
          : undefined) ||
        (Array.isArray(raw) && typeof raw[0]?.label_url === "string"
          ? raw[0].label_url
          : undefined)

      if (!labelUrl) {
        this.logger.warn?.(
          `Shiprocket label generation did not return a label_url (raw=${JSON.stringify(
            raw
          )})`
        )
        return {
          error_code: "LABEL_URL_NOT_FOUND",
          error_message: "Shiprocket label generation did not return label_url",
        }
      }

      return {
        label_url: labelUrl,
      }
    } catch (e: any) {
      const errPayload = e?.response?.data || e
      this.logger.error?.("Shiprocket label generation failed", errPayload)
      return {
        error_code: "SHIPROCKET_API_ERROR",
        error_message:
          typeof errPayload === "string"
            ? errPayload
            : JSON.stringify(errPayload),
      }
    }
  }

  /**
   * Generate an invoice PDF URL for one or more Shiprocket orders.
   *
   * Shiprocket expects an object with an `ids` array containing order ids
   * and returns a PDF URL for the invoice.
   */
  async generateInvoice(
    orderIds: number[]
  ): Promise<{
    invoice_url?: string
    error_code?: string
    error_message?: string
  } | null> {
    if (!orderIds.length) {
      return {
        error_code: "NO_ORDER_IDS",
        error_message: "No order ids provided for invoice generation",
      }
    }

    const client = await this.getClient()

    try {
      const { data } = await this.withRetry(
        () =>
          client.post("/v1/external/orders/print/invoice", {
            ids: orderIds,
          }),
        "generate-invoice"
      )

      const raw: any = data

      const invoiceUrl: string | undefined =
        (raw && typeof raw.invoice_url === "string" && raw.invoice_url) ||
        (Array.isArray(raw?.invoice_url) && typeof raw.invoice_url[0] === "string"
          ? raw.invoice_url[0]
          : undefined) ||
        (typeof raw?.url === "string" ? raw.url : undefined) ||
        (Array.isArray(raw) && typeof raw[0]?.invoice_url === "string"
          ? raw[0].invoice_url
          : undefined) ||
        (Array.isArray(raw) && typeof raw[0]?.url === "string"
          ? raw[0].url
          : undefined)

      if (!invoiceUrl) {
        this.logger.warn?.(
          `Shiprocket invoice generation did not return an invoice_url (raw=${JSON.stringify(
            raw
          )})`
        )
        return {
          error_code: "INVOICE_URL_NOT_FOUND",
          error_message:
            "Shiprocket invoice generation did not return invoice_url",
        }
      }

      return {
        invoice_url: invoiceUrl,
      }
    } catch (e: any) {
      const errPayload = e?.response?.data || e
      this.logger.error?.("Shiprocket invoice generation failed", errPayload)
      return {
        error_code: "SHIPROCKET_API_ERROR",
        error_message:
          typeof errPayload === "string"
            ? errPayload
            : JSON.stringify(errPayload),
      }
    }
  }
}
