import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { ContainerRegistrationKeys } from "@medusajs/framework/utils"

type ResponseBody = {
  success: boolean
  orders?: any[]
  count?: number
  page?: number
  limit?: number
  message?: string
}

export const AUTHENTICATE = false

export async function GET(req: MedusaRequest, res: MedusaResponse<ResponseBody>) {
  try {
    const query = req.scope.resolve(ContainerRegistrationKeys.QUERY)

    const customerId = String((req.query as any)?.customer_id || "").trim()
    if (!customerId) {
      res.status(400).json({ success: false, message: "customer_id is required" })
      return
    }

    const page = Math.max(1, Number((req.query as any)?.page || 1))
    const limit = Math.min(100, Math.max(1, Number((req.query as any)?.limit || 25)))
    const offset = (page - 1) * limit

    const { data } = await query.graph({
      entity: "order",
      fields: [
        "id",
        "display_id",
        "status",
        "payment_status",
        "fulfillment_status",
        "completed_at",
        "canceled_at",
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
        "payment_collections.payments.provider_id",
        "payment_collections.payments.status",
        "fulfillments.id",
        "fulfillments.status",
      ],
      filters: {
        customer_id: [customerId],
      },
      pagination: {
        skip: offset,
        take: limit,
      },
    })

    const orders = Array.isArray(data) ? data : []

    // Best-effort: count via graph without pagination. If it fails, omit count.
    let count: number | undefined = undefined
    try {
      const { data: countData } = await query.graph({
        entity: "order",
        fields: ["id"],
        filters: { customer_id: [customerId] },
      })
      count = Array.isArray(countData) ? countData.length : 0
    } catch {
      // ignore
    }

    res.status(200).json({
      success: true,
      orders,
      count,
      page,
      limit,
    })
  } catch (e: any) {
    res.status(400).json({
      success: false,
      message: e?.message || "Failed to list orders",
    })
  }
}
