import { MedusaService } from "@medusajs/framework/utils"

import type { InferEntityType } from "@medusajs/framework/types"

import PaymentAttempt from "./models/payment-attempt"
import PaymentCompletionJob from "./models/payment-completion-job"
import PaymentRefundRecord from "./models/payment-refund-record"
import PaymentWebhookEvent from "./models/payment-webhook-event"
import type {
  CompletionJobStatus,
  PaymentAttemptStatus,
  RefundRecordStatus,
  WebhookEventStatus,
} from "./constants"

class PaymentOrchestrationModuleService extends MedusaService({
  PaymentAttempt,
  PaymentCompletionJob,
  PaymentWebhookEvent,
  PaymentRefundRecord,
}) {
  async patchAttempt(id: string, data: Partial<InferEntityType<typeof PaymentAttempt>>) {
    return await this.updatePaymentAttempts({
      id,
      ...data,
    })
  }

  async patchWebhookEvent(
    id: string,
    data: Partial<InferEntityType<typeof PaymentWebhookEvent>>
  ) {
    return await this.updatePaymentWebhookEvents({
      id,
      ...data,
    })
  }

  async patchCompletionJob(
    id: string,
    data: Partial<InferEntityType<typeof PaymentCompletionJob>>
  ) {
    return await this.updatePaymentCompletionJobs({
      id,
      ...data,
    })
  }

  async patchRefundRecord(
    id: string,
    data: Partial<InferEntityType<typeof PaymentRefundRecord>>
  ) {
    return await this.updatePaymentRefundRecords({
      id,
      ...data,
    })
  }

  async getActiveAttemptForCart(cartId: string) {
    const attempts = await this.listPaymentAttempts(
      {
        cart_id: cartId,
        active: true,
      },
      {
        order: {
          created_at: "DESC",
        },
        take: 1,
      }
    )

    return attempts[0] || null
  }

  async getAttemptByOrderId(razorpayOrderId: string) {
    const attempts = await this.listPaymentAttempts(
      {
        razorpay_order_id: razorpayOrderId,
      },
      {
        take: 1,
      }
    )

    return attempts[0] || null
  }

  async getAttemptBySessionId(paymentSessionId: string) {
    const attempts = await this.listPaymentAttempts(
      {
        payment_session_id: paymentSessionId,
      },
      {
        order: {
          created_at: "DESC",
        },
        take: 1,
      }
    )

    return attempts[0] || null
  }

  async getLatestAttemptByPaymentCollectionId(paymentCollectionId: string) {
    const attempts = await this.listPaymentAttempts(
      {
        payment_collection_id: paymentCollectionId,
      },
      {
        order: {
          created_at: "DESC",
        },
        take: 1,
      }
    )

    return attempts[0] || null
  }

  async deactivateOtherAttempts(cartId: string, exceptId?: string) {
    const attempts = await this.listPaymentAttempts({
      cart_id: cartId,
      active: true,
    })

    const updates = attempts
      .filter((attempt) => attempt.id !== exceptId)
      .map((attempt) => ({
        id: attempt.id,
        active: false,
      }))

    if (!updates.length) {
      return []
    }

    return await this.updatePaymentAttempts(updates)
  }

  async createWebhookEventIfAbsent(data: {
    event_id: string
    event_type: string
    provider_id?: string
    cart_id?: string | null
    payment_session_id?: string | null
    razorpay_order_id?: string | null
    payload?: Record<string, unknown> | null
    metadata?: Record<string, unknown> | null
  }) {
    const existing = await this.listPaymentWebhookEvents(
      {
        event_id: data.event_id,
      },
      {
        take: 1,
      }
    )

    if (existing[0]) {
      return existing[0]
    }

    return await this.createPaymentWebhookEvents({
      event_id: data.event_id,
      event_type: data.event_type,
      provider_id: data.provider_id,
      cart_id: data.cart_id ?? null,
      payment_session_id: data.payment_session_id ?? null,
      razorpay_order_id: data.razorpay_order_id ?? null,
      payload: data.payload ?? null,
      metadata: data.metadata ?? null,
    })
  }

  async updateWebhookEventStatus(
    id: string,
    status: WebhookEventStatus,
    patch: Partial<InferEntityType<typeof PaymentWebhookEvent>> = {}
  ) {
    return await this.patchWebhookEvent(id, {
      status,
      ...patch,
    })
  }

  async getCompletionJobByAttemptId(attemptId: string) {
    const jobs = await this.listPaymentCompletionJobs(
      {
        attempt_id: attemptId,
      },
      {
        take: 1,
      }
    )

    return jobs[0] || null
  }

  async upsertCompletionJob(data: {
    attempt_id: string
    cart_id: string
    status?: CompletionJobStatus
    attempts?: number
    next_run_at?: Date | null
    last_attempt_at?: Date | null
    completed_at?: Date | null
    last_error?: string | null
    metadata?: Record<string, unknown> | null
  }) {
    const existing = await this.getCompletionJobByAttemptId(data.attempt_id)

    if (existing) {
      return await this.patchCompletionJob(existing.id, {
        cart_id: data.cart_id,
        status: data.status ?? existing.status,
        attempts: data.attempts ?? existing.attempts,
        next_run_at:
          typeof data.next_run_at === "undefined"
            ? existing.next_run_at
            : data.next_run_at,
        last_attempt_at:
          typeof data.last_attempt_at === "undefined"
            ? existing.last_attempt_at
            : data.last_attempt_at,
        completed_at:
          typeof data.completed_at === "undefined"
            ? existing.completed_at
            : data.completed_at,
        last_error:
          typeof data.last_error === "undefined"
            ? existing.last_error
            : data.last_error,
        metadata:
          typeof data.metadata === "undefined"
            ? existing.metadata
            : data.metadata,
      })
    }

    return await this.createPaymentCompletionJobs({
      attempt_id: data.attempt_id,
      cart_id: data.cart_id,
      status: data.status ?? "pending",
      attempts: data.attempts ?? 0,
      next_run_at: data.next_run_at ?? null,
      last_attempt_at: data.last_attempt_at ?? null,
      completed_at: data.completed_at ?? null,
      last_error: data.last_error ?? null,
      metadata: data.metadata ?? null,
    })
  }

  async listRunnableCompletionJobs(now: Date, limit = 20) {
    return await this.listPaymentCompletionJobs(
      {
        status: ["pending", "processing"],
        next_run_at: {
          $lte: now,
        },
      },
      {
        order: {
          next_run_at: "ASC",
        },
        take: limit,
      }
    )
  }

  async upsertRefundRecord(data: {
    attempt_id?: string | null
    order_id?: string | null
    payment_id?: string | null
    medusa_refund_id?: string | null
    razorpay_refund_id?: string | null
    status?: RefundRecordStatus
    refund_amount_minor: number
    currency_code: string
    raw_response?: Record<string, unknown> | null
    last_error?: string | null
    processed_at?: Date | null
    metadata?: Record<string, unknown> | null
  }) {
    let existing: any = null

    if (data.razorpay_refund_id) {
      const refundRecords = await this.listPaymentRefundRecords(
        {
          razorpay_refund_id: data.razorpay_refund_id,
        },
        {
          take: 1,
        }
      )

      existing = refundRecords[0] || null
    }

    if (existing) {
      return await this.patchRefundRecord(existing.id, {
        attempt_id:
          typeof data.attempt_id === "undefined"
            ? existing.attempt_id
            : data.attempt_id,
        order_id:
          typeof data.order_id === "undefined" ? existing.order_id : data.order_id,
        payment_id:
          typeof data.payment_id === "undefined"
            ? existing.payment_id
            : data.payment_id,
        medusa_refund_id:
          typeof data.medusa_refund_id === "undefined"
            ? existing.medusa_refund_id
            : data.medusa_refund_id,
        status: data.status ?? existing.status,
        refund_amount_minor: data.refund_amount_minor,
        currency_code: data.currency_code,
        raw_response:
          typeof data.raw_response === "undefined"
            ? existing.raw_response
            : data.raw_response,
        last_error:
          typeof data.last_error === "undefined"
            ? existing.last_error
            : data.last_error,
        processed_at:
          typeof data.processed_at === "undefined"
            ? existing.processed_at
            : data.processed_at,
        metadata:
          typeof data.metadata === "undefined"
            ? existing.metadata
            : data.metadata,
      })
    }

    return await this.createPaymentRefundRecords({
      attempt_id: data.attempt_id ?? null,
      order_id: data.order_id ?? null,
      payment_id: data.payment_id ?? null,
      medusa_refund_id: data.medusa_refund_id ?? null,
      razorpay_refund_id: data.razorpay_refund_id ?? null,
      status: data.status ?? "pending",
      refund_amount_minor: data.refund_amount_minor,
      currency_code: data.currency_code,
      raw_response: data.raw_response ?? null,
      last_error: data.last_error ?? null,
      processed_at: data.processed_at ?? null,
      metadata: data.metadata ?? null,
    })
  }

  async listRecoverableAttempts(now: Date, limit = 50) {
    return await this.listPaymentAttempts(
      {
        active: true,
        status: ["pending", "pending_capture", "captured", "processing"],
        expires_at: {
          $gte: now,
        },
      },
      {
        order: {
          updated_at: "ASC",
        },
        take: limit,
      }
    )
  }

  async listExpiredAttempts(now: Date, limit = 50) {
    return await this.listPaymentAttempts(
      {
        active: true,
        status: ["pending", "pending_capture"],
        expires_at: {
          $lte: now,
        },
      },
      {
        order: {
          expires_at: "ASC",
        },
        take: limit,
      }
    )
  }

  async updateAttemptState(
    id: string,
    status: PaymentAttemptStatus,
    patch: Partial<InferEntityType<typeof PaymentAttempt>> = {}
  ) {
    return await this.patchAttempt(id, {
      status,
      ...patch,
    })
  }
}

export default PaymentOrchestrationModuleService
