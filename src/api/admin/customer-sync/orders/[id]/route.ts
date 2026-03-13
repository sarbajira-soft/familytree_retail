import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { ContainerRegistrationKeys } from "@medusajs/framework/utils"

type ResponseBody = {
  success: boolean
  order?: any
  message?: string
}

export const AUTHENTICATE = false

export async function GET(req: MedusaRequest, res: MedusaResponse<ResponseBody>) {
  try {
    const query = req.scope.resolve(ContainerRegistrationKeys.QUERY)

    const id = (req.params as any)?.id as string | undefined
    if (!id) {
      res.status(400).json({ success: false, message: "Missing order id" })
      return
    }

    const { data } = await query.graph({
      entity: "order",
      fields: [
        "id",
        "display_id",
        "status",
        "payment_status",
        "fulfillment_status",
        "created_at",
        "updated_at",
        "currency_code",
        "total",
        "subtotal",
        "shipping_total",
        "tax_total",
        "discount_total",
        "email",
        "customer_id",
        "metadata",
        "payment_collections.*",
        "payment_collections.id",
        "payment_collections.created_at",
        "payment_collections.updated_at",
        "payment_collections.amount",
        "payment_collections.currency_code",
        "payment_collections.status",
        "payment_collections.payments.*",
        "payment_collections.payments.id",
        "payment_collections.payments.provider_id",
        "payment_collections.payments.status",
        "payment_collections.payments.amount",
        "payment_collections.payments.captured_amount",
        "payment_collections.payments.currency_code",
        "payment_collections.payments.created_at",
        "payment_collections.payments.updated_at",
        "payment_collections.payments.data",
        "fulfillments.*",
        "shipping_address.*",
        "billing_address.*",
        "items.*",
        "items.variant_id",
        "items.variant_sku",
        "shipping_methods.*",
        "shipping_methods.data",
      ],
      filters: {
        id: [id],
      },
    })

    const order = Array.isArray(data) ? data[0] : null

    if (!order) {
      res.status(404).json({ success: false, message: "Order not found" })
      return
    }

    res.status(200).json({ success: true, order })
  } catch (e: any) {
    res.status(400).json({
      success: false,
      message: e?.message || "Failed to retrieve order",
    })
  }
}
