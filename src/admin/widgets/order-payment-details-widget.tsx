import { defineWidgetConfig } from "@medusajs/admin-sdk"
import type { AdminOrder, DetailWidgetProps } from "@medusajs/framework/types"
import { Container, Heading, Text } from "@medusajs/ui"

const OrderPaymentDetailsWidget = ({
  data: order,
}: DetailWidgetProps<AdminOrder>) => {
  const context = ((order as any).context || {}) as Record<string, any>

  const paymentStatus = (order as any).payment_status || "n/a"

  const paymentTypeHintRaw =
    (typeof context.payment_type === "string" && context.payment_type) ||
    (typeof context.payment_mode === "string" && context.payment_mode) ||
    (typeof context.payment_method === "string" && context.payment_method) ||
    undefined

  const paymentsRaw =
    ((order as any).payment_collections || []) as Array<
      { payments?: any[] } | undefined
    >

  const payments: any[] = []

  for (const pc of paymentsRaw) {
    if (pc?.payments && Array.isArray(pc.payments)) {
      payments.push(...pc.payments)
    }
  }

  let detectedType = "Unknown"
  let detectedSource = ""

  if (paymentTypeHintRaw) {
    const lower = paymentTypeHintRaw.toLowerCase()
    if (
      lower.includes("online") ||
      lower.includes("razorpay") ||
      lower.includes("prepaid") ||
      lower.includes("card") ||
      lower.includes("upi")
    ) {
      detectedType = "Online"
    } else if (
      lower.includes("cod") ||
      lower.includes("cash_on_delivery") ||
      lower.includes("cash-on-delivery")
    ) {
      detectedType = "COD"
    }
    detectedSource = "From context.payment_type/mode/method"
  } else if (payments.length) {
    const hasOnlineProvider = payments.some((p) => {
      const provider = (p as any).provider_id as string | undefined
      if (!provider) return false
      const lower = provider.toLowerCase()
      return (
        lower.includes("razorpay") ||
        lower.includes("stripe") ||
        lower.includes("online") ||
        lower.includes("card") ||
        lower.includes("upi")
      )
    })

    detectedType = hasOnlineProvider ? "Online" : "COD"
    detectedSource = "Inferred from payment providers"
  }

  return (
    <Container className="divide-y p-0">
      <div className="flex items-center justify-between px-6 py-4">
        <Heading level="h2">Payment details</Heading>
      </div>
      <div className="space-y-3 px-6 py-4 text-sm">
        <div>
          <Text weight="plus">Order payment status</Text>
          <Text className="text-ui-fg-subtle">{String(paymentStatus)}</Text>
        </div>
        <div>
          <Text weight="plus">Detected payment type</Text>
          <Text className="text-ui-fg-subtle">
            {detectedType}
            {detectedSource ? ` (${detectedSource})` : ""}
          </Text>
          {paymentTypeHintRaw && (
            <Text className="text-ui-fg-subtle">
              Context hint: {String(paymentTypeHintRaw)}
            </Text>
          )}
        </div>
        {payments.length > 0 && (
          <div className="space-y-1">
            <Text weight="plus">Payments</Text>
            {payments.map((p) => {
              const provider = (p as any).provider_id || "unknown"
              const status = (p as any).status || "unknown"
              const amount = (p as any).amount || (p as any).captured_amount
              const currency = (p as any).currency_code || (order as any).currency_code

              return (
                <div
                  key={(p as any).id || `${provider}-${status}`}
                  className="flex flex-col text-xs text-ui-fg-subtle"
                >
                  <span>
                    Provider: {String(provider)} | Status: {String(status)}
                  </span>
                  {amount != null && (
                    <span>
                      Amount: {Number(amount)} {String(currency || "")}
                    </span>
                  )}
                </div>
              )}
            )}
          </div>
        )}
      </div>
    </Container>
  )
}

export const config = defineWidgetConfig({
  zone: "order.details.after",
})

export default OrderPaymentDetailsWidget
