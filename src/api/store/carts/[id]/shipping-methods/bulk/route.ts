import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { addShippingMethodToCartWorkflow } from "@medusajs/core-flows"
import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils"

type BulkShippingMethodBody = {
  options?: Array<{
    option_id?: string
    data?: Record<string, unknown>
  }>
  additional_data?: Record<string, unknown>
}

export const POST = async (req: MedusaRequest, res: MedusaResponse) => {
  const payload = (req.body || {}) as BulkShippingMethodBody
  const options = Array.isArray(payload.options)
    ? payload.options
        .map((option) => ({
          id: (option?.option_id || "").toString().trim(),
          data:
            option?.data && typeof option.data === "object" ? option.data : {},
        }))
        .filter((option) => option.id)
    : []

  if (!options.length) {
    return res.status(400).json({
      message: "At least one shipping option is required",
      type: "invalid_data",
    })
  }

  const cartModule = req.scope.resolve(Modules.CART)
  const existingCart = await cartModule.retrieveCart(req.params.id, {
    relations: ["shipping_methods"],
  })
  const existingMethodIds = Array.isArray(existingCart?.shipping_methods)
    ? existingCart.shipping_methods
        .map((method: any) => method?.id)
        .filter((id: unknown) => typeof id === "string" && id)
    : []

  if (existingMethodIds.length) {
    await cartModule.deleteShippingMethods(existingMethodIds)
  }

  await addShippingMethodToCartWorkflow(req.scope).run({
    input: {
      cart_id: req.params.id,
      options,
      additional_data: payload.additional_data,
    },
  })

  const query = req.scope.resolve(ContainerRegistrationKeys.QUERY)

  const { data } = await query.graph({
    entity: "cart",
    fields: req.queryConfig?.fields?.length ? req.queryConfig.fields : ["*"],
    filters: {
      id: req.params.id,
    },
  })

  const cart = Array.isArray(data) ? data[0] : null

  res.status(200).json({ cart })
}
