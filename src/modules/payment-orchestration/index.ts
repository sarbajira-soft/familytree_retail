import { Module } from "@medusajs/framework/utils"

import PaymentOrchestrationModuleService from "./service"
import { PAYMENT_ORCHESTRATION_MODULE } from "./constants"

export default Module(PAYMENT_ORCHESTRATION_MODULE, {
  service: PaymentOrchestrationModuleService,
})
