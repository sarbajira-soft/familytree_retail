import { model } from "@medusajs/framework/utils"

import { PAYMENT_ATTEMPT_STATUSES } from "../constants"

const PaymentAttempt = model
  .define(
    {
      tableName: "razorpay_payment_attempt",
      name: "RazorpayPaymentAttempt",
    },
    {
      id: model.id({ prefix: "rzpat" }).primaryKey(),
      cart_id: model.text().index(),
      payment_collection_id: model.text().nullable(),
      payment_session_id: model.text().nullable(),
      razorpay_order_id: model.text().unique().nullable(),
      razorpay_payment_id: model.text().nullable(),
      order_id: model.text().nullable(),
      provider_id: model.text().default("pp_razorpay_razorpay"),
      status: model.enum([...PAYMENT_ATTEMPT_STATUSES]).default("pending"),
      currency_code: model.text(),
      expected_amount_minor: model.number(),
      payment_amount_minor: model.number().nullable(),
      active: model.boolean().default(true),
      expires_at: model.dateTime().nullable(),
      completed_at: model.dateTime().nullable(),
      last_synced_at: model.dateTime().nullable(),
      last_failed_at: model.dateTime().nullable(),
      last_error: model.text().nullable(),
      metadata: model.json().nullable(),
    }
  )
  .indexes([
    {
      name: "IDX_razorpay_payment_attempt_cart_status",
      on: ["cart_id", "status"],
    },
    {
      name: "IDX_razorpay_payment_attempt_active",
      on: ["cart_id", "active"],
    },
    {
      name: "IDX_razorpay_payment_attempt_collection",
      on: ["payment_collection_id"],
    },
    {
      name: "IDX_razorpay_payment_attempt_session",
      on: ["payment_session_id"],
    },
    {
      name: "IDX_razorpay_payment_attempt_payment",
      on: ["razorpay_payment_id"],
    },
    {
      name: "IDX_razorpay_payment_attempt_order",
      on: ["order_id"],
    },
  ])

export default PaymentAttempt
