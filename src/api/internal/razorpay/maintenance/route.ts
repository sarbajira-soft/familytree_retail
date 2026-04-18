import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"

import { RazorpayPaymentOrchestrator } from "../../../../services/razorpay-payment-orchestrator"

export const AUTHENTICATE = false

export const POST = async (req: MedusaRequest, res: MedusaResponse) => {
  const orchestrator = new RazorpayPaymentOrchestrator(req.scope)
  orchestrator.verifyMaintenanceSecret(req.headers as Record<string, any>)

  const body = (req.body || {}) as Record<string, unknown>

  const result = await orchestrator.runMaintenance({
    reconcileLimit:
      typeof body.reconcile_limit === "number"
        ? body.reconcile_limit
        : Number(body.reconcile_limit || process.env.RAZORPAY_RECONCILE_LIMIT || 25),
    completionLimit:
      typeof body.completion_limit === "number"
        ? body.completion_limit
        : Number(
            body.completion_limit ||
              process.env.RAZORPAY_COMPLETION_JOB_LIMIT ||
              20
          ),
    expireLimit:
      typeof body.expire_limit === "number"
        ? body.expire_limit
        : Number(body.expire_limit || process.env.RAZORPAY_EXPIRE_LIMIT || 50),
  })

  res.status(200).json(result)
}
