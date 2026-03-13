import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { Modules } from "@medusajs/framework/utils"

type ResponseBody = {
  success: boolean
  customer?: any
  message?: string
}

export const AUTHENTICATE = false

export async function GET(
  req: MedusaRequest,
  res: MedusaResponse<ResponseBody>
) {
  try {
    const customerId = (req.params as any)?.id as string | undefined

    if (!customerId) {
      res.status(400).json({ success: false, message: "Missing customer id" })
      return
    }

    const customerModuleService: any = req.scope.resolve(Modules.CUSTOMER)
    const customer = await customerModuleService.retrieveCustomer(customerId)

    res.status(200).json({ success: true, customer })
  } catch (e: any) {
    res
      .status(400)
      .json({ success: false, message: e?.message || "Failed to retrieve customer" })
  }
}
