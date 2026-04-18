import crypto from "crypto"
import { defineMiddlewares } from "@medusajs/framework/http"
import type {
  MedusaNextFunction,
  MedusaRequest,
  MedusaResponse,
} from "@medusajs/framework/http"
import { Modules } from "@medusajs/framework/utils"

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

type RateLimitOptions = {
  keyPrefix: string
  limit: number
  windowSeconds: number
}

const fallbackRateLimitStore = new Map<
  string,
  { count: number; resetAt: number }
>()

function getClientIp(req: MedusaRequest) {
  const forwardedFor = (req.headers["x-forwarded-for"] as string | undefined)
    ?.split(",")[0]
    ?.trim()

  if (forwardedFor) {
    return forwardedFor
  }

  // @ts-ignore Express assigns ip at runtime.
  if (typeof req.ip === "string" && req.ip) {
    // @ts-ignore
    return req.ip as string
  }

  // @ts-ignore Node socket exists at runtime.
  return req.socket?.remoteAddress || "unknown"
}

function buildRateLimiter(options: RateLimitOptions) {
  return async (
    req: MedusaRequest,
    res: MedusaResponse,
    next: MedusaNextFunction
  ) => {
    const key = `${options.keyPrefix}:${getClientIp(req)}`
    const now = Date.now()
    const cache = req.scope.resolve(Modules.CACHE)

    let entry =
      (await cache
        .get<{ count: number; resetAt: number }>(key)
        .catch(() => null)) || fallbackRateLimitStore.get(key) || null

    if (!entry || entry.resetAt <= now) {
      entry = {
        count: 0,
        resetAt: now + options.windowSeconds * 1000,
      }
    }

    entry.count += 1

    const ttlSeconds = Math.max(
      1,
      Math.ceil((entry.resetAt - now) / 1000)
    )

    await cache.set(key, entry, ttlSeconds).catch(() => {
      fallbackRateLimitStore.set(key, entry!)
    })

    res.setHeader("X-RateLimit-Limit", String(options.limit))
    res.setHeader(
      "X-RateLimit-Remaining",
      String(Math.max(options.limit - entry.count, 0))
    )

    if (entry.count > options.limit) {
      res.status(429).json({
        message: "Too many requests. Please try again shortly.",
      })
      return
    }

    next()
  }
}

const razorpaySessionRateLimit = buildRateLimiter({
  keyPrefix: "razorpay-session",
  limit: Number(process.env.RAZORPAY_SESSION_RATE_LIMIT || 12),
  windowSeconds: Number(process.env.RAZORPAY_SESSION_RATE_WINDOW || 60),
})

const razorpayVerifyRateLimit = buildRateLimiter({
  keyPrefix: "razorpay-verify",
  limit: Number(process.env.RAZORPAY_VERIFY_RATE_LIMIT || 20),
  windowSeconds: Number(process.env.RAZORPAY_VERIFY_RATE_WINDOW || 300),
})

const razorpayRecoveryRateLimit = buildRateLimiter({
  keyPrefix: "razorpay-recovery",
  limit: Number(process.env.RAZORPAY_RECOVERY_RATE_LIMIT || 90),
  windowSeconds: Number(process.env.RAZORPAY_RECOVERY_RATE_WINDOW || 60),
})

const razorpayWebhookRateLimit = buildRateLimiter({
  keyPrefix: "razorpay-webhook",
  limit: Number(process.env.RAZORPAY_WEBHOOK_RATE_LIMIT || 240),
  windowSeconds: Number(process.env.RAZORPAY_WEBHOOK_RATE_WINDOW || 60),
})

export default defineMiddlewares({
  routes: [
    {
      matcher: "/admin/customer-sync",
      middlewares: [customerSyncAuth],
    },
    {
      matcher: "/admin/customer-sync/customer/*",
      middlewares: [customerSyncAuth],
    },
    {
      matcher: "/admin/customer-sync/orders",
      middlewares: [customerSyncAuth],
    },
    {
      matcher: "/admin/customer-sync/orders/*",
      middlewares: [customerSyncAuth],
    },
    {
      matcher: "/store/payments/razorpay/session",
      middlewares: [razorpaySessionRateLimit],
    },
    {
      matcher: "/store/payments/razorpay/verify",
      middlewares: [razorpayVerifyRateLimit],
    },
    {
      matcher: "/store/payments/razorpay/recovery",
      middlewares: [razorpayRecoveryRateLimit],
    },
    {
      matcher: "/webhooks/razorpay",
      bodyParser: {
        preserveRawBody: true,
      },
      middlewares: [razorpayWebhookRateLimit],
    },
  ],
})
