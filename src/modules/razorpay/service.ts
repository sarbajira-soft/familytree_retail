import Razorpay from "razorpay"
import crypto from "crypto"

import {
  AbstractPaymentProvider,
  BigNumber,
  MedusaError,
  PaymentActions,
  PaymentSessionStatus,
} from "@medusajs/framework/utils"

import type {
  AuthorizePaymentInput,
  AuthorizePaymentOutput,
  CancelPaymentInput,
  CancelPaymentOutput,
  CapturePaymentInput,
  CapturePaymentOutput,
  DeletePaymentInput,
  DeletePaymentOutput,
  GetPaymentStatusInput,
  GetPaymentStatusOutput,
  InitiatePaymentInput,
  InitiatePaymentOutput,
  ProviderWebhookPayload,
  RefundPaymentInput,
  RefundPaymentOutput,
  RetrievePaymentInput,
  RetrievePaymentOutput,
  UpdatePaymentInput,
  UpdatePaymentOutput,
  WebhookActionResult,
  Logger,
} from "@medusajs/framework/types"

// Configuration options passed from medusa-config.ts
export type RazorpayProviderOptions = {
  keyId: string
  keySecret: string
  webhookSecret: string
}

// Dependencies we might want from the container
export type InjectedDependencies = {
  logger?: Logger
}

type RazorpayClient = InstanceType<typeof Razorpay>

class RazorpayProviderService extends AbstractPaymentProvider<RazorpayProviderOptions> {
  static identifier = "razorpay"

  protected readonly options_: RazorpayProviderOptions
  protected readonly logger_: Logger | undefined
  protected readonly client_: RazorpayClient

  constructor(container: InjectedDependencies, options: RazorpayProviderOptions) {
    // Let the base class wire container + options
    // @ts-ignore - AbstractPaymentProvider constructor signature is compatible
    super(container, options)

    this.logger_ = container.logger
    this.options_ = options

    if (!this.options_.keyId || !this.options_.keySecret) {
      throw new MedusaError(
        MedusaError.Types.INVALID_DATA,
        "Razorpay keyId and keySecret must be configured."
      )
    }

    this.client_ = new Razorpay({
      key_id: this.options_.keyId,
      key_secret: this.options_.keySecret,
    })
  }

  /**
   * Validate provider options at startup. This prevents the app from
   * starting with a misconfigured Razorpay integration.
   */
  static validateOptions(options: Record<string, any>) {
    if (!options.keyId || !options.keySecret || !options.webhookSecret) {
      throw new MedusaError(
        MedusaError.Types.INVALID_DATA,
        "Razorpay provider options must include keyId, keySecret and webhookSecret."
      )
    }
  }

  /**
   * Helper: convert Medusa amount to Razorpay's smallest currency unit.
   * Medusa typically stores amounts in the smallest currency unit already,
   * but this function is defensive in case BigNumber-like values are used.
   */
  protected toMinorUnit(amount: any, _currencyCode: string): number {
    const resolveAmount = (value: any): number => {
      if (typeof value === "number") {
        return value
      }

      if (typeof value === "string") {
        return Number(value)
      }

      if (value && typeof value === "object") {
        const candidates = [
          value.numeric,
          value.raw,
          value.value,
          value.amount,
        ]

        for (const candidate of candidates) {
          if (typeof candidate === "number") {
            return candidate
          }

          if (typeof candidate === "string") {
            const parsed = Number(candidate)
            if (Number.isFinite(parsed)) {
              return parsed
            }
          }
        }

        if (typeof value.toString === "function") {
          const parsed = Number(value.toString())
          if (Number.isFinite(parsed)) {
            return parsed
          }
        }
      }

      return Number.NaN
    }

    const numeric = resolveAmount(amount)

    if (!Number.isFinite(numeric)) {
      throw new MedusaError(
        MedusaError.Types.INVALID_DATA,
        "Invalid amount passed to Razorpay provider."
      )
    }

    const currencyCode = (_currencyCode || "").toString().toUpperCase()
    const zeroDecimalCurrencies = new Set([
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

    const factor = zeroDecimalCurrencies.has(currencyCode) ? 1 : 100
    return Math.round(numeric * factor)
  }

  /**
   * Initiate a Razorpay order for the payment session.
   * The returned data becomes PaymentSession.data and is exposed to the
   * storefront, so it must not include any secrets.
   */
  async initiatePayment(input: InitiatePaymentInput): Promise<InitiatePaymentOutput> {
    const { amount, currency_code, data, context } = input

    const sessionId = (data?.session_id as string) || (context?.idempotency_key as string) || ""
    const cartId =
      (data?.cart_id as string) ||
      ((context as any)?.cart_id as string) ||
      ((context as any)?.resource_id as string) ||
      ""
    const paymentCollectionId =
      (data?.payment_collection_id as string) ||
      ((context as any)?.payment_collection_id as string) ||
      ""
    const attemptId =
      (data?.attempt_id as string) || ((context as any)?.attempt_id as string) || ""
    const minorAmount = this.toMinorUnit(amount, currency_code)

    try {
      const order = await this.client_.orders.create({
        amount: minorAmount,
        currency: (currency_code || "INR").toUpperCase(),
        receipt: sessionId || (context as any)?.resource_id,
        payment_capture: 1, // auto-capture on successful payment
        notes: {
          // IMPORTANT: store the Medusa payment session id so webhooks can map back
          // to the correct payment session.
          payment_session_id: sessionId,
          // Backward compatibility with older payloads.
          session_id: sessionId,
          cart_id: cartId,
          payment_collection_id: paymentCollectionId,
          attempt_id: attemptId,
        },
      })

      return {
        id: order.id,
        data: {
          // These fields are safe to expose to the storefront
          order_id: order.id,
          amount: order.amount,
          currency: order.currency,
          session_id: sessionId,
          cart_id: cartId || undefined,
          payment_collection_id: paymentCollectionId || undefined,
          attempt_id: attemptId || undefined,
          razorpay_key_id: this.options_.keyId,
        },
        status: PaymentSessionStatus.PENDING,
      }
    } catch (e: any) {
      this.logger_?.error?.("Razorpay initiatePayment failed", e)
      throw new MedusaError(
        MedusaError.Types.UNEXPECTED_STATE,
        `Failed to create Razorpay order: ${e?.message || "unknown error"}`
      )
    }
  }

  /**
   * Authorize the payment by verifying with Razorpay that there is at least
   * one captured payment against the created order. This ensures we don't
   * trust only the frontend callback.
   */
  async authorizePayment(input: AuthorizePaymentInput): Promise<AuthorizePaymentOutput> {
    const data = (input.data || {}) as Record<string, unknown>
    const orderId = (data.order_id as string) || ""

    if (!orderId) {
      this.logger_?.warn?.("Razorpay authorizePayment called without order_id in data")
      return {
        data,
        status: PaymentSessionStatus.PENDING,
      }
    }

    try {
      // Fetch payments for this order from Razorpay to verify status server-side
      const paymentsResponse = (await this.client_.orders.fetchPayments(
        orderId
      )) as any

      const items = Array.isArray(paymentsResponse?.items)
        ? paymentsResponse.items
        : []

      // Payment is considered successful only after capture.
      const capturedPayment = items.find((p: any) => p.status === "captured")
      const authorizedPayment = items.find((p: any) => p.status === "authorized")

      if (!capturedPayment) {
        return {
          data: {
            ...data,
            latest_status: authorizedPayment ? "authorized" : "pending",
            capture_state: authorizedPayment ? "pending_capture" : "pending",
            razorpay_payment_id: authorizedPayment?.id || data.razorpay_payment_id,
          },
          status: PaymentSessionStatus.PENDING,
        }
      }

      return {
        data: {
          ...data,
          razorpay_order_id: orderId,
          razorpay_payment_id: capturedPayment.id,
          latest_status: "captured",
          capture_state: "captured",
        },
        status: PaymentSessionStatus.CAPTURED,
      }
    } catch (e: any) {
      this.logger_?.error?.("Razorpay authorizePayment verification failed", e)
      // Surface as error on the payment session so it can be retried or
      // reconciled via webhooks.
      throw new MedusaError(
        MedusaError.Types.UNEXPECTED_STATE,
        `Failed to verify Razorpay payment for order ${orderId}: ${
          e?.message || "unknown error"
        }`
      )
    }
  }

  /**
   * Razorpay captures the payment automatically when payment_capture=1.
   * By the time this method is invoked, authorizePayment or webhooks should
   * already have ensured the payment is captured, so we only propagate data.
   */
  async capturePayment(input: CapturePaymentInput): Promise<CapturePaymentOutput> {
    const data = (input.data || {}) as Record<string, unknown>
    const paymentId = (data.razorpay_payment_id as string) || ""

    if (!paymentId) {
      return {
        data,
      }
    }

    try {
      const currentPayment = (await this.client_.payments.fetch(paymentId)) as any

      if (currentPayment?.status === "captured") {
        return {
          data: {
            ...data,
            latest_status: "captured",
            capture_state: "captured",
          },
        }
      }

      if (currentPayment?.status === "authorized") {
        // Auto capture should normally handle this. This fallback keeps the
        // backend safe if dashboard settings are changed inadvertently.
        const capturedPayment = (await (this.client_.payments as any).capture(paymentId, {
          amount:
            typeof currentPayment.amount === "number" ? currentPayment.amount : undefined,
          currency:
            (currentPayment.currency as string | undefined) ||
            (data.currency as string | undefined) ||
            undefined,
        })) as any

        return {
          data: {
            ...data,
            razorpay_payment_id: capturedPayment.id,
            latest_status: capturedPayment.status || "captured",
            capture_state: "captured",
          },
        }
      }
    } catch (e: any) {
      this.logger_?.warn?.(
        `Razorpay capturePayment fallback failed for payment ${paymentId}: ${
          e?.message || "unknown error"
        }`
      )
    }

    return {
      data,
    }
  }

  /**
   * Cancel an uncaptured Razorpay payment/order if necessary.
   * For simplicity, we do not call Razorpay APIs here and instead
   * just return the existing data. This avoids throwing if the
   * payment is already captured and relies on admin-side refunds.
   */
  async cancelPayment(input: CancelPaymentInput): Promise<CancelPaymentOutput> {
    return {
      data: input.data || {},
    }
  }

  /**
   * For Medusa's expectations, deleting a payment is treated the same as
   * canceling it in the provider.
   */
  async deletePayment(input: DeletePaymentInput): Promise<DeletePaymentOutput> {
    const res = await this.cancelPayment(input as any)
    return res as unknown as DeletePaymentOutput
  }

  /**
   * Retrieve the latest status of a payment from Razorpay based on
   * the stored Razorpay IDs in the payment's data.
   */
  async getPaymentStatus(
    input: GetPaymentStatusInput
  ): Promise<GetPaymentStatusOutput> {
    const data = (input.data || {}) as Record<string, unknown>
    const paymentId = (data.razorpay_payment_id as string) || ""
    const orderId = (data.razorpay_order_id as string) || (data.order_id as string) || ""

    try {
      if (paymentId) {
        const payment = (await this.client_.payments.fetch(paymentId)) as any
        const status = (payment.status as string) || "created"

        const sessionStatus = this.mapRazorpayStatusToSessionStatus(status)

        return {
          status: sessionStatus,
          data: {
            ...data,
            razorpay_order_id: payment.order_id || orderId,
            razorpay_payment_id: payment.id,
            latest_status: status,
          },
        } as unknown as GetPaymentStatusOutput
      }

      if (orderId) {
        const paymentsResponse = (await this.client_.orders.fetchPayments(orderId)) as any
        const items = Array.isArray(paymentsResponse?.items)
          ? paymentsResponse.items
          : []

        const captured = items.find((p: any) => p.status === "captured")
        const authorized = items.find((p: any) => p.status === "authorized")
        const latest = items[0] as any | undefined

        if (captured) {
          return {
            status: PaymentSessionStatus.CAPTURED,
            data: {
              ...data,
              razorpay_order_id: orderId,
              razorpay_payment_id: captured.id,
              latest_status: captured.status,
            },
          } as unknown as GetPaymentStatusOutput
        }

        if (authorized) {
          return {
            status: PaymentSessionStatus.PENDING,
            data: {
              ...data,
              razorpay_order_id: orderId,
              razorpay_payment_id: authorized.id,
              latest_status: authorized.status,
              capture_state: "pending_capture",
            },
          } as unknown as GetPaymentStatusOutput
        }

        if (latest) {
          return {
            status: this.mapRazorpayStatusToSessionStatus(latest.status as string),
            data: {
              ...data,
              razorpay_order_id: orderId,
              razorpay_payment_id: latest.id,
              latest_status: latest.status,
            },
          } as unknown as GetPaymentStatusOutput
        }
      }

      return {
        status: PaymentSessionStatus.PENDING,
        data,
      } as unknown as GetPaymentStatusOutput
    } catch (e: any) {
      this.logger_?.error?.("Razorpay getPaymentStatus failed", e)
      throw new MedusaError(
        MedusaError.Types.UNEXPECTED_STATE,
        `Failed to retrieve Razorpay payment status: ${e?.message || "unknown error"}`
      )
    }
  }

  /**
   * Map Razorpay webhooks to Medusa PaymentActions.
   * Webhook endpoint (configured in Razorpay):
   *   /hooks/payment/razorpay_razorpay
   */
  async getWebhookActionAndData(
    payload: ProviderWebhookPayload["payload"]
  ): Promise<WebhookActionResult> {
    const { data, rawData, headers } = payload

    // Verify Razorpay signature
    const signature =
      (headers["x-razorpay-signature"] as string) ||
      (headers["X-Razorpay-Signature"] as string) ||
      ""

    if (!signature) {
      this.logger_?.warn?.("Razorpay webhook missing signature header")
      return {
        action: PaymentActions.FAILED,
        data: {
          session_id: "",
          amount: new BigNumber(0),
        },
      }
    }

    const secret = this.options_.webhookSecret
    if (!secret) {
      this.logger_?.error?.("Razorpay webhookSecret not configured")
      return {
        action: PaymentActions.FAILED,
        data: {
          session_id: "",
          amount: new BigNumber(0),
        },
      }
    }

    const expected = crypto
      .createHmac("sha256", secret)
      .update(rawData as string | Buffer)
      .digest("hex")

    // Constant-time comparison to avoid timing attacks
    const safeEqual =
      expected.length === signature.length &&
      crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature))

    if (!safeEqual) {
      this.logger_?.warn?.("Razorpay webhook signature verification failed")
      return {
        action: PaymentActions.FAILED,
        data: {
          session_id: "",
          amount: new BigNumber(0),
        },
      }
    }

    // At this point, the payload is trusted
    const body = data as any
    const event = (body?.event as string) || ""

    const paymentEntity = body?.payload?.payment?.entity
    const amountMinor = (paymentEntity?.amount as number) || 0
    const sessionId =
      paymentEntity?.notes?.payment_session_id ||
      paymentEntity?.notes?.session_id ||
      (paymentEntity?.order_id as string) ||
      ""

    const bigAmount = new BigNumber(amountMinor)

    switch (event) {
      case "payment.captured":
        // Final successful payment; Medusa will mark session/payment captured
        return {
          action: PaymentActions.SUCCESSFUL,
          data: {
            session_id: sessionId,
            amount: bigAmount,
          },
        }

      case "payment.failed":
        return {
          action: PaymentActions.FAILED,
          data: {
            session_id: sessionId,
            amount: bigAmount,
          },
        }

      default:
        // Ignore other events
        return {
          action: PaymentActions.NOT_SUPPORTED,
        }
    }
  }

  /**
   * Issue a refund through Razorpay. This assumes that the payment has
   * already been captured.
   */
  async refundPayment(
    input: RefundPaymentInput
  ): Promise<RefundPaymentOutput> {
    const data = (input.data || {}) as Record<string, unknown>
    const paymentId = (data.razorpay_payment_id as string) || ""

    if (!paymentId) {
      throw new MedusaError(
        MedusaError.Types.INVALID_DATA,
        "Missing razorpay_payment_id while attempting refund."
      )
    }

    try {
      const amountMinor = this.toMinorUnit(input.amount, "INR")
      let refund: any

      // Prefer refunds API if available, otherwise fall back to payments.refund
      if (this.client_.refunds?.create) {
        refund = await this.client_.refunds.create({
          payment_id: paymentId,
          amount: amountMinor,
        })
      } else {
        refund = await this.client_.payments.refund(paymentId, {
          amount: amountMinor,
        })
      }

      return {
        data: {
          ...data,
          razorpay_refund_id: refund?.id || data.razorpay_refund_id,
          latest_refund_id: refund?.id || data.latest_refund_id,
          latest_refund_status: refund?.status || "processed",
        },
      } as unknown as RefundPaymentOutput
    } catch (e: any) {
      this.logger_?.error?.("Razorpay refundPayment failed", e)
      throw new MedusaError(
        MedusaError.Types.UNEXPECTED_STATE,
        `Failed to refund Razorpay payment: ${e?.message || "unknown error"}`
      )
    }
  }

  /**
   * Retrieve the Razorpay payment object for inspection or debugging.
   */
  async retrievePayment(
    input: RetrievePaymentInput
  ): Promise<RetrievePaymentOutput> {
    const data = (input.data || {}) as Record<string, unknown>
    const paymentId = (data.razorpay_payment_id as string) || ""

    if (!paymentId) {
      return {
        data,
      } as unknown as RetrievePaymentOutput
    }

    try {
      const payment = (await this.client_.payments.fetch(paymentId)) as any
      return {
        data: {
          ...data,
          razorpay_raw_payment: payment,
        },
      } as unknown as RetrievePaymentOutput
    } catch (e: any) {
      this.logger_?.error?.("Razorpay retrievePayment failed", e)
      throw new MedusaError(
        MedusaError.Types.UNEXPECTED_STATE,
        `Failed to retrieve Razorpay payment: ${e?.message || "unknown error"}`
      )
    }
  }

  /**
   * UpdatePayment isn't used heavily for Razorpay. We only echo the
   * existing data, as most changes (amount, capture) are handled
   * explicitly via dedicated flows.
   */
  async updatePayment(
    input: UpdatePaymentInput
  ): Promise<UpdatePaymentOutput> {
    return {
      data: input.data || {},
    } as unknown as UpdatePaymentOutput
  }

  /**
   * Map Razorpay payment.status strings into Medusa PaymentSessionStatus
   * values.
   */
  protected mapRazorpayStatusToSessionStatus(status: string): PaymentSessionStatus {
    switch (status) {
      case "captured":
        return PaymentSessionStatus.CAPTURED
      case "authorized":
        return PaymentSessionStatus.PENDING
      case "failed":
        return PaymentSessionStatus.ERROR
      case "refunded":
      case "partial_refund":
        return PaymentSessionStatus.CAPTURED
      default:
        return PaymentSessionStatus.PENDING
    }
  }
}

export default RazorpayProviderService
