import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"

import { RazorpayPaymentOrchestrator } from "../../../../../services/razorpay-payment-orchestrator"

type RequestBody = {
  cart_id?: string
}

export const POST = async (req: MedusaRequest, res: MedusaResponse) => {
  const body = (req.body || {}) as RequestBody
  const cartId = (body.cart_id || "").toString()

  const orchestrator = new RazorpayPaymentOrchestrator(req.scope)
  const result = await orchestrator.initiateSession({
    cartId,
    customerId: (req as any).auth_context?.actor_id || null,
  })

  res.json(result)
}
