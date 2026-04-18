import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"

import { RazorpayPaymentOrchestrator } from "../../../../../services/razorpay-payment-orchestrator"

export const GET = async (req: MedusaRequest, res: MedusaResponse) => {
  const cartId =
    (req.query?.cart_id as string | undefined) ||
    (req.validatedQuery?.cart_id as string | undefined) ||
    ""

  const orchestrator = new RazorpayPaymentOrchestrator(req.scope)
  const result = await orchestrator.syncCart(cartId)

  res.json(result)
}
