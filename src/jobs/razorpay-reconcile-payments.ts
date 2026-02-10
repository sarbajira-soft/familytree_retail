import type { MedusaContainer } from "@medusajs/framework/types"
import { Modules } from "@medusajs/framework/utils"

export default async function razorpayReconcilePayments(container: MedusaContainer) {
  const logger: any = container.resolve("logger")
  const paymentModuleService: any = container.resolve(Modules.PAYMENT)

  const graceMinutes = Number(process.env.RAZORPAY_RECONCILE_GRACE_MINUTES || 5)
  const lookbackMinutes = Number(process.env.RAZORPAY_RECONCILE_LOOKBACK_MINUTES || 24 * 60)
  const limit = Number(process.env.RAZORPAY_RECONCILE_LIMIT || 50)

  const now = Date.now()
  const createdAfter = new Date(now - lookbackMinutes * 60 * 1000)
  const createdBefore = new Date(now - graceMinutes * 60 * 1000)

  const startedAt = Date.now()
  logger.info?.(
    JSON.stringify({
      message: "Razorpay reconcile: start",
      graceMinutes,
      lookbackMinutes,
      limit,
      createdAfter: createdAfter.toISOString(),
      createdBefore: createdBefore.toISOString(),
    })
  )

  let sessions: any[] = []

  try {
    sessions = await paymentModuleService.listPaymentSessions(
      {
        provider_id: "pp_razorpay_razorpay",
        status: ["pending", "requires_more"],
        created_at: {
          $gte: createdAfter,
          $lte: createdBefore,
        },
      },
      {
        take: limit,
      }
    )
  } catch (e: any) {
    logger.error?.(
      JSON.stringify({
        message: "Razorpay reconcile: failed to list payment sessions",
        error_message: e?.message,
      })
    )
    return
  }

  if (!Array.isArray(sessions) || sessions.length === 0) {
    logger.info?.(
      JSON.stringify({
        message: "Razorpay reconcile: no sessions to process",
        duration_ms: Date.now() - startedAt,
      })
    )
    return
  }

  logger.info?.(
    JSON.stringify({
      message: "Razorpay reconcile: sessions found",
      count: sessions.length,
    })
  )

  for (const session of sessions) {
    if (!session?.id) continue

    try {
      // Re-authorize by asking the provider for latest status.
      // This will call RazorpayProviderService.authorizePayment which checks
      // captured payments via orders.fetchPayments.
      await paymentModuleService.authorizePaymentSession(session.id, {})

      logger.info?.(
        JSON.stringify({
          message: "Razorpay reconcile: authorized session",
          session_id: session.id,
        })
      )
    } catch (e: any) {
      // Ignore failures; session stays pending and will be retried on next run.
      logger.warn?.(
        JSON.stringify({
          message: "Razorpay reconcile: authorizePaymentSession failed",
          session_id: session.id,
          error_message: e?.message,
        })
      )
    }
  }

  logger.info?.(
    JSON.stringify({
      message: "Razorpay reconcile: end",
      duration_ms: Date.now() - startedAt,
      processed: sessions.length,
    })
  )
}

export const config = {
  name: "razorpay-reconcile-payments",
  schedule: process.env.RAZORPAY_RECONCILE_SCHEDULE || "*/5 * * * *",
}
