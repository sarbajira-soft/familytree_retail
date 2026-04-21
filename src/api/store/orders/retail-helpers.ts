import type { MedusaRequest } from "@medusajs/framework/http"

import { getOrderDetailWorkflow } from "@medusajs/core-flows"
import {
  ContainerRegistrationKeys,
  MedusaError,
  Modules,
  remoteQueryObjectFromString,
} from "@medusajs/framework/utils"

import { PAYMENT_ORCHESTRATION_MODULE } from "../../../modules/payment-orchestration/constants"

const ORDER_FIELDS = [
  "id",
  "customer_id",
  "status",
  "payment_status",
  "fulfillment_status",
  "display_id",
  "currency_code",
  "total",
  "subtotal",
  "tax_total",
  "shipping_total",
  "email",
  "metadata",
  "created_at",
  "updated_at",
  "items",
  "items.detail",
  "items.variant",
  "items.variant.product",
  "shipping_address",
  "billing_address",
  "shipping_methods",
  "payment_collections",
] as const

export async function requireStoreCustomerId(req: MedusaRequest) {
  const customerId = ((req as any).auth_context?.actor_id || "").toString()

  if (!customerId) {
    throw new MedusaError(
      MedusaError.Types.UNAUTHORIZED,
      "You must be logged in to access this order."
    )
  }

  return customerId
}

export async function getOwnedOrder(
  req: MedusaRequest,
  orderId: string,
  extraFields: string[] = []
) {
  const customerId = await requireStoreCustomerId(req)
  const customerModuleService: any = req.scope.resolve(Modules.CUSTOMER)
  const workflow = getOrderDetailWorkflow(req.scope)

  const { result } = await workflow.run({
    input: {
      fields: [...ORDER_FIELDS, ...extraFields],
      order_id: orderId,
      filters: {
        is_draft_order: false,
      },
    },
  })

  const orderCustomerId =
    ((result as any)?.customer_id || (result as any)?.customer?.id || "").toString()
  const orderEmail = String((result as any)?.email || "").trim().toLowerCase()

  let customerEmail = ""
  try {
    const customer = await customerModuleService.retrieveCustomer(customerId)
    customerEmail = String(customer?.email || "").trim().toLowerCase()
  } catch {
    customerEmail = ""
  }

  const matchesCustomerById = orderCustomerId && orderCustomerId === customerId
  const matchesCustomerByEmail =
    !orderCustomerId && orderEmail && customerEmail && orderEmail === customerEmail

  if (!result || (!matchesCustomerById && !matchesCustomerByEmail)) {
    throw new MedusaError(MedusaError.Types.NOT_FOUND, "Order not found")
  }

  return result
}

export async function listOrderReturns(req: MedusaRequest, orderId: string) {
  const remoteQuery = req.scope.resolve(ContainerRegistrationKeys.REMOTE_QUERY) as any

  const queryObject = remoteQueryObjectFromString({
    entryPoint: "returns",
    variables: {
      filters: {
        order_id: orderId,
      },
      limit: 50,
      offset: 0,
    },
    fields: [
      "id",
      "order_id",
      "display_id",
      "status",
      "refund_amount",
      "created_at",
      "updated_at",
      "requested_at",
      "received_at",
      "canceled_at",
      "metadata",
      "items.*",
      "items.reason.*",
    ],
  })

  const result = await remoteQuery(queryObject)
  return Array.isArray(result?.rows) ? result.rows : []
}

export async function listOrderRefundRecords(req: MedusaRequest, orderId: string) {
  const orchestration = req.scope.resolve(PAYMENT_ORCHESTRATION_MODULE) as any

  if (!orchestration?.listPaymentRefundRecords) {
    return []
  }

  const records = await orchestration.listPaymentRefundRecords(
    {
      order_id: orderId,
    },
    {
      order: {
        created_at: "DESC",
      },
      take: 50,
    }
  )

  return Array.isArray(records) ? records : []
}

export function sortTimelineEntries<T extends { at?: string | null }>(entries: T[]) {
  return [...entries].sort((a, b) => {
    const left = a?.at ? new Date(a.at).getTime() : 0
    const right = b?.at ? new Date(b.at).getTime() : 0
    return right - left
  })
}

export function asIsoDate(value: unknown) {
  if (!value) {
    return null
  }

  const date = new Date(String(value))
  return Number.isNaN(date.getTime()) ? null : date.toISOString()
}

type CustomerOrderRequestType = "return" | "refund"

export type CustomerOrderRequestRecord = {
  id: string
  type: CustomerOrderRequestType
  status: string
  created_at: string | null
  updated_at: string | null
  requested_at: string | null
  note: string | null
  currency_code: string | null
  amount: number | null
  metadata: Record<string, any> | null
  items: Array<{
    id: string
    item_id: string | null
    title: string | null
    quantity: number
    reason_id: string | null
    reason_label: string | null
    reason: {
      label: string | null
      value: string | null
    } | null
    note: string | null
  }>
}

function normalizeRequestRecords(
  rawValue: unknown,
  type: CustomerOrderRequestType
): CustomerOrderRequestRecord[] {
  if (!Array.isArray(rawValue)) {
    return []
  }

  return rawValue
    .map((entry: any, index) => {
      const metadata =
        entry?.metadata && typeof entry.metadata === "object" && !Array.isArray(entry.metadata)
          ? entry.metadata
          : null

      const items = Array.isArray(entry?.items)
        ? entry.items
            .map((item: any, itemIndex: number) => ({
              id:
                (item?.id || item?.item_id || `${String(entry?.id || index)}:${String(itemIndex)}`).toString(),
              item_id: item?.item_id ? String(item.item_id) : null,
              title: item?.title ? String(item.title) : null,
              quantity: Number(item?.quantity || 0),
              reason_id: item?.reason_id ? String(item.reason_id) : null,
              reason_label: item?.reason_label ? String(item.reason_label) : null,
              reason:
                item?.reason_label || item?.reason_id
                  ? {
                      label: item?.reason_label ? String(item.reason_label) : null,
                      value: item?.reason_id ? String(item.reason_id) : null,
                    }
                  : null,
              note: item?.note ? String(item.note) : null,
            }))
            .filter((item) => item.item_id && Number.isFinite(item.quantity) && item.quantity > 0)
        : []

      return {
        id: (entry?.id || `${type}_request_${index + 1}`).toString(),
        type,
        status: String(entry?.status || "requested"),
        created_at: asIsoDate(entry?.created_at),
        updated_at: asIsoDate(entry?.updated_at),
        requested_at: asIsoDate(entry?.requested_at || entry?.created_at),
        note: entry?.note ? String(entry.note) : null,
        currency_code: entry?.currency_code ? String(entry.currency_code) : null,
        amount:
          entry?.amount === undefined || entry?.amount === null
            ? null
            : Number(entry.amount || 0),
        metadata,
        items,
      } satisfies CustomerOrderRequestRecord
    })
    .filter(Boolean)
}

export function listOrderCustomerReturnRequests(order: any) {
  const metadata = ((order as any)?.metadata || {}) as Record<string, any>
  return normalizeRequestRecords(metadata.customer_return_requests, "return")
}

export function listOrderCustomerRefundRequests(order: any) {
  const metadata = ((order as any)?.metadata || {}) as Record<string, any>
  return normalizeRequestRecords(metadata.customer_refund_requests, "refund")
}
