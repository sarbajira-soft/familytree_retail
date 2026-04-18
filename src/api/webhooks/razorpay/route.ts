import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"

import { RazorpayPaymentOrchestrator } from "../../../services/razorpay-payment-orchestrator"

export const AUTHENTICATE = false

export const POST = async (req: MedusaRequest, res: MedusaResponse) => {
  const rawBody = Buffer.isBuffer(req.rawBody)
    ? req.rawBody
    : Buffer.from(
        typeof req.rawBody === "string"
          ? req.rawBody
          : JSON.stringify(req.body || {})
      )

  const orchestrator = new RazorpayPaymentOrchestrator(req.scope)
  await orchestrator.handleWebhook(req.body, rawBody, req.headers as Record<string, any>)

  res.sendStatus(200)
}
