import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"

import { Modules, MedusaError } from "@medusajs/framework/utils"

import {
  asIsoDate,
  getOwnedOrder,
  listOrderCustomerRefundRequests,
  listOrderCustomerReturnRequests,
} from "../../retail-helpers"

type RequestItem = {
  id?: string
  item_id?: string
  quantity?: number
  reason_id?: string | null
  reason_label?: string | null
  note?: string | null
}

type RequestBody = {
  request_type?: "return" | "refund" | null
  items?: RequestItem[]
  note?: string | null
}

function getOrderItemIdentifiers(item: any) {
  return [
    item?.id,
    item?.item_id,
    item?.detail?.id,
    item?.detail?.item_id,
  ]
    .map((value) => String(value || "").trim())
    .filter(Boolean)
}

function normalizeRequestItems(order: any, bodyItems: RequestItem[]) {
  const orderItems = Array.isArray(order?.items) ? order.items : []
  const orderItemsById = new Map<
    string,
    {
      id: string
      title: string | null
      quantity: number
      sourceItem: any
    }
  >()

  orderItems.forEach((item: any) => {
    const normalizedItem = {
      id: String(item?.id || item?.item_id || item?.detail?.id || ""),
      title:
        (item?.title && String(item.title)) ||
        (item?.detail?.title && String(item.detail.title)) ||
        null,
      quantity: Number(item?.quantity || item?.detail?.quantity || 0),
      sourceItem: item,
    }

    getOrderItemIdentifiers(item).forEach((identifier) => {
      orderItemsById.set(identifier, normalizedItem)
    })
  })

  const normalized = bodyItems
    .map((item) => {
      const itemId = String(item?.id || item?.item_id || "").trim()
      const orderItem = itemId ? orderItemsById.get(itemId) : null

      if (!orderItem) {
        return null
      }

      const quantity = Number(item?.quantity || 0)
      if (!Number.isFinite(quantity) || quantity <= 0 || quantity > Number(orderItem.quantity || 0)) {
        return null
      }

      return {
        id: orderItem.id,
        item_id: orderItem.id,
        title: orderItem.title,
        quantity,
        reason_id: item?.reason_id ? String(item.reason_id) : null,
        reason_label: item?.reason_label ? String(item.reason_label) : null,
        note: item?.note ? String(item.note) : null,
      }
    })
    .filter(Boolean)

  return normalized
}

function hasOpenRequest(records: Array<{ status?: string | null }>) {
  return records.some((record) => {
    const status = String(record?.status || "").toLowerCase()
    return status && !["resolved", "rejected", "cancelled", "canceled", "processed"].includes(status)
  })
}

export const POST = async (req: MedusaRequest, res: MedusaResponse) => {
  const orderId = (req.params?.id || "").toString()
  const body = (req.body || {}) as RequestBody

  if (!orderId) {
    throw new MedusaError(MedusaError.Types.INVALID_DATA, "Order id is required")
  }

  const requestType = body.request_type === "refund" ? "refund" : "return"
  const order = await getOwnedOrder(req, orderId)
  const orderAny = order as any
  const metadata = (orderAny.metadata || {}) as Record<string, any>
  const orderStatus = String(orderAny.status || "").toLowerCase()
  const fulfillmentStatus = String(orderAny.fulfillment_status || "").toLowerCase()
  const paymentStatus = String(orderAny.payment_status || "").toLowerCase()

  if (orderStatus === "canceled" || orderStatus === "cancelled") {
    if (requestType !== "refund") {
      throw new MedusaError(
        MedusaError.Types.INVALID_DATA,
        "Cancelled orders cannot be submitted for return."
      )
    }
  }

  if (
    requestType === "return" &&
    !["delivered", "partially_delivered"].includes(fulfillmentStatus)
  ) {
    throw new MedusaError(
      MedusaError.Types.INVALID_DATA,
      "Return requests are only available after the order is delivered."
    )
  }

  if (
    requestType === "refund" &&
    !["captured", "paid", "partially_refunded", "refunded", "completed"].includes(paymentStatus)
  ) {
    throw new MedusaError(
      MedusaError.Types.INVALID_DATA,
      "Refund requests are only available for paid orders."
    )
  }

  const items = normalizeRequestItems(orderAny, Array.isArray(body.items) ? body.items : [])

  if (!items.length) {
    throw new MedusaError(
      MedusaError.Types.INVALID_DATA,
      `Please select at least one item to request a ${requestType}.`
    )
  }

  const existingRecords =
    requestType === "refund"
      ? listOrderCustomerRefundRequests(orderAny)
      : listOrderCustomerReturnRequests(orderAny)

  if (hasOpenRequest(existingRecords)) {
    throw new MedusaError(
      MedusaError.Types.INVALID_DATA,
      `A ${requestType} request is already under review for this order.`
    )
  }

  const createdAt = new Date().toISOString()
  const requestId = `${requestType}_req_${Date.now().toString(36)}`
  const amount = items.reduce((sum, item: any) => {
    const orderItem = (Array.isArray(orderAny.items) ? orderAny.items : []).find((candidate: any) =>
      getOrderItemIdentifiers(candidate).includes(String(item.item_id || ""))
    )

    const lineTotal = Number(orderItem?.total || 0)
    const lineQuantity = Math.max(1, Number(orderItem?.quantity || orderItem?.detail?.quantity || 1))
    const unitAmount = Math.round(lineTotal / lineQuantity)
    return sum + unitAmount * Number(item.quantity || 0)
  }, 0)

  const requestRecord = {
    id: requestId,
    type: requestType,
    status: "requested",
    created_at: createdAt,
    updated_at: createdAt,
    requested_at: createdAt,
    note: body.note ? String(body.note) : null,
    currency_code: orderAny.currency_code || null,
    amount,
    items,
    metadata: {
      source: "storefront",
      requested_from: "retail",
      order_display_id: orderAny.display_id || null,
    },
  }

  const orderModuleService = req.scope.resolve(Modules.ORDER) as any
  const metadataKey =
    requestType === "refund" ? "customer_refund_requests" : "customer_return_requests"
  const nextRecords = [...existingRecords, requestRecord]

  await orderModuleService.updateOrders(orderId, {
    metadata: {
      ...metadata,
      [metadataKey]: nextRecords,
      last_customer_request_at: createdAt,
      last_customer_request_type: requestType,
    },
  })

  res.status(200).json({
    request: {
      ...requestRecord,
      created_at: asIsoDate(requestRecord.created_at),
      updated_at: asIsoDate(requestRecord.updated_at),
      requested_at: asIsoDate(requestRecord.requested_at),
    },
    message:
      requestType === "refund"
        ? "Refund request submitted successfully."
        : "Return request submitted successfully.",
  })
}
