import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import type { Logger } from "@medusajs/framework/types"
import { Modules } from "@medusajs/framework/utils"

/**
 * Create a shipping method for a cart with a dynamic amount.
 *
 * This is used to apply Shiprocket's calculated rate (or any per-cart
 * shipping amount) instead of the static price configured on the
 * Shipping Option.
 *
 * POST /store/shiprocket/shipping-method
 */
export const POST = async (req: MedusaRequest, res: MedusaResponse) => {
  const logger: Logger = req.scope.resolve("logger")
  const cartModuleService = req.scope.resolve(Modules.CART)

  const body = (req.body || {}) as any

  const cartId: string | undefined = body.cart_id
  const shippingOptionId: string | undefined = body.shipping_option_id
  const amountRaw = body.amount
  const data = (body.data || {}) as Record<string, unknown>

  const rawName: string | undefined =
    typeof body.name === "string" && body.name.trim().length
      ? (body.name as string)
      : undefined

  if (!cartId || !shippingOptionId) {
    return res.status(400).json({
      success: false,
      code: "MISSING_FIELDS",
      message: "cart_id and shipping_option_id are required",
    })
  }

  const hasAmount = typeof amountRaw === "number" && !Number.isNaN(amountRaw)
  const amount: number | undefined = hasAmount ? Number(amountRaw) : undefined

  try {
    // Ensure the cart exists first so we can return a full cart payload
    await cartModuleService.retrieveCart(cartId)

    const nameFromData =
      typeof (data as any).shipping_type === "string" && (data as any).shipping_type
        ? `Shiprocket ${(data as any).shipping_type}`
        : undefined

    const name = rawName || nameFromData || "Shiprocket shipping"

    const shippingMethod = await cartModuleService.addShippingMethods({
      cart_id: cartId,
      shipping_option_id: shippingOptionId,
      name,
      ...(typeof amount === "number" ? { amount } : {}),
      data,
    } as any)

    // Retrieve the updated cart so the frontend can refresh totals
    const cart = await cartModuleService.retrieveCart(cartId)

    return res.json({
      success: true,
      cart,
      shipping_method: shippingMethod,
    })
  } catch (e: any) {
    logger.error?.(
      `Shiprocket dynamic shipping method creation failed for cart ${cartId}: ${e?.message || "unknown error"}`,
      e
    )

    return res.status(500).json({
      success: false,
      code: "SHIPROCKET_SHIPPING_METHOD_ERROR",
      message:
        e?.message ||
        "Failed to create dynamic shipping method. Please try again or contact support.",
    })
  }
}
