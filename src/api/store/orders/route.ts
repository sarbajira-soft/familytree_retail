import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"

import { ContainerRegistrationKeys, MedusaError, Modules } from "@medusajs/framework/utils"

import { requireStoreCustomerId } from "./retail-helpers"

const ORDER_FIELDS = [
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
  "items.*",
  "items.variant.*",
  "shipping_address.*",
  "billing_address.*",
  "payment_collections.payment_sessions.*",
  "payment_collections.payments.*",
  "payments.*",
] as const

function normalizeOrderDirection(orderValue: string) {
  const raw = String(orderValue || "-created_at").trim()
  if (raw.startsWith("-")) {
    return { field: raw.slice(1), direction: "desc" as const }
  }

  return { field: raw || "created_at", direction: "asc" as const }
}

export const GET = async (req: MedusaRequest, res: MedusaResponse) => {
  const customerId = await requireStoreCustomerId(req)
  const customerModuleService: any = req.scope.resolve(Modules.CUSTOMER)
  const query = req.scope.resolve(ContainerRegistrationKeys.QUERY) as any

  const customer = await customerModuleService.retrieveCustomer(customerId).catch(() => null)
  const customerEmail = String(customer?.email || "").trim().toLowerCase()

  if (!customerEmail) {
    throw new MedusaError(MedusaError.Types.INVALID_DATA, "Authenticated customer email is required")
  }

  const limit = Math.min(100, Math.max(1, Number((req.query as any)?.limit || 50)))
  const offset = Math.max(0, Number((req.query as any)?.offset || 0))
  const { field: orderField, direction } = normalizeOrderDirection(
    String((req.query as any)?.order || "-created_at")
  )

  const [customerOrdersResponse, emailOrdersResponse] = await Promise.all([
    query.graph({
      entity: "order",
      fields: ["id", "created_at", "updated_at", "customer_id", "email"],
      filters: {
        customer_id: [customerId],
      },
    }),
    query.graph({
      entity: "order",
      fields: ["id", "created_at", "updated_at", "customer_id", "email"],
      filters: {
        email: [customerEmail],
      },
    }),
  ])

  const byId = new Map<string, any>()

  for (const order of Array.isArray(customerOrdersResponse?.data) ? customerOrdersResponse.data : []) {
    if (order?.id) {
      byId.set(String(order.id), order)
    }
  }

  for (const order of Array.isArray(emailOrdersResponse?.data) ? emailOrdersResponse.data : []) {
    if (order?.id) {
      byId.set(String(order.id), order)
    }
  }

  const candidates = [...byId.values()]

  candidates.sort((left: any, right: any) => {
    const leftValue =
      orderField === "updated_at"
        ? new Date(left?.updated_at || 0).getTime()
        : new Date(left?.created_at || 0).getTime()
    const rightValue =
      orderField === "updated_at"
        ? new Date(right?.updated_at || 0).getTime()
        : new Date(right?.created_at || 0).getTime()

    return direction === "asc" ? leftValue - rightValue : rightValue - leftValue
  })

  const count = candidates.length
  const pageIds = candidates.slice(offset, offset + limit).map((order: any) => order?.id).filter(Boolean)

  let orders: any[] = []
  if (pageIds.length) {
    const detailResponse = await query.graph({
      entity: "order",
      fields: [...ORDER_FIELDS],
      filters: {
        id: pageIds,
      },
    })

    const detailById = new Map<string, any>()
    for (const order of Array.isArray(detailResponse?.data) ? detailResponse.data : []) {
      if (order?.id) {
        detailById.set(String(order.id), order)
      }
    }

    orders = pageIds.map((id: string) => detailById.get(String(id))).filter(Boolean)
  }

  res.status(200).json({
    orders,
    count,
    offset,
    limit,
  })
}
