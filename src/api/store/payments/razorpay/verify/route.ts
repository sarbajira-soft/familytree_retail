import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"

import { RazorpayPaymentOrchestrator } from "../../../../../services/razorpay-payment-orchestrator"

type VerifyBody = {
  payment_collection_id?: string
  razorpay_order_id?: string
  razorpay_payment_id?: string
  razorpay_signature?: string
}

export const POST = async (req: MedusaRequest, res: MedusaResponse) => {
  const body = (req.body || {}) as VerifyBody

  const orchestrator = new RazorpayPaymentOrchestrator(req.scope)
  const result = await orchestrator.verifyPayment({
    paymentCollectionId: body.payment_collection_id,
    razorpayOrderId: body.razorpay_order_id,
    razorpayPaymentId: body.razorpay_payment_id,
    razorpaySignature: body.razorpay_signature,
  })

  res.json(result)
}
