import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"

import {
  asIsoDate,
  getOwnedOrder,
  listOrderCustomerRefundRequests,
  listOrderCustomerReturnRequests,
  listOrderRefundRecords,
  listOrderReturns,
  sortTimelineEntries,
} from "../../retail-helpers"

export const GET = async (req: MedusaRequest, res: MedusaResponse) => {
  const orderId = (req.params?.id || "").toString()
  const order = await getOwnedOrder(req, orderId)
  const orderAny = order as any
  const metadata = (orderAny.metadata || {}) as Record<string, any>
  const returnRequests = listOrderCustomerReturnRequests(orderAny)
  const refundRequests = listOrderCustomerRefundRequests(orderAny)

  const [returns, refundRecords] = await Promise.all([
    listOrderReturns(req, orderId),
    listOrderRefundRecords(req, orderId),
  ])

  const refunds = refundRecords.map((record: any) => ({
    id: record.id,
    payment_id: record.payment_id || null,
    medusa_refund_id: record.medusa_refund_id || null,
    razorpay_refund_id: record.razorpay_refund_id || null,
    status: record.status || "pending",
    refund_amount_minor: record.refund_amount_minor || 0,
    currency_code: record.currency_code || orderAny.currency_code || "INR",
    processed_at: asIsoDate(record.processed_at),
    created_at: asIsoDate(record.created_at),
    note:
      typeof record?.metadata?.note === "string" ? record.metadata.note : null,
    raw_response: record.raw_response || null,
  }))

  const normalizedReturns = returns.map((orderReturn: any) => ({
    id: orderReturn.id,
    display_id: orderReturn.display_id || null,
    status: orderReturn.status || "open",
    refund_amount: orderReturn.refund_amount || 0,
    created_at: asIsoDate(orderReturn.created_at),
    requested_at: asIsoDate(orderReturn.requested_at),
    received_at: asIsoDate(orderReturn.received_at),
    canceled_at: asIsoDate(orderReturn.canceled_at),
    metadata: orderReturn.metadata || null,
    items: Array.isArray(orderReturn.items)
      ? orderReturn.items.map((item: any) => ({
          id: item.id,
          item_id: item.item_id || null,
          quantity: item.quantity || 0,
          note: item.note || null,
          reason: item.reason
            ? {
                id: item.reason.id,
                label: item.reason.label || item.reason.value || null,
                value: item.reason.value || null,
              }
            : null,
        }))
      : [],
  }))

  const refundTotalMinor = refunds.reduce(
    (sum, refund) => sum + Number(refund.refund_amount_minor || 0),
    0
  )

  const timeline = sortTimelineEntries(
    [
      {
        id: `order:${orderAny.id}:placed`,
        type: "order_placed",
        label: "Order placed",
        at: asIsoDate(orderAny.created_at),
        description: `Order ${orderAny.display_id || orderAny.id} was created.`,
      },
      ((orderAny.payment_status || "").toLowerCase() === "captured" ||
      (orderAny.payment_status || "").toLowerCase() === "paid"
        ? {
            id: `order:${orderAny.id}:paid`,
            type: "payment_confirmed",
            label: "Payment confirmed",
            at: asIsoDate(orderAny.updated_at) || asIsoDate(orderAny.created_at),
            description: "Payment was captured successfully.",
          }
        : null),
      (metadata.shiprocket_order_id || metadata.shiprocket_shipment_id
        ? {
            id: `order:${orderAny.id}:shiprocket-created`,
            type: "shipment_booked",
            label: "Shipment booked",
            at:
              asIsoDate(metadata.shiprocket_last_sync_at) ||
              asIsoDate(orderAny.updated_at) ||
              asIsoDate(orderAny.created_at),
            description: "The order was sent to the delivery partner for shipment processing.",
          }
        : null),
      (metadata.shiprocket_cancel_status === "cancelled"
        ? {
            id: `order:${orderAny.id}:shiprocket-cancelled`,
            type: "shipment_cancelled",
            label: "Shipment cancelled",
            at:
              asIsoDate(metadata.shiprocket_cancelled_at) ||
              asIsoDate(metadata.shiprocket_last_cancel_attempt_at),
            description: "The delivery-partner shipment was cancelled successfully.",
          }
        : null),
      (metadata.shiprocket_cancel_status === "cancel_failed"
        ? {
            id: `order:${orderAny.id}:shiprocket-cancel-failed`,
            type: "shipment_cancellation_pending",
            label: "Shipment cancellation pending",
            at: asIsoDate(metadata.shiprocket_last_cancel_attempt_at),
            description:
              "Shipment cancellation is being retried with the delivery partner.",
          }
        : null),
      (metadata.shiprocket_cancel_status === "blocked"
        ? {
            id: `order:${orderAny.id}:shiprocket-cancel-blocked`,
            type: "shipment_cancellation_blocked",
            label: "Shipment cancellation blocked",
            at: asIsoDate(metadata.shiprocket_last_cancel_attempt_at),
            description:
              "Shipment cancellation could not be completed automatically because the shipment already progressed.",
          }
        : null),
      ((orderAny.status || "").toLowerCase() === "canceled" ||
      (orderAny.status || "").toLowerCase() === "cancelled"
        ? {
            id: `order:${orderAny.id}:cancelled`,
            type: "order_cancelled",
            label: "Order cancelled",
            at:
              asIsoDate(metadata.customer_cancelled_at) ||
              asIsoDate(orderAny.updated_at),
            description: "The order was cancelled.",
          }
        : null),
      ...normalizedReturns.flatMap((orderReturn) => {
        const entries = [
          {
            id: `return:${orderReturn.id}:created`,
            type: "return_created",
            label: "Return created",
            at: orderReturn.created_at,
            description: `Return ${orderReturn.display_id || orderReturn.id} was created.`,
          },
        ]

        if (orderReturn.requested_at) {
          entries.push({
            id: `return:${orderReturn.id}:requested`,
            type: "return_requested",
            label: "Return requested",
            at: orderReturn.requested_at,
            description: "Your return request was submitted.",
          })
        }

        if (orderReturn.received_at) {
          entries.push({
            id: `return:${orderReturn.id}:received`,
            type: "return_received",
            label: "Return received",
            at: orderReturn.received_at,
            description: "Returned items were received by the store.",
          })
        }

        if (orderReturn.canceled_at) {
          entries.push({
            id: `return:${orderReturn.id}:cancelled`,
            type: "return_cancelled",
            label: "Return cancelled",
            at: orderReturn.canceled_at,
            description: "The return request was cancelled.",
          })
        }

        return entries
      }),
      ...returnRequests.map((request) => ({
        id: `customer-return-request:${request.id}`,
        type: "customer_return_request",
        label: "Return requested",
        at: request.requested_at || request.created_at,
        description: "Your return request is under review.",
      })),
      ...refundRequests.map((request) => ({
        id: `customer-refund-request:${request.id}`,
        type: "customer_refund_request",
        label: "Refund requested",
        at: request.requested_at || request.created_at,
        description: "Your refund request is under review.",
      })),
      ...refunds.map((refund) => ({
        id: `refund:${refund.id}`,
        type: "refund_processed",
        label: "Refund processed",
        at: refund.processed_at || refund.created_at,
        description:
          refund.status === "partial"
            ? "A partial refund was processed."
            : "A refund was processed.",
      })),
    ].filter(Boolean) as Array<{
      id: string
      type: string
      label: string
      at?: string | null
      description?: string
    }>
  )

  res.status(200).json({
    order_id: orderAny.id,
    refunds,
    returns: normalizedReturns,
    return_requests: returnRequests,
    refund_requests: refundRequests,
    invoice: {
      order_id: orderAny.id,
      display_id: orderAny.display_id || null,
      currency_code: orderAny.currency_code || null,
      total: orderAny.total || 0,
      subtotal: orderAny.subtotal || 0,
      tax_total: orderAny.tax_total || 0,
      shipping_total: orderAny.shipping_total || 0,
      refund_total_minor: refundTotalMinor,
      shiprocket_invoice_url: metadata.shiprocket_invoice_url || null,
      shiprocket_label_url: metadata.shiprocket_label_url || null,
      shiprocket_tracking_url: metadata.shiprocket_tracking_url || null,
      updated_at: asIsoDate(orderAny.updated_at),
    },
    timeline,
  })
}
