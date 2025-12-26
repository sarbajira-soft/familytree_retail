import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { Modules, MedusaError } from "@medusajs/framework/utils"
import { createWorkflow, WorkflowResponse } from "@medusajs/framework/workflows-sdk"
import { setAuthAppMetadataStep } from "@medusajs/medusa/core-flows"

type RequestBody = {
  type?: "password"
  customer_id?: string
  previous_email?: string
  email?: string
  first_name?: string | null
  last_name?: string | null
  phone?: string | null
  password?: string
  metadata?: Record<string, unknown>
}

type SyncResponse = {
  success: boolean
  customer_id?: string
  message?: string
}

const linkCustomerToAuthIdentityWorkflow = createWorkflow(
  "link-customer-to-auth-identity-admin-sync",
  (input: { authIdentityId: string; customerId: string }) => {
    const linked = setAuthAppMetadataStep({
      authIdentityId: input.authIdentityId,
      actorType: "customer",
      value: input.customerId,
    })

    return new WorkflowResponse(linked)
  }
)

export const AUTHENTICATE = false

export async function POST(req: MedusaRequest<RequestBody>, res: MedusaResponse<SyncResponse>) {
  try {
    const customerModuleService: any = req.scope.resolve(Modules.CUSTOMER)
    const authModuleService: any = req.scope.resolve(Modules.AUTH)

    const {
      type,
      customer_id,
      previous_email,
      email,
      first_name,
      last_name,
      phone,
      password,
      metadata,
    } = (req.body || {}) as RequestBody

    if (type === "password") {
      if (!email || !password) {
        throw new MedusaError(MedusaError.Types.INVALID_DATA, "email and password are required")
      }

      const { success, error } = await authModuleService.updateProvider("emailpass", {
        entity_id: email,
        password,
      })

      if (!success) {
        throw new MedusaError(MedusaError.Types.INVALID_DATA, error || "Failed to update password")
      }

      res.status(200).json({ success: true })
      return
    }

    if (!email && !previous_email && !customer_id) {
      throw new MedusaError(
        MedusaError.Types.INVALID_DATA,
        "email, previous_email, or customer_id is required"
      )
    }

    const targetEmail = (email || previous_email) as string

    let customer: any = null

    if (customer_id) {
      customer = await customerModuleService.retrieveCustomer(customer_id).catch(() => null)
    }

    if (!customer && previous_email) {
      const byPrev = await customerModuleService
        .listCustomers({ email: previous_email }, { take: 1 })
        .catch(() => [])
      customer = byPrev?.[0] || null
    }

    if (!customer && email) {
      const byEmail = await customerModuleService
        .listCustomers({ email }, { take: 1 })
        .catch(() => [])
      customer = byEmail?.[0] || null
    }

    if (customer?.id) {
      const updateData: Record<string, any> = {}

      if (email && email !== customer.email) updateData.email = email
      if (first_name !== undefined) updateData.first_name = first_name
      if (last_name !== undefined) updateData.last_name = last_name
      if (phone !== undefined) updateData.phone = phone
      if (metadata !== undefined) updateData.metadata = metadata

      if (Object.keys(updateData).length) {
        await customerModuleService.updateCustomers(customer.id, updateData)
      }

      res.status(200).json({ success: true, customer_id: customer.id })
      return
    }

    // Create customer if not found
    if (!email) {
      throw new MedusaError(MedusaError.Types.INVALID_DATA, "email is required to create customer")
    }

    const created = await customerModuleService.createCustomers([
      {
        email,
        first_name: first_name ?? null,
        last_name: last_name ?? null,
        phone: phone ?? null,
        has_account: true,
        metadata: metadata ?? {},
      },
    ])

    const createdCustomer = Array.isArray(created) ? created[0] : created

    // If password provided, ensure there is an auth identity and link it to the customer.
    if (password) {
      const reg = await authModuleService.register("emailpass", {
        url: req.url,
        headers: req.headers,
        query: req.query,
        body: { email, password },
        protocol: (req as any).protocol,
      })

      const authIdentityId = reg?.authIdentity?.id
      if (authIdentityId) {
        try {
          await linkCustomerToAuthIdentityWorkflow(req.scope).run({
            input: {
              authIdentityId,
              customerId: createdCustomer.id,
            },
          })
        } catch (e: any) {
          const msg = String(e?.message || "")
          if (!msg.includes("Key customer_id already exists")) {
            throw e
          }
        }
      }
    }

    res.status(200).json({ success: true, customer_id: createdCustomer.id })
  } catch (e: any) {
    const message = e?.message || "Internal error"
    res.status(400).json({ success: false, message })
  }
}
