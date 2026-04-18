import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"

import { MedusaError } from "@medusajs/framework/utils"

import { RazorpayPaymentOrchestrator } from "../../../../../../../services/razorpay-payment-orchestrator"

type RequestBody = {
  payment_id?: string
  amount?: number
  note?: string
  refund_reason_id?: string
}

export const POST = async (req: MedusaRequest, res: MedusaResponse) => {
  const orderId = (req.params?.id || "").toString()
  const body = (req.body || {}) as RequestBody
  const paymentId = (body.payment_id || "").toString()

  if (!orderId || !paymentId) {
    throw new MedusaError(
      MedusaError.Types.INVALID_DATA,
      "order id and payment_id are required"
    )
  }

  const orchestrator = new RazorpayPaymentOrchestrator(req.scope)
  const result = await orchestrator.createRefund({
    orderId,
    paymentId,
    amount: typeof body.amount === "number" ? body.amount : undefined,
    note: body.note || null,
    refundReasonId: body.refund_reason_id || null,
    createdBy: (req as any).auth_context?.actor_id || null,
  })

  res.json(result)
}
