import { loadEnv, defineConfig } from "@medusajs/framework/utils"
import { Modules, ContainerRegistrationKeys } from "@medusajs/framework/utils"

loadEnv(process.env.NODE_ENV || "production", process.cwd())

module.exports = defineConfig({
  projectConfig: {
    databaseUrl: process.env.DATABASE_URL,
    http: {
      storeCors: process.env.STORE_CORS!,
      adminCors: process.env.ADMIN_CORS!,
      authCors: process.env.AUTH_CORS!,
      jwtSecret: process.env.JWT_SECRET!,
      cookieSecret: process.env.COOKIE_SECRET!,
    },
  },

  modules: [
    {
      resolve: "@medusajs/file",
      options: {
        providers: [
          {
            resolve: "./src/modules/file-s3-no-acl",
            id: "s3-no-acl",
            options: {
              bucket: process.env.S3_BUCKET,
              region: process.env.S3_REGION,
              access_key_id: process.env.S3_ACCESS_KEY,
              secret_access_key: process.env.S3_SECRET_KEY,
              prefix: process.env.RETAIL_PRODUCT_PATH || "products/",
              cache_control: "public, max-age=31536000",
            },
          },
        ],
      },
    },

    // AUTH
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

    // FULFILLMENT
    {
      resolve: "@medusajs/medusa/fulfillment",
      options: {
        providers: [
          {
            resolve: "@medusajs/medusa/fulfillment-manual",
            id: "manual",
            options: {},
          },
          {
            resolve: "./src/modules/shiprocket",
            id: "shiprocket",
            options: {},
          },
        ],
      },
    },

    // PAYMENT
    {
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