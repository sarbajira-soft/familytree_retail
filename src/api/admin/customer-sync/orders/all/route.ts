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

    const page = Math.max(1, Number((req.query as any)?.page || 1))
    const limit = Math.min(100, Math.max(1, Number((req.query as any)?.limit || 25)))

    const q = String(((req.query as any)?.q ?? "") as any).trim()
    const status = String(((req.query as any)?.status ?? "") as any).trim()
    const payment = String(((req.query as any)?.payment ?? "") as any).trim()
    const fulfillment = String(((req.query as any)?.fulfillment ?? "") as any).trim()

    const baseFilters: Record<string, any> = {}
    if (status && status !== "completed" && status !== "canceled") baseFilters.status = [status]
    if (fulfillment && fulfillment !== "has_fulfillment") baseFilters.fulfillment_status = [fulfillment]

    // First: load lightweight candidate set (still potentially large) so we can:
    // - apply q filtering (email/customer_id/display_id/id/shiprocket metadata)
    // - compute an accurate count
    // - paginate newest-first reliably
    const { data: candidateData } = await query.graph({
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
        "email",
        "customer_id",
        "metadata",
        "payment_collections.payments.provider_id",
        "fulfillments.id",
      ],
      filters: baseFilters,
    })

    let candidates = Array.isArray(candidateData) ? [...candidateData] : []

    if (status === "completed") {
      candidates = candidates.filter((o: any) => Boolean(o?.completed_at))
    } else if (status === "canceled") {
      candidates = candidates.filter((o: any) => Boolean(o?.canceled_at))
    }

    if (payment) {
      const needle = payment.toLowerCase()
      candidates = candidates.filter((o: any) => {
        const pcs = Array.isArray(o?.payment_collections) ? o.payment_collections : []
        const paymentsRaw = []
        for (const pc of pcs) {
          const inner = (pc as any)?.payments
          if (Array.isArray(inner)) paymentsRaw.push(...inner)
        }
        const providers = paymentsRaw
          .map((p: any) => String(p?.provider_id || "").toLowerCase())
          .filter(Boolean)
        if (!providers.length) return false

        if (needle === "razorpay") return providers.some((p: string) => p.includes("razorpay"))
        if (needle === "system") return providers.some((p: string) => p.includes("system"))
        return providers.some((p: string) => p.includes(needle))
      })
    }

    if (fulfillment === "has_fulfillment") {
      candidates = candidates.filter((o: any) => {
        const fs = Array.isArray(o?.fulfillments) ? o.fulfillments : []
        return fs.length > 0
      })
    }

    if (q) {
      const needle = q.toLowerCase()
      candidates = candidates.filter((o: any) => {
        const m = o?.metadata && typeof o.metadata === "object" ? o.metadata : {}
        const awb = m?.shiprocket_awb_code ? String(m.shiprocket_awb_code) : ""
        const courier = m?.shiprocket_courier_name ? String(m.shiprocket_courier_name) : ""

        const hay = [
          o?.id,
          o?.display_id != null ? `#${String(o.display_id)}` : "",
          o?.email,
          o?.customer_id,
          awb,
          courier,
        ]
          .map((x) => String(x || "").toLowerCase())
          .join(" ")

        return hay.includes(needle)
      })
    }

    candidates.sort((a: any, b: any) => {
      const da = a?.created_at ? new Date(a.created_at).getTime() : 0
      const db = b?.created_at ? new Date(b.created_at).getTime() : 0
      return db - da
    })

    const count = candidates.length
    const start = (page - 1) * limit
    const end = start + limit
    const pageIds = candidates.slice(start, end).map((o: any) => o?.id).filter(Boolean)

    let orders: any[] = []
    if (pageIds.length) {
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
          "fulfillments.status",
        ],
        filters: {
          ...baseFilters,
          id: pageIds,
        },
      })

      const byId = new Map<string, any>()
      for (const o of Array.isArray(data) ? data : []) {
        if (o?.id) byId.set(String(o.id), o)
      }
      orders = pageIds.map((id: any) => byId.get(String(id))).filter(Boolean)
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
