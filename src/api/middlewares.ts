import crypto from "crypto"
import { defineMiddlewares } from "@medusajs/framework/http"
import type {
  MedusaNextFunction,
  MedusaRequest,
  MedusaResponse,
} from "@medusajs/framework/http"

const safeEqual = (a: string, b: string) => {
  const aBuffer = Buffer.from(a)
  const bBuffer = Buffer.from(b)

  if (aBuffer.length !== bBuffer.length) {
    return false
  }

  return crypto.timingSafeEqual(aBuffer, bBuffer)
}

async function customerSyncAuth(
  req: MedusaRequest,
  res: MedusaResponse,
  next: MedusaNextFunction
) {
  const expectedSecret =
    process.env.MEDUSA_CUSTOMER_SYNC_SECRET || process.env.CUSTOMER_SYNC_SECRET

  if (!expectedSecret) {
    res.status(500).json({ message: "Missing MEDUSA_CUSTOMER_SYNC_SECRET" })
    return
  }

  const providedSecret = req.headers["x-customer-sync-secret"]

  if (
    typeof providedSecret !== "string" ||
    !safeEqual(providedSecret, expectedSecret)
  ) {
    res.status(401).json({ message: "Unauthorized" })
    return
  }

  next()
}

export default defineMiddlewares({
  routes: [
    {
      matcher: "/admin/customer-sync",
      middlewares: [customerSyncAuth],
    },
  ],
})
