import type { MedusaContainer } from "@medusajs/framework/types"

import { PAYMENT_ORCHESTRATION_MODULE } from "../modules/payment-orchestration/constants"
import PaymentOrchestrationModuleService from "../modules/payment-orchestration/service"
import { RazorpayPaymentOrchestrator } from "../services/razorpay-payment-orchestrator"

export default async function razorpayReconcilePayments(
  container: MedusaContainer
) {
  const logger: any = container.resolve("logger")
  const orchestrator = new RazorpayPaymentOrchestrator(container)
  const orchestrationModule = container.resolve(
    PAYMENT_ORCHESTRATION_MODULE
  ) as PaymentOrchestrationModuleService

  const limit = Number(process.env.RAZORPAY_RECONCILE_LIMIT || 25)

  const attempts = await orchestrationModule.listRecoverableAttempts(
    new Date(),
    limit
  )

  logger.info?.(
    JSON.stringify({
      message: "Razorpay reconcile: start",
      count: attempts.length,
    })
  )

  for (const attempt of attempts) {
    try {
      await orchestrator.syncAttemptFromRazorpay(attempt.id)
    } catch (error: any) {
      logger.warn?.(
        JSON.stringify({
          message: "Razorpay reconcile: failed to sync attempt",
          attempt_id: attempt.id,
          error_message: error?.message || "unknown error",
        })
      )
    }
  }

  logger.info?.(
    JSON.stringify({
      message: "Razorpay reconcile: end",
      processed: attempts.length,
    })
  )
}

export const config = {
  name: "razorpay-reconcile-payments",
  schedule: process.env.RAZORPAY_RECONCILE_SCHEDULE || "*/3 * * * *",
}
