import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"

export async function POST(req: MedusaRequest, res: MedusaResponse) {
  res.status(400).json({
    message: "Use POST /store/app-sso/login with the app Authorization Bearer token.",
  })
}
