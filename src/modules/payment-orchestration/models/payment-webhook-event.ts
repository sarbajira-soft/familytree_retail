import { model } from "@medusajs/framework/utils"

import { WEBHOOK_EVENT_STATUSES } from "../constants"

const PaymentWebhookEvent = model
  .define(
    {
      tableName: "razorpay_webhook_event",
      name: "RazorpayWebhookEvent",
    },
    {
      id: model.id({ prefix: "rzwe" }).primaryKey(),
      event_id: model.text().unique(),
      event_type: model.text(),
      provider_id: model.text().default("pp_razorpay_razorpay"),
      status: model.enum([...WEBHOOK_EVENT_STATUSES]).default("received"),
      cart_id: model.text().nullable(),
      payment_session_id: model.text().nullable(),
      razorpay_order_id: model.text().nullable(),
      payload: model.json().nullable(),
      processed_at: model.dateTime().nullable(),
      failed_at: model.dateTime().nullable(),
      failure_reason: model.text().nullable(),
      metadata: model.json().nullable(),
    }
  )
  .indexes([
    {
      name: "IDX_razorpay_webhook_event_type",
      on: ["event_type", "status"],
    },
    {
      name: "IDX_razorpay_webhook_event_cart",
      on: ["cart_id"],
    },
    {
      name: "IDX_razorpay_webhook_event_session",
      on: ["payment_session_id"],
    },
    {
      name: "IDX_razorpay_webhook_event_order",
      on: ["razorpay_order_id"],
    },
  ])

export default PaymentWebhookEvent
