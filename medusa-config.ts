import { loadEnv, defineConfig } from '@medusajs/framework/utils'
import { Modules, ContainerRegistrationKeys } from "@medusajs/framework/utils"

loadEnv(process.env.NODE_ENV || 'development', process.cwd())

module.exports = defineConfig({
  projectConfig: {
    databaseUrl: process.env.DATABASE_URL,
    http: {
      storeCors: process.env.STORE_CORS!,
      adminCors: process.env.ADMIN_CORS!,
      authCors: process.env.AUTH_CORS!,
      jwtSecret: process.env.JWT_SECRET || "supersecret",
      cookieSecret: process.env.COOKIE_SECRET || "supersecret",
    },
  },
  modules: [
    {
      resolve: "@medusajs/medusa/auth",
      dependencies: [Modules.CACHE, ContainerRegistrationKeys.LOGGER],
      options: {
        providers: [
          {
            resolve: "@medusajs/medusa/auth-emailpass",
            id: "emailpass",
          },
          {
            resolve: "./src/modules/external-auth",
            id: "app-sso",
            options: {
              backendUrl: process.env.APP_BACKEND_URL,
            },
          },
        ],
      },
    },
    {
      // Use the payment module package name so Medusa can resolve it
      resolve: "@medusajs/medusa/payment",
      options: {
        providers: [
          {
            resolve: "./src/modules/razorpay",
            id: "razorpay",
            options: {
              keyId: process.env.RAZORPAY_KEY_ID,
              keySecret: process.env.RAZORPAY_KEY_SECRET,
              webhookSecret: process.env.RAZORPAY_WEBHOOK_SECRET,
            },
          },
        ],
      },
    },
  ],
})
