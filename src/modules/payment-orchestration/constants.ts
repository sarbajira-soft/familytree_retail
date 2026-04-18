export const PAYMENT_ORCHESTRATION_MODULE = "payment_orchestration"

export const RAZORPAY_PROVIDER_ID = "pp_razorpay_razorpay"

export const PAYMENT_ATTEMPT_STATUSES = [
  "pending",
  "pending_capture",
  "captured",
  "processing",
  "completed",
  "failed",
  "abandoned",
  "expired",
  "refunded",
  "partially_refunded",
] as const

export type PaymentAttemptStatus = (typeof PAYMENT_ATTEMPT_STATUSES)[number]

export const WEBHOOK_EVENT_STATUSES = [
  "received",
  "processing",
  "processed",
  "ignored",
  "failed",
] as const

export type WebhookEventStatus = (typeof WEBHOOK_EVENT_STATUSES)[number]

export const COMPLETION_JOB_STATUSES = [
  "pending",
  "processing",
  "completed",
  "dead",
] as const

export type CompletionJobStatus = (typeof COMPLETION_JOB_STATUSES)[number]

export const REFUND_RECORD_STATUSES = [
  "pending",
  "processed",
  "failed",
  "full",
  "partial",
] as const

export type RefundRecordStatus = (typeof REFUND_RECORD_STATUSES)[number]

export const PAYMENT_ACTIVE_STATUSES = [
  "pending",
  "pending_capture",
  "captured",
  "processing",
] as const

export const PAYMENT_TERMINAL_STATUSES = [
  "completed",
  "failed",
  "abandoned",
  "expired",
  "refunded",
  "partially_refunded",
] as const
