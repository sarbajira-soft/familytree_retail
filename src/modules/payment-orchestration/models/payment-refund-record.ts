import { model } from "@medusajs/framework/utils"

import { REFUND_RECORD_STATUSES } from "../constants"

const PaymentRefundRecord = model
  .define(
    {
      tableName: "razorpay_payment_refund_record",
      name: "RazorpayPaymentRefundRecord",
    },
    {
      id: model.id({ prefix: "rzref" }).primaryKey(),
      attempt_id: model.text().nullable(),
      order_id: model.text().nullable(),
      payment_id: model.text().nullable(),
      medusa_refund_id: model.text().nullable(),
      razorpay_refund_id: model.text().unique().nullable(),
      status: model.enum([...REFUND_RECORD_STATUSES]).default("pending"),
      refund_amount_minor: model.number(),
      currency_code: model.text(),
      raw_response: model.json().nullable(),
      last_error: model.text().nullable(),
      processed_at: model.dateTime().nullable(),
      metadata: model.json().nullable(),
    }
  )
  .indexes([
    {
      name: "IDX_razorpay_payment_refund_record_order",
      on: ["order_id", "status"],
    },
    {
      name: "IDX_razorpay_payment_refund_record_attempt",
      on: ["attempt_id"],
    },
    {
      name: "IDX_razorpay_payment_refund_record_payment",
      on: ["payment_id"],
    },
    {
      name: "IDX_razorpay_payment_refund_record_medusa_refund",
      on: ["medusa_refund_id"],
    },
  ])

export default PaymentRefundRecord
