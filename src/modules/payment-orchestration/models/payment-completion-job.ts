import { model } from "@medusajs/framework/utils"

import { COMPLETION_JOB_STATUSES } from "../constants"

const PaymentCompletionJob = model
  .define(
    {
      tableName: "razorpay_payment_completion_job",
      name: "RazorpayPaymentCompletionJob",
    },
    {
      id: model.id({ prefix: "rzjob" }).primaryKey(),
      attempt_id: model.text().unique(),
      cart_id: model.text().index(),
      status: model.enum([...COMPLETION_JOB_STATUSES]).default("pending"),
      attempts: model.number().default(0),
      next_run_at: model.dateTime().nullable(),
      last_attempt_at: model.dateTime().nullable(),
      completed_at: model.dateTime().nullable(),
      last_error: model.text().nullable(),
      metadata: model.json().nullable(),
    }
  )
  .indexes([
    {
      name: "IDX_razorpay_payment_completion_job_next_run",
      on: ["status", "next_run_at"],
    },
  ])

export default PaymentCompletionJob
