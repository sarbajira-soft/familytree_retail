import type { MedusaContainer } from "@medusajs/framework/types"

import { RazorpayPaymentOrchestrator } from "../services/razorpay-payment-orchestrator"

export default async function razorpayExpireCarts(container: MedusaContainer) {
  const orchestrator = new RazorpayPaymentOrchestrator(container)
  const limit = Number(process.env.RAZORPAY_EXPIRE_LIMIT || 50)

  await orchestrator.expireStaleAttempts(limit)
}

export const config = {
  name: "razorpay-expire-carts",
  schedule: process.env.RAZORPAY_EXPIRE_SCHEDULE || "*/2 * * * *",
}
