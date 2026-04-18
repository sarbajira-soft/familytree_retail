import type { MedusaContainer } from "@medusajs/framework/types"

import { RazorpayPaymentOrchestrator } from "../services/razorpay-payment-orchestrator"

export default async function razorpayProcessCompletionJobs(
  container: MedusaContainer
) {
  const orchestrator = new RazorpayPaymentOrchestrator(container)
  const limit = Number(process.env.RAZORPAY_COMPLETION_JOB_LIMIT || 20)

  await orchestrator.processCompletionJobs(limit)
}

export const config = {
  name: "razorpay-process-completion-jobs",
  schedule:
    process.env.RAZORPAY_COMPLETION_JOB_SCHEDULE || "*/1 * * * *",
}
