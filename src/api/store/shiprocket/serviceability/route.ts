import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import type { Logger } from "@medusajs/framework/types"

import { ShiprocketService } from "../../../../services/shiprocket"

export const POST = async (req: MedusaRequest, res: MedusaResponse) => {
  const logger: Logger = req.scope.resolve("logger")

  const pickupPostcode = process.env.SHIPROCKET_PICKUP_POSTCODE
  const defaultWeight = Number(process.env.SHIPROCKET_DEFAULT_WEIGHT_KG || 0.5)

  if (!pickupPostcode) {
    logger.warn?.(
      "Shiprocket serviceability: SHIPROCKET_PICKUP_POSTCODE is not configured, cannot check serviceability"
    )
    return res.status(500).json({
      serviceable: false,
      error: "Shiprocket pickup postcode is not configured on the server",
    })
  }

  const body = (req.body || {}) as any
  const deliveryPostcode: string | undefined = body.postal_code || body.pincode

  if (!deliveryPostcode) {
    return res.status(400).json({
      serviceable: false,
      error: "postal_code is required",
    })
  }

  const shiprocket = new ShiprocketService(logger)

  const weight = typeof body.weight === "number" ? body.weight : defaultWeight

  const rawCod = body.cod
  const cod =
    rawCod === 1 || rawCod === "1" || rawCod === true
      ? 1
      : rawCod === 0 || rawCod === "0" || rawCod === false
      ? 0
      : 0

  const length = typeof body.length === "number" ? body.length : undefined
  const breadth = typeof body.breadth === "number" ? body.breadth : undefined
  const height = typeof body.height === "number" ? body.height : undefined
  const declared_value =
    typeof body.declared_value === "number" ? body.declared_value : undefined
  const mode = typeof body.mode === "string" ? body.mode : undefined
  const is_return = typeof body.is_return === "number" ? body.is_return : undefined
  const couriers_type =
    typeof body.couriers_type === "number" ? body.couriers_type : undefined
  const only_local = typeof body.only_local === "number" ? body.only_local : undefined
  const qc_check = typeof body.qc_check === "number" ? body.qc_check : undefined

  const result = await shiprocket.checkServiceability({
    pickup_postcode: pickupPostcode,
    delivery_postcode: deliveryPostcode,
    weight,
    cod,
    length,
    breadth,
    height,
    declared_value,
    mode,
    is_return,
    couriers_type,
    only_local,
    qc_check,
  })

  if (!result || !Array.isArray(result.courier_company) || result.courier_company.length === 0) {
    return res.json({
      serviceable: false,
      couriers: [],
    })
  }

  const bestCourier = result.courier_company[0]

  return res.json({
    serviceable: true,
    couriers: result.courier_company,
    best_courier: bestCourier,
  })
}
