import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import type { Logger } from "@medusajs/framework/types"
import { MedusaError, Modules } from "@medusajs/framework/utils"
import crypto from "crypto"
import Razorpay from "razorpay"

type VerifyBody = {
  payment_collection_id?: string
  razorpay_order_id?: string
  razorpay_payment_id?: string
  razorpay_signature?: string
}

function computeRazorpaySignature(params: {
  orderId: string
  paymentId: string
  keySecret: string
}) {
  const { orderId, paymentId, keySecret } = params
  const body = `${orderId}|${paymentId}`
  return crypto.createHmac("sha256", keySecret).update(body).digest("hex")
}

function getCurrencyDecimals(code: string) {
  const c = (code || "").toUpperCase()

  // Zero-decimal currencies (amounts are already integers in major units).
  // This list is intentionally small; add more if you support them.
  const zeroDecimal = new Set([
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

  return zeroDecimal.has(c) ? 0 : 2
}

export const POST = async (req: MedusaRequest, res: MedusaResponse) => {
  const logger: Logger = req.scope.resolve("logger")

  const body = (req.body || {}) as VerifyBody

  const paymentCollectionId = (body.payment_collection_id || "").toString()
  const razorpayOrderId = (body.razorpay_order_id || "").toString()
  const razorpayPaymentId = (body.razorpay_payment_id || "").toString()
  const razorpaySignature = (body.razorpay_signature || "").toString()

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
    logger.error?.("Razorpay verify: RAZORPAY_KEY_SECRET is not configured")
    throw new MedusaError(
      MedusaError.Types.UNEXPECTED_STATE,
      "Razorpay key secret is not configured on the server"
    )
  }

  const keyId = process.env.RAZORPAY_KEY_ID
  if (!keyId) {
    logger.error?.("Razorpay verify: RAZORPAY_KEY_ID is not configured")
    throw new MedusaError(
      MedusaError.Types.UNEXPECTED_STATE,
      "Razorpay key id is not configured on the server"
    )
  }

  const expectedSignature = computeRazorpaySignature({
    orderId: razorpayOrderId,
    paymentId: razorpayPaymentId,
    keySecret,
  })

  const safeEqual =
    expectedSignature.length === razorpaySignature.length &&
    crypto.timingSafeEqual(
      Buffer.from(expectedSignature),
      Buffer.from(razorpaySignature)
    )

  if (!safeEqual) {
    logger.warn?.(
      JSON.stringify({
        message: "Razorpay verify: signature mismatch",
        paymentCollectionId,
        razorpayOrderId,
        razorpayPaymentId,
      })
    )

    throw new MedusaError(
      MedusaError.Types.UNAUTHORIZED,
      "Invalid Razorpay signature"
    )
  }

  const paymentModuleService: any = req.scope.resolve(Modules.PAYMENT)

  const sessions = await paymentModuleService.listPaymentSessions({
    payment_collection_id: paymentCollectionId,
    provider_id: "pp_razorpay_razorpay",
  })

  const session = sessions?.[0]
  if (!session?.id) {
    throw new MedusaError(
      MedusaError.Types.NOT_FOUND,
      `No Razorpay payment session found for collection ${paymentCollectionId}`
    )
  }

  logger.info?.(
    JSON.stringify({
      message: "Razorpay verify: loaded Medusa session",
      paymentCollectionId,
      sessionId: session.id,
      sessionAmount: session.amount,
      sessionCurrency: session.currency_code,
      providerId: session.provider_id,
      sessionDataKeys: Object.keys(session.data || {}),
      razorpayOrderId,
      razorpayPaymentId,
    })
  )

  // Fetch payment from Razorpay and validate it against the session.
  // This protects against tampered amount/currency/order ids.
  const client = new Razorpay({
    key_id: keyId,
    key_secret: keySecret,
  })

  let payment: any
  try {
    payment = await client.payments.fetch(razorpayPaymentId)
  } catch (e: any) {
    logger.warn?.(
      JSON.stringify({
        message: "Razorpay verify: failed to fetch payment from Razorpay",
        paymentCollectionId,
        razorpayPaymentId,
        error_message: e?.message,
      })
    )
    throw new MedusaError(
      MedusaError.Types.UNEXPECTED_STATE,
      "Unable to verify payment with Razorpay"
    )
  }

  const paymentOrderId = (payment?.order_id as string | undefined) || ""
  const paymentCurrency = (payment?.currency as string | undefined) || ""
  const paymentAmount = (payment?.amount as number | undefined) || 0

  logger.info?.(
    JSON.stringify({
      message: "Razorpay verify: fetched Razorpay payment",
      paymentCollectionId,
      sessionId: session.id,
      razorpayPaymentId,
      razorpayOrderIdProvided: razorpayOrderId,
      razorpayOrderIdFromPayment: paymentOrderId,
      razorpayCurrency: paymentCurrency,
      razorpayAmount: paymentAmount,
      razorpayStatus: payment?.status,
      razorpayCaptured: payment?.captured,
      razorpayMethod: payment?.method,
    })
  )

  if (!paymentOrderId || paymentOrderId !== razorpayOrderId) {
    logger.warn?.(
      JSON.stringify({
        message: "Razorpay verify: order_id mismatch",
        paymentCollectionId,
        sessionId: session.id,
        razorpayOrderIdProvided: razorpayOrderId,
        razorpayOrderIdFromPayment: paymentOrderId,
      })
    )
    throw new MedusaError(
      MedusaError.Types.INVALID_DATA,
      "Razorpay payment does not belong to the provided order"
    )
  }

  const sessionCurrency = (session.currency_code || "").toString().toUpperCase()
  const expectedCurrency = sessionCurrency || (paymentCurrency || "").toString().toUpperCase()

  if (paymentCurrency && expectedCurrency && paymentCurrency.toUpperCase() !== expectedCurrency) {
    logger.warn?.(
      JSON.stringify({
        message: "Razorpay verify: currency mismatch",
        paymentCollectionId,
        sessionId: session.id,
        sessionCurrency,
        paymentCurrency,
        expectedCurrency,
      })
    )
    throw new MedusaError(
      MedusaError.Types.INVALID_DATA,
      "Razorpay payment currency mismatch"
    )
  }

  // Razorpay payment.amount is in minor units.
  // In this project, session.amount appears to be stored in major units (e.g. 657 INR)
  // while Razorpay returns minor units (e.g. 65700 paise). To keep verification strict
  // but compatible, accept either:
  // - session already in minor units
  // - session in major units converted to minor units using currency decimals
  const sessionAmount = typeof session.amount === "number" ? session.amount : Number(session.amount)
  const decimals = getCurrencyDecimals(expectedCurrency || sessionCurrency || paymentCurrency || "")
  const minorFactor = Math.pow(10, decimals)
  const expectedMinorFromSession = sessionAmount
  const expectedMinorFromMajor = Math.round(sessionAmount * minorFactor)

  const matchesAmount =
    Number.isFinite(sessionAmount) &&
    sessionAmount > 0 &&
    (paymentAmount === expectedMinorFromSession ||
      paymentAmount === expectedMinorFromMajor)

  if (Number.isFinite(sessionAmount) && sessionAmount > 0 && !matchesAmount) {
    logger.warn?.(
      JSON.stringify({
        message: "Razorpay verify: amount mismatch",
        paymentCollectionId,
        sessionId: session.id,
        sessionAmount,
        decimals,
        expectedMinorFromSession,
        expectedMinorFromMajor,
        paymentAmountFromRazorpay: paymentAmount,
        sessionCurrency,
        paymentCurrency,
      })
    )
    throw new MedusaError(
      MedusaError.Types.INVALID_DATA,
      "Razorpay payment amount mismatch"
    )
  }

  // Persist Razorpay IDs onto the session data so provider can verify via API.
  await paymentModuleService.updatePaymentSession({
    id: session.id,
    // Some Medusa versions require passing amount/currency_code on update.
    amount: session.amount,
    currency_code: session.currency_code,
    data: {
      ...(session.data || {}),
      order_id: razorpayOrderId,
      razorpay_order_id: razorpayOrderId,
      razorpay_payment_id: razorpayPaymentId,
      razorpay_signature: razorpaySignature,
      razorpay_currency: paymentCurrency || undefined,
      razorpay_amount: paymentAmount || undefined,
    },
  })

  let authorized = null

  try {
    authorized = await paymentModuleService.authorizePaymentSession(session.id, {})
  } catch (e: any) {
    // authorization can fail if still pending; caller can poll again.
    logger.warn?.("Razorpay verify: authorizePaymentSession failed", {
      paymentCollectionId,
      sessionId: session.id,
      message: e?.message,
    })
  }

  const refreshedSessions = await paymentModuleService.listPaymentSessions({
    id: [session.id],
  })

  const refreshed = refreshedSessions?.[0] || null

  return res.json({
    success: true,
    payment_collection_id: paymentCollectionId,
    payment_session: refreshed,
    payment: authorized || null,
  })
}
