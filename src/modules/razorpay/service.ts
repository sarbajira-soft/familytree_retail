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
    const numeric = typeof amount === "string" ? Number(amount) : (amount as number)

    if (!Number.isFinite(numeric)) {
      throw new MedusaError(
        MedusaError.Types.INVALID_DATA,
        "Invalid amount passed to Razorpay provider."
      )
    }

    // Treat incoming amount as major units (e.g. rupees) and
    // convert to minor units (e.g. paise) for Razorpay.
    return Math.round(numeric * 100)
  }

  /**
   * Initiate a Razorpay order for the payment session.
   * The returned data becomes PaymentSession.data and is exposed to the
   * storefront, so it must not include any secrets.
   */
  async initiatePayment(input: InitiatePaymentInput): Promise<InitiatePaymentOutput> {
    const { amount, currency_code, data, context } = input

    const sessionId = (data?.session_id as string) || (context?.idempotency_key as string) || ""
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

      // Razorpay payment status can be "authorized" (not yet captured)
      // or "captured" when payment_capture=1 or when captured later.
      // Prefer captured if available, otherwise accept authorized.
      const capturedPayment = items.find((p: any) => p.status === "captured")
      const authorizedPayment = items.find((p: any) => p.status === "authorized")
      const successfulPayment = capturedPayment || authorizedPayment

      if (!successfulPayment) {
        // No captured payment yet; leave session pending so that
        // webhooks can still move it to SUCCESSFUL when they arrive.
        return {
          data: {
            ...data,
            latest_status: "pending",
          },
          status: PaymentSessionStatus.PENDING,
        }
      }

      const razorpayStatus = (successfulPayment.status as string) || ""

      return {
        data: {
          ...data,
          razorpay_order_id: orderId,
          razorpay_payment_id: successfulPayment.id,
          latest_status: razorpayStatus,
        },
        status:
          razorpayStatus === "captured"
            ? PaymentSessionStatus.CAPTURED
            : PaymentSessionStatus.AUTHORIZED,
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
    return {
      data: input.data || {},
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

      // Prefer refunds API if available, otherwise fall back to payments.refund
      if (this.client_.refunds?.create) {
        await this.client_.refunds.create({
          payment_id: paymentId,
          amount: amountMinor,
        })
      } else {
        await this.client_.payments.refund(paymentId, {
          amount: amountMinor,
        })
      }

      return {
        data,
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
        return PaymentSessionStatus.AUTHORIZED
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
