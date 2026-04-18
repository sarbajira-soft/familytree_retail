import Razorpay from "razorpay"
import crypto from "crypto"

import {
  addShippingMethodToCartWorkflow,
  completeCartWorkflowId,
  createPaymentCollectionForCartWorkflowId,
  createPaymentSessionsWorkflow,
  listShippingOptionsForCartWithPricingWorkflow,
  processPaymentWorkflowId,
} from "@medusajs/core-flows"
import type {
  Logger,
  MedusaContainer,
  PaymentDTO,
} from "@medusajs/framework/types"
import {
  ContainerRegistrationKeys,
  MedusaError,
  Modules,
  PaymentActions,
} from "@medusajs/framework/utils"

import PaymentOrchestrationModuleService from "../modules/payment-orchestration/service"
import {
  PAYMENT_ACTIVE_STATUSES,
  PAYMENT_ORCHESTRATION_MODULE,
  RAZORPAY_PROVIDER_ID,
} from "../modules/payment-orchestration/constants"

type SyncResult = {
  status:
    | "not_started"
    | "pending"
    | "pending_capture"
    | "processing"
    | "completed"
    | "failed"
    | "expired"
    | "abandoned"
  cart_id: string
  order?: Record<string, unknown> | null
  attempt?: Record<string, unknown> | null
  message?: string
}

type VerifyInput = {
  paymentCollectionId?: string
  razorpayOrderId?: string
  razorpayPaymentId?: string
  razorpaySignature?: string
}

const ZERO_DECIMAL_CURRENCIES = new Set([
  "BIF",
  "CLP",
  "DJF",
  "GNF",
  "JPY",
  "KMF",
  "KRW",
  "MGA",
  "PYG",
  "RWF",
  "UGX",
  "VND",
  "VUV",
  "XAF",
  "XOF",
  "XPF",
])

function getCurrencyDecimals(code: string) {
  return ZERO_DECIMAL_CURRENCIES.has((code || "").toUpperCase()) ? 0 : 2
}

function toMinorUnit(amount: number, currencyCode: string) {
  const decimals = getCurrencyDecimals(currencyCode)
  return Math.round(amount * Math.pow(10, decimals))
}

function resolveNumericAmount(value: unknown): number {
  if (typeof value === "number") {
    return value
  }

  if (typeof value === "string") {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : 0
  }

  if (value && typeof value === "object") {
    const candidate = (value as Record<string, unknown>).numeric
    if (typeof candidate === "number") {
      return candidate
    }
    if (typeof candidate === "string") {
      const parsed = Number(candidate)
      return Number.isFinite(parsed) ? parsed : 0
    }
  }

  return 0
}

function computeRetryDelaySeconds(attempts: number) {
  const baseSeconds = Number(process.env.RAZORPAY_COMPLETION_RETRY_BASE_SECONDS || 30)
  const maxSeconds = Number(process.env.RAZORPAY_COMPLETION_RETRY_MAX_SECONDS || 900)
  return Math.min(baseSeconds * Math.pow(2, Math.max(attempts - 1, 0)), maxSeconds)
}

function computeAttemptExpiry() {
  const expiryMinutes = Number(process.env.RAZORPAY_CART_EXPIRY_MINUTES || 20)
  return new Date(Date.now() + expiryMinutes * 60 * 1000)
}

function getWebhookEventId(body: any) {
  if (body?.event_id) {
    return String(body.event_id)
  }

  const paymentId =
    body?.payload?.payment?.entity?.id ||
    body?.payload?.payment?.entity?.entity_id ||
    "unknown"
  const eventType = body?.event || "unknown"
  const createdAt = body?.created_at || "unknown"

  return `${eventType}:${paymentId}:${createdAt}`
}

export class RazorpayPaymentOrchestrator {
  private readonly logger_: Logger
  private readonly paymentModule_: any
  private readonly cartModule_: any
  private readonly orderModule_: any
  private readonly workflowEngine_: any
  private readonly query_: any
  private readonly orchestrationModule_: PaymentOrchestrationModuleService
  private readonly razorpay_: InstanceType<typeof Razorpay>

  constructor(private readonly container: MedusaContainer) {
    this.logger_ = container.resolve("logger")
    this.paymentModule_ = container.resolve(Modules.PAYMENT)
    this.cartModule_ = container.resolve(Modules.CART)
    this.orderModule_ = container.resolve(Modules.ORDER)
    this.workflowEngine_ = container.resolve(Modules.WORKFLOW_ENGINE)
    this.query_ = container.resolve(ContainerRegistrationKeys.QUERY)
    this.orchestrationModule_ = container.resolve(
      PAYMENT_ORCHESTRATION_MODULE
    ) as PaymentOrchestrationModuleService

    const keyId = process.env.RAZORPAY_KEY_ID
    const keySecret = process.env.RAZORPAY_KEY_SECRET

    if (!keyId || !keySecret) {
      throw new MedusaError(
        MedusaError.Types.UNEXPECTED_STATE,
        "Razorpay keys are not configured"
      )
    }

    this.razorpay_ = new Razorpay({
      key_id: keyId,
      key_secret: keySecret,
    })
  }

  async initiateSession(params: { cartId: string; customerId?: string | null }) {
    const cart = await this.getCart(cartIdOrThrow(params.cartId))
    const existingOrder = await this.getOrderByCartId(cart.id)

    if (existingOrder) {
      return {
        cartId: cart.id,
        status: "completed",
        order: existingOrder,
      }
    }

    if (cart.completed_at) {
      throw new MedusaError(
        MedusaError.Types.INVALID_DATA,
        `Cart ${cart.id} is already completed`
      )
    }

    const shippingReadiness = await this.ensureCartShippingMethodsReady(cart.id)

    if (!shippingReadiness.ready) {
      throw new MedusaError(
        MedusaError.Types.INVALID_DATA,
        shippingReadiness.message ||
          "Cart is missing valid shipping methods for checkout"
      )
    }

    const existingAttempt = await this.orchestrationModule_.getActiveAttemptForCart(
      cart.id
    )

    if (this.isAttemptReusable(existingAttempt)) {
      const existingSession = await this.getPaymentSession(
        existingAttempt.payment_session_id
      )

      if (existingSession?.data?.order_id || existingSession?.data?.razorpay_order_id) {
        await this.persistCartPaymentState(cart, {
          attempt_id: existingAttempt.id,
          payment_session_id: existingAttempt.payment_session_id,
          payment_collection_id: existingAttempt.payment_collection_id,
          razorpay_order_id:
            existingAttempt.razorpay_order_id ||
            existingSession.data.order_id ||
            existingSession.data.razorpay_order_id ||
            null,
          status: existingAttempt.status,
          expires_at: existingAttempt.expires_at?.toISOString?.() || null,
          last_error: existingAttempt.last_error || null,
        })

        return {
          cartId: cart.id,
          paymentCollectionId: existingAttempt.payment_collection_id,
          attempt: existingAttempt,
          razorpaySession: existingSession.data || {},
          status: existingAttempt.status,
        }
      }
    }

    const paymentCollectionId = await this.ensurePaymentCollection(cart.id)

    const attempt = await this.orchestrationModule_.createPaymentAttempts({
      cart_id: cart.id,
      payment_collection_id: paymentCollectionId,
      currency_code: (cart.currency_code || "INR").toString().toUpperCase(),
      expected_amount_minor: toMinorUnit(
        resolveNumericAmount(cart.total ?? cart.raw_total),
        cart.currency_code || "INR"
      ),
      status: "pending",
      active: true,
      expires_at: computeAttemptExpiry(),
      metadata: {
        source: "checkout",
      },
    })

    await this.orchestrationModule_.deactivateOtherAttempts(cart.id, attempt.id)

    const { result } = await createPaymentSessionsWorkflow(this.container).run({
      input: {
        payment_collection_id: paymentCollectionId,
        provider_id: RAZORPAY_PROVIDER_ID,
        customer_id: params.customerId || undefined,
        data: {
          cart_id: cart.id,
          attempt_id: attempt.id,
          payment_collection_id: paymentCollectionId,
        },
        context: {
          cart_id: cart.id,
          attempt_id: attempt.id,
          payment_collection_id: paymentCollectionId,
          resource_id: cart.id,
        },
      },
    })

    const session = result as Record<string, any>
    const razorpayOrderId =
      session?.data?.order_id || session?.data?.razorpay_order_id || null

    const updatedAttempt = await this.orchestrationModule_.patchAttempt(attempt.id, {
      payment_session_id: session.id,
      razorpay_order_id: razorpayOrderId,
      status: "pending",
      metadata: {
        ...(attempt.metadata || {}),
        initiated_at: new Date().toISOString(),
      },
    })

    await this.persistCartPaymentState(cart, {
      attempt_id: updatedAttempt.id,
      payment_session_id: updatedAttempt.payment_session_id,
      payment_collection_id: paymentCollectionId,
      razorpay_order_id: razorpayOrderId,
      status: updatedAttempt.status,
      expires_at: updatedAttempt.expires_at?.toISOString?.() || null,
      last_error: null,
    })

    return {
      cartId: cart.id,
      paymentCollectionId,
      attempt: updatedAttempt,
      razorpaySession: session?.data || {},
      status: updatedAttempt.status,
    }
  }

  async syncCart(cartId: string): Promise<SyncResult> {
    const cart = await this.getCart(cartIdOrThrow(cartId))
    const order = await this.getOrderByCartId(cart.id)

    if (order) {
      const activeAttempt = await this.orchestrationModule_.getActiveAttemptForCart(
        cart.id
      )

      if (activeAttempt) {
        await this.orchestrationModule_.patchAttempt(activeAttempt.id, {
          status: "completed",
          order_id: String(order.id),
          active: false,
          completed_at: new Date(),
          last_synced_at: new Date(),
        })

        const completionJob =
          await this.orchestrationModule_.getCompletionJobByAttemptId(activeAttempt.id)

        if (completionJob) {
          await this.orchestrationModule_.patchCompletionJob(completionJob.id, {
            status: "completed",
            completed_at: new Date(),
            next_run_at: null,
            last_error: null,
          })
        }
      }

      await this.persistCartPaymentState(cart, {
        status: "completed",
        order_id: String(order.id),
        last_error: null,
      })

      return {
        status: "completed",
        cart_id: cart.id,
        order,
        attempt: activeAttempt,
      }
    }

    const attempt = await this.orchestrationModule_.getActiveAttemptForCart(cart.id)

    if (!attempt) {
      return {
        status: "not_started",
        cart_id: cart.id,
        order: null,
        attempt: null,
      }
    }

    if (attempt.expires_at && new Date(attempt.expires_at).getTime() <= Date.now()) {
      await this.expireAttempt(attempt.id)
      const expiredAttempt = await this.orchestrationModule_.retrievePaymentAttempt(
        attempt.id
      )

      return {
        status: "expired",
        cart_id: cart.id,
        attempt: expiredAttempt,
        message: "Payment session expired. Please start payment again.",
      }
    }

    return await this.syncAttemptFromRazorpay(attempt.id)
  }

  async verifyPayment(input: VerifyInput): Promise<SyncResult> {
    const paymentCollectionId = (input.paymentCollectionId || "").toString()
    const razorpayOrderId = (input.razorpayOrderId || "").toString()
    const razorpayPaymentId = (input.razorpayPaymentId || "").toString()
    const razorpaySignature = (input.razorpaySignature || "").toString()

    if (!paymentCollectionId) {
      throw new MedusaError(
        MedusaError.Types.INVALID_DATA,
        "payment_collection_id is required"
      )
    }

    if (!razorpayOrderId || !razorpayPaymentId || !razorpaySignature) {
      throw new MedusaError(
        MedusaError.Types.INVALID_DATA,
        "razorpay_order_id, razorpay_payment_id and razorpay_signature are required"
      )
    }

    const keySecret = process.env.RAZORPAY_KEY_SECRET

    if (!keySecret) {
      throw new MedusaError(
        MedusaError.Types.UNEXPECTED_STATE,
        "Razorpay key secret is not configured"
      )
    }

    const expectedSignature = this.computeCheckoutSignature({
      orderId: razorpayOrderId,
      paymentId: razorpayPaymentId,
      keySecret,
    })

    const matchesSignature =
      expectedSignature.length === razorpaySignature.length &&
      Buffer.compare(
        Buffer.from(expectedSignature),
        Buffer.from(razorpaySignature)
      ) === 0

    if (!matchesSignature) {
      throw new MedusaError(
        MedusaError.Types.UNAUTHORIZED,
        "Invalid Razorpay signature"
      )
    }

    const attempt =
      (await this.orchestrationModule_.getLatestAttemptByPaymentCollectionId(
        paymentCollectionId
      )) ||
      (await this.orchestrationModule_.getAttemptByOrderId(razorpayOrderId))

    if (!attempt) {
      throw new MedusaError(
        MedusaError.Types.NOT_FOUND,
        `No Razorpay payment attempt found for collection ${paymentCollectionId}`
      )
    }

    const payment = await this.razorpay_.payments.fetch(razorpayPaymentId)

    if ((payment?.order_id || "") !== razorpayOrderId) {
      throw new MedusaError(
        MedusaError.Types.INVALID_DATA,
        "Razorpay payment does not belong to the provided order"
      )
    }

    return await this.syncAttemptWithPaymentDetails(attempt.id, payment)
  }

  async handleWebhook(body: any, rawBody: Buffer, headers: Record<string, any>) {
    this.verifyWebhookSignature(rawBody, headers)

    const paymentEntity = body?.payload?.payment?.entity
    const eventType = (body?.event || "").toString()
    const eventId = getWebhookEventId(body)

    if (!paymentEntity?.id) {
      const event = await this.orchestrationModule_.createWebhookEventIfAbsent({
        event_id: eventId,
        event_type: eventType || "unknown",
        payload: body || null,
      })

      await this.orchestrationModule_.updateWebhookEventStatus(
        event.id,
        "ignored",
        {
          processed_at: new Date(),
          failure_reason: "Missing payment entity",
        }
      )

      return {
        ok: true,
        ignored: true,
      }
    }

    const existingEvent = await this.orchestrationModule_.createWebhookEventIfAbsent({
      event_id: eventId,
      event_type: eventType || "unknown",
      payment_session_id:
        paymentEntity?.notes?.payment_session_id ||
        paymentEntity?.notes?.session_id ||
        null,
      razorpay_order_id: paymentEntity?.order_id || null,
      cart_id: paymentEntity?.notes?.cart_id || null,
      payload: body || null,
    })

    if (existingEvent.status === "processed" || existingEvent.status === "ignored") {
      return {
        ok: true,
        duplicate: true,
      }
    }

    await this.orchestrationModule_.updateWebhookEventStatus(
      existingEvent.id,
      "processing"
    )

    try {
      const attempt = await this.resolveAttemptFromPaymentEntity(paymentEntity)

      if (!attempt) {
        await this.orchestrationModule_.updateWebhookEventStatus(
          existingEvent.id,
          "ignored",
          {
            processed_at: new Date(),
            failure_reason: "No payment attempt found for webhook",
          }
        )

        return {
          ok: true,
          ignored: true,
        }
      }

      const result = await this.syncAttemptWithPaymentDetails(attempt.id, paymentEntity)

      await this.orchestrationModule_.updateWebhookEventStatus(
        existingEvent.id,
        "processed",
        {
          processed_at: new Date(),
          cart_id: attempt.cart_id,
          payment_session_id: attempt.payment_session_id,
          razorpay_order_id: attempt.razorpay_order_id,
        }
      )

      return {
        ok: true,
        result,
      }
    } catch (error: any) {
      await this.orchestrationModule_.updateWebhookEventStatus(
        existingEvent.id,
        "failed",
        {
          failed_at: new Date(),
          failure_reason: error?.message || "Webhook processing failed",
        }
      )

      throw error
    }
  }

  async syncAttemptFromRazorpay(attemptId: string): Promise<SyncResult> {
    const attempt = await this.orchestrationModule_.retrievePaymentAttempt(attemptId)

    if (!attempt.razorpay_order_id) {
      return {
        status: attempt.status as SyncResult["status"],
        cart_id: attempt.cart_id,
        attempt,
        message: attempt.last_error || undefined,
      }
    }

    const paymentsResponse = (await this.razorpay_.orders.fetchPayments(
      attempt.razorpay_order_id
    )) as any

    const items = Array.isArray(paymentsResponse?.items)
      ? paymentsResponse.items
      : []

    const captured = items.find((item: any) => item?.status === "captured")
    const authorized = items.find((item: any) => item?.status === "authorized")
    const failed = items.find((item: any) => item?.status === "failed")
    const target = captured || authorized || failed || items[0]

    if (!target) {
      await this.orchestrationModule_.patchAttempt(attempt.id, {
        last_synced_at: new Date(),
      })

      return {
        status: "pending",
        cart_id: attempt.cart_id,
        attempt,
        message: "Waiting for payment confirmation",
      }
    }

    return await this.syncAttemptWithPaymentDetails(attempt.id, target)
  }

  async processCompletionJobs(limit = 20) {
    const jobs = await this.orchestrationModule_.listRunnableCompletionJobs(
      new Date(),
      limit
    )

    for (const job of jobs) {
      const nextAttemptCount = Number(job.attempts || 0) + 1

      await this.orchestrationModule_.patchCompletionJob(job.id, {
        status: "processing",
        attempts: nextAttemptCount,
        last_attempt_at: new Date(),
        next_run_at: null,
      })

      try {
        const result = await this.syncAttemptFromRazorpay(job.attempt_id)

        if (result.status === "completed") {
          await this.orchestrationModule_.patchCompletionJob(job.id, {
            status: "completed",
            completed_at: new Date(),
            last_error: null,
          })
          continue
        }

        const maxAttempts = Number(
          process.env.RAZORPAY_COMPLETION_RETRY_ATTEMPTS || 8
        )

        if (nextAttemptCount >= maxAttempts) {
          await this.orchestrationModule_.patchCompletionJob(job.id, {
            status: "dead",
            last_error:
              result.message ||
              "Payment completion retries exhausted without producing an order",
          })
          continue
        }

        await this.queueCompletionRetry(job.attempt_id, result.message, nextAttemptCount)
      } catch (error: any) {
        const maxAttempts = Number(
          process.env.RAZORPAY_COMPLETION_RETRY_ATTEMPTS || 8
        )

        if (nextAttemptCount >= maxAttempts) {
          await this.orchestrationModule_.patchCompletionJob(job.id, {
            status: "dead",
            last_error: error?.message || "Payment completion job failed",
          })
          continue
        }

        await this.queueCompletionRetry(
          job.attempt_id,
          error?.message || "Payment completion job failed",
          nextAttemptCount
        )
      }
    }
  }

  async expireStaleAttempts(limit = 50) {
    const attempts = await this.orchestrationModule_.listExpiredAttempts(
      new Date(),
      limit
    )

    for (const attempt of attempts) {
      try {
        await this.expireAttempt(attempt.id)
      } catch (error: any) {
        this.logger_.warn?.(
          `Razorpay expiry: failed to expire attempt ${attempt.id}: ${error?.message || "unknown"}`
        )
      }
    }
  }

  async createRefund(params: {
    orderId: string
    paymentId: string
    amount?: number
    note?: string | null
    refundReasonId?: string | null
    createdBy?: string | null
  }) {
    const payment = await this.paymentModule_.retrievePayment(params.paymentId, {
      relations: ["refunds"],
    })

    const amount = params.amount ?? payment.amount
    const currencyCode = (payment.currency_code || "INR").toString().toUpperCase()

    const updatedPayment = (await this.paymentModule_.refundPayment({
      payment_id: params.paymentId,
      amount,
      note: params.note || undefined,
      refund_reason_id: params.refundReasonId || undefined,
      created_by: params.createdBy || undefined,
    })) as PaymentDTO & {
      refunds?: Array<Record<string, any>>
      data?: Record<string, any> | null
    }

    const latestRefund =
      Array.isArray(updatedPayment?.refunds) && updatedPayment.refunds.length
        ? updatedPayment.refunds[updatedPayment.refunds.length - 1]
        : null

    const attempt =
      (await this.orchestrationModule_.getAttemptBySessionId(
        payment.payment_session_id || ""
      )) || null

    const providerRefundId =
      updatedPayment?.data?.razorpay_refund_id ||
      updatedPayment?.data?.latest_refund_id ||
      null

    const refundMinorAmount = toMinorUnit(
      resolveNumericAmount(amount),
      currencyCode
    )
    const refundStatus =
      refundMinorAmount >=
      toMinorUnit(resolveNumericAmount(payment.amount), currencyCode)
        ? "full"
        : "partial"

    const refundRecord = await this.orchestrationModule_.upsertRefundRecord({
      attempt_id: attempt?.id || null,
      order_id: params.orderId,
      payment_id: params.paymentId,
      medusa_refund_id: latestRefund?.id || null,
      razorpay_refund_id: providerRefundId,
      status: refundStatus,
      refund_amount_minor: refundMinorAmount,
      currency_code: currencyCode,
      raw_response: updatedPayment?.data || null,
      processed_at: new Date(),
      metadata: {
        note: params.note || null,
      },
    })

    if (attempt) {
      await this.orchestrationModule_.patchAttempt(attempt.id, {
        status: refundStatus === "full" ? "refunded" : "partially_refunded",
        active: false,
        last_synced_at: new Date(),
      })
    }

    return {
      payment: updatedPayment,
      refund_record: refundRecord,
    }
  }

  async runMaintenance(params?: {
    reconcileLimit?: number
    completionLimit?: number
    expireLimit?: number
  }) {
    const reconcileLimit = Number(params?.reconcileLimit || 25)
    const completionLimit = Number(params?.completionLimit || 20)
    const expireLimit = Number(params?.expireLimit || 50)

    const recoverableAttempts =
      await this.orchestrationModule_.listRecoverableAttempts(
        new Date(),
        reconcileLimit
      )

    let reconciled = 0
    let reconcileErrors = 0

    for (const attempt of recoverableAttempts) {
      try {
        await this.syncAttemptFromRazorpay(attempt.id)
        reconciled += 1
      } catch (error: any) {
        reconcileErrors += 1
        this.logger_.warn?.(
          `Razorpay maintenance: failed to sync attempt ${attempt.id}: ${error?.message || "unknown error"}`
        )
      }
    }

    await this.processCompletionJobs(completionLimit)
    await this.expireStaleAttempts(expireLimit)

    return {
      ok: true,
      reconcile_count: recoverableAttempts.length,
      reconciled,
      reconcile_errors: reconcileErrors,
      completion_limit: completionLimit,
      expire_limit: expireLimit,
    }
  }

  private async syncAttemptWithPaymentDetails(
    attemptId: string,
    payment: any
  ): Promise<SyncResult> {
    const attempt = await this.orchestrationModule_.retrievePaymentAttempt(attemptId)
    const cart = await this.getCart(attempt.cart_id)
    const existingOrder = await this.getOrderByCartId(cart.id)

    if (existingOrder) {
      await this.orchestrationModule_.patchAttempt(attempt.id, {
        status: "completed",
        order_id: String(existingOrder.id),
        active: false,
        completed_at: new Date(),
        last_synced_at: new Date(),
      })

      await this.persistCartPaymentState(cart, {
        attempt_id: attempt.id,
        order_id: String(existingOrder.id),
        status: "completed",
        last_error: null,
      })

      return {
        status: "completed",
        cart_id: cart.id,
        order: existingOrder,
        attempt: await this.orchestrationModule_.retrievePaymentAttempt(attempt.id),
      }
    }

    this.validatePaymentAgainstCart(cart, payment)
    await this.updatePaymentSessionProviderData(attempt, payment)

    const nextStatus = (payment?.status || "").toString().toLowerCase()

    if (nextStatus === "captured") {
      await this.orchestrationModule_.patchAttempt(attempt.id, {
        status: "captured",
        razorpay_payment_id: payment.id,
        payment_amount_minor: Number(payment.amount || 0),
        last_synced_at: new Date(),
        last_error: null,
      })

      await this.persistCartPaymentState(cart, {
        attempt_id: attempt.id,
        payment_session_id: attempt.payment_session_id,
        payment_collection_id: attempt.payment_collection_id,
        razorpay_order_id: attempt.razorpay_order_id || payment.order_id || null,
        razorpay_payment_id: payment.id || null,
        status: "captured",
        expires_at: attempt.expires_at?.toISOString?.() || null,
        last_error: null,
      })

      const completion = await this.tryCompleteCapturedAttempt(attempt.id)

      if (completion.status === "completed") {
        return completion
      }

      await this.queueCompletionRetry(attempt.id, completion.message)
      return completion
    }

    if (nextStatus === "authorized") {
      const pendingCaptureAttempt = await this.orchestrationModule_.patchAttempt(
        attempt.id,
        {
          status: "pending_capture",
          razorpay_payment_id: payment.id || null,
          payment_amount_minor: Number(payment.amount || 0),
          last_synced_at: new Date(),
          last_error: null,
        }
      )

      await this.persistCartPaymentState(cart, {
        attempt_id: attempt.id,
        payment_session_id: attempt.payment_session_id,
        payment_collection_id: attempt.payment_collection_id,
        razorpay_order_id: attempt.razorpay_order_id || payment.order_id || null,
        razorpay_payment_id: payment.id || null,
        status: "pending_capture",
        expires_at: attempt.expires_at?.toISOString?.() || null,
        last_error: null,
      })

      return {
        status: "pending_capture",
        cart_id: cart.id,
        attempt: pendingCaptureAttempt,
        message: "Payment authorized and waiting for capture confirmation",
      }
    }

    if (nextStatus === "failed") {
      const failedAttempt = await this.orchestrationModule_.patchAttempt(attempt.id, {
        status: "failed",
        razorpay_payment_id: payment.id || null,
        payment_amount_minor: Number(payment.amount || 0),
        active: false,
        last_synced_at: new Date(),
        last_failed_at: new Date(),
        last_error:
          payment?.error_description ||
          payment?.error_reason ||
          "Payment failed at Razorpay",
      })

      await this.persistCartPaymentState(cart, {
        attempt_id: attempt.id,
        payment_session_id: attempt.payment_session_id,
        payment_collection_id: attempt.payment_collection_id,
        razorpay_order_id: attempt.razorpay_order_id || payment.order_id || null,
        razorpay_payment_id: payment.id || null,
        status: "failed",
        last_error: failedAttempt.last_error || null,
      })

      return {
        status: "failed",
        cart_id: cart.id,
        attempt: failedAttempt,
        message:
          "Payment failed. If the amount was debited, it will be auto-refunded or reversed by your bank.",
      }
    }

    const pendingAttempt = await this.orchestrationModule_.patchAttempt(attempt.id, {
      status: "pending",
      razorpay_payment_id: payment.id || null,
      payment_amount_minor: Number(payment.amount || 0),
      last_synced_at: new Date(),
    })

    await this.persistCartPaymentState(cart, {
      attempt_id: attempt.id,
      payment_session_id: attempt.payment_session_id,
      payment_collection_id: attempt.payment_collection_id,
      razorpay_order_id: attempt.razorpay_order_id || payment.order_id || null,
      razorpay_payment_id: payment.id || null,
      status: "pending",
      expires_at: attempt.expires_at?.toISOString?.() || null,
    })

    return {
      status: "pending",
      cart_id: cart.id,
      attempt: pendingAttempt,
      message: "Waiting for payment confirmation",
    }
  }

  private async tryCompleteCapturedAttempt(attemptId: string): Promise<SyncResult> {
    const attempt = await this.orchestrationModule_.retrievePaymentAttempt(attemptId)
    const cart = await this.getCart(attempt.cart_id)
    const orderBefore = await this.getOrderByCartId(cart.id)

    if (orderBefore) {
      await this.orchestrationModule_.patchAttempt(attempt.id, {
        status: "completed",
        order_id: String(orderBefore.id),
        active: false,
        completed_at: new Date(),
        last_synced_at: new Date(),
        last_error: null,
      })

      await this.persistCartPaymentState(cart, {
        attempt_id: attempt.id,
        order_id: String(orderBefore.id),
        status: "completed",
        last_error: null,
      })

      return {
        status: "completed",
        cart_id: cart.id,
        order: orderBefore,
        attempt,
      }
    }

    if (!attempt.payment_session_id) {
      return {
        status: "processing",
        cart_id: cart.id,
        attempt,
        message: "Payment is captured but payment session is missing",
      }
    }

    await this.orchestrationModule_.patchAttempt(attempt.id, {
      status: "processing",
      last_synced_at: new Date(),
      last_error: null,
    })

    await this.persistCartPaymentState(cart, {
      attempt_id: attempt.id,
      payment_session_id: attempt.payment_session_id,
      payment_collection_id: attempt.payment_collection_id,
      razorpay_order_id: attempt.razorpay_order_id,
      razorpay_payment_id: attempt.razorpay_payment_id,
      status: "processing",
      expires_at: attempt.expires_at?.toISOString?.() || null,
      last_error: null,
    })

    let completionErrorMessage: string | null = null

    const shippingReadiness = await this.ensureCartShippingMethodsReady(cart.id)

    if (!shippingReadiness.ready) {
      completionErrorMessage =
        shippingReadiness.message ||
        "Shipping methods are not ready for order completion"

      this.logger_.warn?.(
        `Razorpay completion: shipping preflight failed for cart ${cart.id}: ${completionErrorMessage}`
      )

      return {
        status: "processing",
        cart_id: cart.id,
        attempt,
        message: completionErrorMessage,
      }
    }

    try {
      await this.workflowEngine_.run(processPaymentWorkflowId, {
        input: {
          action: PaymentActions.SUCCESSFUL,
          data: {
            session_id: attempt.payment_session_id,
            amount: resolveNumericAmount(cart.total ?? cart.raw_total),
          },
        },
      })
    } catch (error: any) {
      completionErrorMessage =
        error?.message || "processPaymentWorkflow failed during order completion"

      this.logger_.warn?.(
        `Razorpay completion: processPaymentWorkflow failed for attempt ${attempt.id}: ${completionErrorMessage}`
      )
    }

    let orderAfter = await this.getOrderByCartId(cart.id)

    if (!orderAfter) {
      try {
        await this.workflowEngine_.run(completeCartWorkflowId, {
          input: {
            id: cart.id,
          },
        })
      } catch (fallbackError: any) {
        const fallbackMessage =
          fallbackError?.message || "fallback completeCart failed during order completion"

        completionErrorMessage = completionErrorMessage
          ? `${completionErrorMessage}; ${fallbackMessage}`
          : fallbackMessage

        this.logger_.warn?.(
          `Razorpay completion: fallback completeCart failed for cart ${cart.id}: ${fallbackMessage}`
        )
      }

      orderAfter = await this.getOrderByCartId(cart.id)
    }

    if (!orderAfter) {
      const shippingRecovery = await this.ensureCartShippingMethodsReady(cart.id)

      if (shippingRecovery.ready && shippingRecovery.repaired) {
        try {
          await this.workflowEngine_.run(completeCartWorkflowId, {
            input: {
              id: cart.id,
            },
          })
        } catch (repairRetryError: any) {
          const repairRetryMessage =
            repairRetryError?.message ||
            "completeCart failed after repairing shipping methods"

          completionErrorMessage = completionErrorMessage
            ? `${completionErrorMessage}; ${repairRetryMessage}`
            : repairRetryMessage

          this.logger_.warn?.(
            `Razorpay completion: completeCart retry after shipping repair failed for cart ${cart.id}: ${repairRetryMessage}`
          )
        }

        orderAfter = await this.getOrderByCartId(cart.id)
      }
    }

    if (orderAfter) {
      const completedAttempt =
        await this.orchestrationModule_.patchAttempt(attempt.id, {
          status: "completed",
          order_id: String(orderAfter.id),
          active: false,
          completed_at: new Date(),
          last_synced_at: new Date(),
          last_error: null,
        })

      const completionJob =
        await this.orchestrationModule_.getCompletionJobByAttemptId(attempt.id)

      if (completionJob) {
        await this.orchestrationModule_.patchCompletionJob(completionJob.id, {
          status: "completed",
          completed_at: new Date(),
          next_run_at: null,
          last_error: null,
        })
      }

      await this.persistCartPaymentState(cart, {
        attempt_id: attempt.id,
        order_id: String(orderAfter.id),
        status: "completed",
        last_error: null,
      })

      return {
        status: "completed",
        cart_id: cart.id,
        order: orderAfter,
        attempt: completedAttempt,
      }
    }

    return {
      status: "processing",
      cart_id: cart.id,
      attempt,
      message:
        completionErrorMessage ||
        "Payment captured. Order completion is queued for retry.",
    }
  }

  private async queueCompletionRetry(
    attemptId: string,
    message?: string,
    existingAttempts?: number
  ) {
    const attempt = await this.orchestrationModule_.retrievePaymentAttempt(attemptId)
    const existingJob =
      await this.orchestrationModule_.getCompletionJobByAttemptId(attemptId)
    const attemptCount = existingAttempts ?? Number(existingJob?.attempts || 0)
    const delaySeconds = computeRetryDelaySeconds(attemptCount || 1)

    await this.orchestrationModule_.upsertCompletionJob({
      attempt_id: attempt.id,
      cart_id: attempt.cart_id,
      status: "pending",
      attempts: attemptCount,
      next_run_at: new Date(Date.now() + delaySeconds * 1000),
      last_error: message || null,
      metadata: {
        retry_delay_seconds: delaySeconds,
      },
    })

    await this.orchestrationModule_.patchAttempt(attempt.id, {
      status: "processing",
      last_error: message || null,
      last_failed_at: message ? new Date() : attempt.last_failed_at,
    })
  }

  private async expireAttempt(attemptId: string) {
    const attempt = await this.orchestrationModule_.retrievePaymentAttempt(attemptId)
    const cart = await this.getCart(attempt.cart_id)

    await this.orchestrationModule_.patchAttempt(attempt.id, {
      status: "expired",
      active: false,
      last_synced_at: new Date(),
      last_error: "Payment session expired",
    })

    if (attempt.payment_session_id) {
      try {
        await this.paymentModule_.deletePaymentSession(attempt.payment_session_id)
      } catch (error: any) {
        this.logger_.warn?.(
          `Razorpay expiry: could not delete payment session ${attempt.payment_session_id}: ${error?.message || "unknown"}`
        )
      }
    }

    const job = await this.orchestrationModule_.getCompletionJobByAttemptId(attempt.id)
    if (job) {
      await this.orchestrationModule_.patchCompletionJob(job.id, {
        status: "dead",
        last_error: "Payment session expired",
      })
    }

    await this.persistCartPaymentState(cart, {
      attempt_id: attempt.id,
      payment_session_id: attempt.payment_session_id,
      payment_collection_id: attempt.payment_collection_id,
      razorpay_order_id: attempt.razorpay_order_id,
      razorpay_payment_id: attempt.razorpay_payment_id,
      status: "expired",
      expires_at: attempt.expires_at?.toISOString?.() || null,
      last_error: "Payment session expired. Please start payment again.",
      inventory_released: true,
    })
  }

  private async resolveAttemptFromPaymentEntity(paymentEntity: any) {
    const notes = paymentEntity?.notes || {}

    if (notes?.attempt_id) {
      try {
        return await this.orchestrationModule_.retrievePaymentAttempt(notes.attempt_id)
      } catch {
        // continue with fallback lookups
      }
    }

    if (notes?.payment_session_id || notes?.session_id) {
      const attempt = await this.orchestrationModule_.getAttemptBySessionId(
        notes.payment_session_id || notes.session_id
      )

      if (attempt) {
        return attempt
      }
    }

    if (paymentEntity?.order_id) {
      const attempt = await this.orchestrationModule_.getAttemptByOrderId(
        paymentEntity.order_id
      )

      if (attempt) {
        return attempt
      }
    }

    if (notes?.cart_id) {
      return await this.orchestrationModule_.getActiveAttemptForCart(notes.cart_id)
    }

    return null
  }

  private async updatePaymentSessionProviderData(attempt: any, payment: any) {
    if (!attempt.payment_session_id) {
      return
    }

    const session = await this.getPaymentSession(attempt.payment_session_id)
    if (!session) {
      return
    }

    await this.paymentModule_.updatePaymentSession({
      id: session.id,
      amount: session.amount,
      currency_code: session.currency_code,
      data: {
        ...(session.data || {}),
        cart_id: attempt.cart_id,
        attempt_id: attempt.id,
        payment_collection_id: attempt.payment_collection_id,
        order_id: payment.order_id || attempt.razorpay_order_id || undefined,
        razorpay_order_id:
          payment.order_id || attempt.razorpay_order_id || undefined,
        razorpay_payment_id: payment.id || undefined,
        razorpay_amount:
          typeof payment.amount === "number" ? payment.amount : undefined,
        razorpay_currency: payment.currency || session.currency_code || undefined,
        latest_status: payment.status || undefined,
      },
      metadata: {
        ...(session.metadata || {}),
        attempt_id: attempt.id,
      },
    })
  }

  private validatePaymentAgainstCart(cart: any, payment: any) {
    const currencyCode = (cart.currency_code || "INR").toString().toUpperCase()
    const cartTotal = resolveNumericAmount(cart.total ?? cart.raw_total)
    const expectedAmountMinor = toMinorUnit(cartTotal, currencyCode)
    const paymentAmount = Number(payment?.amount || 0)
    const paymentCurrency = (payment?.currency || "").toString().toUpperCase()

    if (paymentCurrency && paymentCurrency !== currencyCode) {
      throw new MedusaError(
        MedusaError.Types.INVALID_DATA,
        `Razorpay currency mismatch for cart ${cart.id}`
      )
    }

    if (paymentAmount !== expectedAmountMinor) {
      throw new MedusaError(
        MedusaError.Types.INVALID_DATA,
        `Razorpay amount mismatch for cart ${cart.id}`
      )
    }
  }

  private verifyWebhookSignature(rawBody: Buffer, headers: Record<string, any>) {
    const signature =
      (headers["x-razorpay-signature"] as string | undefined) ||
      (headers["X-Razorpay-Signature"] as string | undefined) ||
      ""

    const secret = process.env.RAZORPAY_WEBHOOK_SECRET

    if (!secret || !signature) {
      throw new MedusaError(
        MedusaError.Types.UNAUTHORIZED,
        "Missing Razorpay webhook signature"
      )
    }

    const expected = require("crypto")
      .createHmac("sha256", secret)
      .update(rawBody)
      .digest("hex")

    const matches =
      expected.length === signature.length &&
      Buffer.compare(Buffer.from(expected), Buffer.from(signature)) === 0

    if (!matches) {
      throw new MedusaError(
        MedusaError.Types.UNAUTHORIZED,
        "Invalid Razorpay webhook signature"
      )
    }
  }

  verifyMaintenanceSecret(headers: Record<string, any>) {
    const expectedSecret = (
      process.env.RAZORPAY_MAINTENANCE_SECRET ||
      process.env.MEDUSA_CUSTOMER_SYNC_SECRET ||
      ""
    ).toString()

    if (!expectedSecret) {
      throw new MedusaError(
        MedusaError.Types.UNEXPECTED_STATE,
        "Missing RAZORPAY_MAINTENANCE_SECRET"
      )
    }

    const providedSecret =
      (headers["x-retail-job-secret"] as string | undefined) ||
      (headers["X-Retail-Job-Secret"] as string | undefined) ||
      ""

    if (!providedSecret) {
      throw new MedusaError(
        MedusaError.Types.UNAUTHORIZED,
        "Missing maintenance secret"
      )
    }

    const expectedBuffer = Buffer.from(expectedSecret)
    const providedBuffer = Buffer.from(providedSecret)

    if (
      expectedBuffer.length !== providedBuffer.length ||
      !crypto.timingSafeEqual(expectedBuffer, providedBuffer)
    ) {
      throw new MedusaError(
        MedusaError.Types.UNAUTHORIZED,
        "Invalid maintenance secret"
      )
    }
  }

  private computeCheckoutSignature(params: {
    orderId: string
    paymentId: string
    keySecret: string
  }) {
    const crypto = require("crypto")
    return crypto
      .createHmac("sha256", params.keySecret)
      .update(`${params.orderId}|${params.paymentId}`)
      .digest("hex")
  }

  private async ensurePaymentCollection(cartId: string) {
    const cart = await this.getCart(cartId)
    const paymentCollectionId = cart?.payment_collection?.id || null

    if (paymentCollectionId) {
      return String(paymentCollectionId)
    }

    await this.workflowEngine_.run(createPaymentCollectionForCartWorkflowId, {
      input: {
        cart_id: cartId,
      },
    })

    const refreshedCart = await this.getCart(cartId)
    if (!refreshedCart?.payment_collection?.id) {
      throw new MedusaError(
        MedusaError.Types.UNEXPECTED_STATE,
        `Unable to create payment collection for cart ${cartId}`
      )
    }

    return String(refreshedCart.payment_collection.id)
  }

  private async getPaymentSession(paymentSessionId?: string | null) {
    if (!paymentSessionId) {
      return null
    }

    const sessions = await this.paymentModule_.listPaymentSessions(
      {
        id: [paymentSessionId],
      },
      {
        take: 1,
      }
    )

    return sessions[0] || null
  }

  private async getCart(cartId: string) {
    const { data } = await this.query_.graph({
      entity: "cart",
      fields: [
        "id",
        "currency_code",
        "total",
        "raw_total",
        "completed_at",
        "metadata",
        "payment_collection.id",
      ],
      filters: {
        id: [cartId],
      },
    })

    const cart = Array.isArray(data) ? data[0] : null

    if (!cart) {
      throw new MedusaError(MedusaError.Types.NOT_FOUND, `Cart ${cartId} not found`)
    }

    return cart
  }

  private async getOrderByCartId(cartId: string) {
    const { data } = await this.query_.graph({
      entity: "order_cart",
      fields: ["cart_id", "order_id"],
      filters: {
        cart_id: [cartId],
      },
    })

    const orderId = Array.isArray(data) ? data[0]?.order_id : null

    if (!orderId) {
      return null
    }

    const orderResult = await this.query_.graph({
      entity: "order",
      fields: [
        "id",
        "display_id",
        "status",
        "payment_status",
        "fulfillment_status",
        "currency_code",
        "total",
        "created_at",
        "metadata",
      ],
      filters: {
        id: [orderId],
      },
    })

    return Array.isArray(orderResult.data) ? orderResult.data[0] || null : null
  }

  private async persistCartPaymentState(cart: any, patch: Record<string, unknown>) {
    const currentMetadata = (cart?.metadata || {}) as Record<string, unknown>
    const currentPaymentState = ((currentMetadata.razorpay_payment || {}) ??
      {}) as Record<string, unknown>

    await this.cartModule_.updateCarts(cart.id, {
      metadata: {
        ...currentMetadata,
        razorpay_payment: {
          ...currentPaymentState,
          ...patch,
          updated_at: new Date().toISOString(),
        },
      },
    })
  }

  private async ensureCartShippingMethodsReady(cartId: string) {
    const { data } = await this.query_.graph({
      entity: "cart",
      fields: [
        "id",
        "shipping_address.id",
        "shipping_address.postal_code",
        "shipping_methods.id",
        "shipping_methods.shipping_option_id",
        "shipping_methods.data",
        "items.id",
        "items.requires_shipping",
        "items.variant.id",
        "items.variant.product.id",
        "items.variant.product.shipping_profile.id",
      ],
      filters: {
        id: [cartId],
      },
    })

    const cart = Array.isArray(data) ? data[0] || null : null

    if (!cart) {
      return {
        ready: false,
        repaired: false,
        message: `Cart ${cartId} not found`,
      }
    }

    if (!cart?.shipping_address?.postal_code) {
      return {
        ready: false,
        repaired: false,
        message: "Shipping address is missing or incomplete",
      }
    }

    const items = Array.isArray(cart?.items) ? cart.items : []
    const requiredProfiles = Array.from(
      new Set(
        items
          .filter((item: any) => item?.requires_shipping !== false)
          .map((item: any) => item?.variant?.product?.shipping_profile?.id)
          .filter((profileId: unknown) => typeof profileId === "string" && profileId)
      )
    ) as string[]

    if (!requiredProfiles.length) {
      return {
        ready: true,
        repaired: false,
      }
    }

    const { result } = await listShippingOptionsForCartWithPricingWorkflow(
      this.container
    ).run({
      input: {
        cart_id: cartId,
        is_return: false,
      },
    })

    const availableOptions = Array.isArray(result) ? result : []

    if (!availableOptions.length) {
      this.logger_.warn?.(
        `Razorpay completion: no shipping options available while validating cart ${cartId}`
      )

      return {
        ready: false,
        repaired: false,
        message: "No shipping options are available for this cart",
      }
    }

    const optionById = new Map(
      availableOptions.map((option: any) => [String(option.id), option])
    )

    const optionsByProfile = new Map<string, any[]>()
    for (const option of availableOptions) {
      const profileId = this.normalizeShippingProfileId(option)
      if (!profileId) {
        continue
      }

      if (!optionsByProfile.has(profileId)) {
        optionsByProfile.set(profileId, [])
      }

      optionsByProfile.get(profileId)?.push(option)
    }

    const currentShippingMethods = Array.isArray(cart?.shipping_methods)
      ? cart.shipping_methods
      : []

    const currentSelections = new Map<
      string,
      { id: string; data: Record<string, unknown> }
    >()

    let preferredMode = ""
    let preferredProviderId = ""
    let fallbackPaymentMode = ""

    for (const method of currentShippingMethods) {
      const option = optionById.get(String(method?.shipping_option_id || ""))
      const profileId = this.normalizeShippingProfileId(option)

      if (!option || !profileId) {
        continue
      }

      const methodData =
        method?.data && typeof method.data === "object"
          ? { ...(method.data as Record<string, unknown>) }
          : {}

      if (!fallbackPaymentMode) {
        const paymentMode = methodData.payment_mode
        if (typeof paymentMode === "string" && paymentMode.trim()) {
          fallbackPaymentMode = paymentMode.trim()
        }
      }

      if (!preferredMode) {
        preferredMode = this.deriveShippingModeKey(option)
      }

      if (!preferredProviderId) {
        preferredProviderId = (
          option?.provider_id ||
          option?.provider?.id ||
          ""
        ).toString()
      }

      currentSelections.set(profileId, {
        id: String(option.id),
        data: this.buildShippingMethodRepairData(option, methodData, fallbackPaymentMode),
      })
    }

    const missingProfiles = requiredProfiles.filter(
      (profileId) => !currentSelections.has(profileId)
    )

    if (!missingProfiles.length) {
      return {
        ready: true,
        repaired: false,
      }
    }

    const selections = requiredProfiles.map((profileId) => {
      const existingSelection = currentSelections.get(profileId)
      if (existingSelection) {
        return existingSelection
      }

      const optionsForProfile = optionsByProfile.get(profileId) || []
      const chosenOption = this.pickShippingOptionForProfile(
        optionsForProfile,
        preferredMode,
        preferredProviderId
      )

      if (!chosenOption?.id) {
        return null
      }

      return {
        id: String(chosenOption.id),
        data: this.buildShippingMethodRepairData(
          chosenOption,
          {},
          fallbackPaymentMode
        ),
      }
    })

    if (selections.some((selection) => !selection?.id)) {
      this.logger_.warn?.(
        `Razorpay completion: could not resolve shipping options for all required profiles on cart ${cartId}`
      )

      return {
        ready: false,
        repaired: false,
        message: "Cart items are missing compatible shipping methods",
      }
    }

    const existingMethodIds = currentShippingMethods
      .map((method: any) => method?.id)
      .filter((id: unknown) => typeof id === "string" && id)

    if (existingMethodIds.length) {
      await this.cartModule_.deleteShippingMethods(existingMethodIds)
    }

    await addShippingMethodToCartWorkflow(this.container).run({
      input: {
        cart_id: cartId,
        options: selections.map((selection) => ({
          id: selection!.id,
          data: selection!.data,
        })),
      },
    })

    this.logger_.info?.(
      `Razorpay completion: repaired shipping methods for cart ${cartId} using ${selections.length} shipping option(s)`
    )

    return {
      ready: true,
      repaired: true,
    }
  }

  private normalizeShippingProfileId(option: any) {
    const profileId =
      option?.shipping_profile_id ||
      option?.shippingProfileId ||
      option?.shipping_profile?.id ||
      option?.shippingProfile?.id ||
      option?.profile_id ||
      ""

    return profileId ? String(profileId) : ""
  }

  private buildShippingMethodRepairData(
    option: any,
    existingData: Record<string, unknown>,
    fallbackPaymentMode?: string
  ) {
    const nextData = {
      ...existingData,
    } as Record<string, unknown>

    if (
      typeof nextData.shipping_type === "undefined" ||
      nextData.shipping_type === null ||
      nextData.shipping_type === ""
    ) {
      nextData.shipping_type =
        option?.metadata?.shipping_type ||
        option?.type?.label ||
        option?.type?.code ||
        option?.data?.shipping_type ||
        null
    }

    if (typeof nextData.shiprocket_mode === "undefined") {
      nextData.shiprocket_mode =
        option?.data?.shiprocket_mode ||
        option?.metadata?.shipping_type ||
        option?.type?.code ||
        null
    }

    if (typeof nextData.shiprocket_eta === "undefined") {
      nextData.shiprocket_eta = option?.metadata?.eta || null
    }

    if (typeof nextData.shiprocket_eta_days === "undefined") {
      nextData.shiprocket_eta_days =
        typeof option?.metadata?.eta_days === "number"
          ? option.metadata.eta_days
          : null
    }

    if (
      (typeof nextData.payment_mode === "undefined" ||
        nextData.payment_mode === null ||
        nextData.payment_mode === "") &&
      fallbackPaymentMode
    ) {
      nextData.payment_mode = fallbackPaymentMode
    }

    return nextData
  }

  private deriveShippingModeKey(option: any) {
    const raw =
      option?.type?.code ||
      option?.type?.label ||
      option?.metadata?.shipping_type ||
      option?.data?.shipping_type ||
      option?.data?.shiprocket_mode ||
      option?.name ||
      ""

    const normalized = raw.toString().trim().toLowerCase()

    if (!normalized) {
      return ""
    }

    if (normalized.includes("express")) {
      return "express"
    }

    if (normalized.includes("standard")) {
      return "standard"
    }

    return normalized
  }

  private pickShippingOptionForProfile(
    options: any[],
    preferredMode: string,
    preferredProviderId: string
  ) {
    if (!Array.isArray(options) || !options.length) {
      return null
    }

    const ranked = [...options].sort((left: any, right: any) => {
      const leftMode = this.deriveShippingModeKey(left)
      const rightMode = this.deriveShippingModeKey(right)
      const leftProvider = (
        left?.provider_id ||
        left?.provider?.id ||
        ""
      ).toString()
      const rightProvider = (
        right?.provider_id ||
        right?.provider?.id ||
        ""
      ).toString()

      const leftScore =
        (preferredMode && leftMode === preferredMode ? 4 : 0) +
        (preferredProviderId && leftProvider === preferredProviderId ? 2 : 0)
      const rightScore =
        (preferredMode && rightMode === preferredMode ? 4 : 0) +
        (preferredProviderId && rightProvider === preferredProviderId ? 2 : 0)

      if (leftScore !== rightScore) {
        return rightScore - leftScore
      }

      return this.resolveShippingOptionAmount(left) - this.resolveShippingOptionAmount(right)
    })

    return ranked[0] || null
  }

  private resolveShippingOptionAmount(option: any) {
    const rawAmount =
      option?.calculated_price?.calculated_amount ??
      option?.calculatedPrice?.calculatedAmount ??
      option?.amount ??
      null

    const amount =
      typeof rawAmount === "number" ? rawAmount : Number(rawAmount || 0)

    return Number.isFinite(amount) ? amount : Number.MAX_SAFE_INTEGER
  }

  private isAttemptReusable(attempt: any) {
    if (!attempt) {
      return false
    }

    if (!attempt.active) {
      return false
    }

    if (!attempt.payment_session_id) {
      return false
    }

    if (!PAYMENT_ACTIVE_STATUSES.includes(attempt.status)) {
      return false
    }

    if (attempt.expires_at && new Date(attempt.expires_at).getTime() <= Date.now()) {
      return false
    }

    return true
  }
}

function cartIdOrThrow(cartId: string) {
  const normalized = (cartId || "").toString().trim()

  if (!normalized) {
    throw new MedusaError(MedusaError.Types.INVALID_DATA, "cart_id is required")
  }

  return normalized
}
