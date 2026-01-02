import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import type { AuthenticationInput } from "@medusajs/framework/types"
import { Modules, MedusaError } from "@medusajs/framework/utils"
import { createCustomerAccountWorkflow } from "@medusajs/medusa/core-flows"
import { createWorkflow, WorkflowResponse } from "@medusajs/framework/workflows-sdk"
import { setAuthAppMetadataStep } from "@medusajs/medusa/core-flows"

type LinkInput = {
  authIdentityId: string
  customerId: string
}

const linkCustomerToAuthIdentityWorkflow = createWorkflow(
  "link-customer-to-auth-identity",
  (input: LinkInput) => {
    const linked = setAuthAppMetadataStep({
      authIdentityId: input.authIdentityId,
      actorType: "customer",
      value: input.customerId,
    })

    return new WorkflowResponse(linked)
  }
)

function getBaseUrl(req: MedusaRequest) {
  const host = req.headers.host
  if (!host) {
    throw new MedusaError(MedusaError.Types.INVALID_DATA, "Missing Host header")
  }

  const proto =
    (req.headers["x-forwarded-proto"] as string | undefined) ||
    (req.protocol as string | undefined) ||
    "http"

  return `${proto}://${host}`
}

async function callAuthProvider(req: MedusaRequest) {
  const baseUrl = getBaseUrl(req)

  const res = await fetch(`${baseUrl}/auth/customer/app-sso`, {
    method: "POST",
    headers: {
      authorization: String(req.headers.authorization || ""),
      "content-type": "application/json",
    },
    body: JSON.stringify({}),
  })

  const data: any = await res.json().catch(() => ({}))

  if (!res.ok) {
    throw new MedusaError(
      MedusaError.Types.UNAUTHORIZED,
      data?.message || data?.error || "SSO authentication failed"
    )
  }

  const token = data?.token
  if (!token) {
    throw new MedusaError(
      MedusaError.Types.UNEXPECTED_STATE,
      "SSO authentication succeeded but no token was returned"
    )
  }

  return token as string
}

async function refreshToken(req: MedusaRequest, token: string) {
  const baseUrl = getBaseUrl(req)

  const res = await fetch(`${baseUrl}/auth/token/refresh`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
    },
  })

  const data: any = await res.json().catch(() => ({}))

  if (!res.ok) {
    return token
  }

  return (data?.token as string) || token
}

async function canFetchCustomerMe(req: MedusaRequest, token: string) {
  const baseUrl = getBaseUrl(req)

  const publishableKey = req.headers["x-publishable-api-key"] as string | undefined

  const res = await fetch(`${baseUrl}/store/customers/me`, {
    method: "GET",
    headers: {
      authorization: `Bearer ${token}`,
      ...(publishableKey ? { "x-publishable-api-key": publishableKey } : {}),
    },
  })

  return res.ok
}

async function fetchCustomerMe(req: MedusaRequest, token: string) {
  const baseUrl = getBaseUrl(req)
  const publishableKey = req.headers["x-publishable-api-key"] as string | undefined

  const res = await fetch(`${baseUrl}/store/customers/me`, {
    method: "GET",
    headers: {
      authorization: `Bearer ${token}`,
      ...(publishableKey ? { "x-publishable-api-key": publishableKey } : {}),
    },
  })

  if (!res.ok) {
    return null
  }

  const json: any = await res.json().catch(() => null)
  return json?.customer || json
}

type SsoResponse = {
  token: string
}

export async function POST(req: MedusaRequest, res: MedusaResponse<SsoResponse>) {
  if (!req.headers.authorization) {
    res.status(401).json({ message: "Missing Authorization header" } as any)
    return
  }

  try {
    const customerModuleService: any = req.scope.resolve(Modules.CUSTOMER)
    const authModuleService: any = req.scope.resolve(Modules.AUTH)

    // First attempt: get token using provider and see if it already represents a registered customer.
    const initialToken = await callAuthProvider(req)
    const initialOk = await canFetchCustomerMe(req, initialToken)

    if (initialOk) {
      // Even if the customer is already registered, sync name from the main app.
      try {
        const { success, authIdentity } = await authModuleService.authenticate(
          "app-sso",
          {
            url: req.url,
            headers: req.headers as any,
            query: req.query as any,
            body: req.body as any,
            protocol: req.protocol,
          } as AuthenticationInput
        )

        if (success && authIdentity?.user_metadata) {
          const email =
            (authIdentity?.user_metadata?.email as string | undefined) ||
            (authIdentity?.provider_identities?.[0]?.entity_id as string | undefined)

          const first_name =
            (authIdentity?.user_metadata?.first_name as string | undefined) ||
            (authIdentity?.user_metadata?.firstName as string | undefined) ||
            (email ? email.split("@")[0] : null)

          const last_name =
            (authIdentity?.user_metadata?.last_name as string | undefined) ||
            (authIdentity?.user_metadata?.lastName as string | undefined) ||
            null

          const me = await fetchCustomerMe(req, initialToken)
          if (me?.id && (first_name || last_name)) {
            await customerModuleService.updateCustomers(me.id, {
              ...(first_name ? { first_name } : {}),
              ...(last_name ? { last_name } : {}),
            })
          }
        }
      } catch {
        // Ignore name-sync errors; token issuance should still work.
      }

      const token = await refreshToken(req, initialToken)
      res.json({ token })
      return
    }

    // Not registered/linked yet: authenticate to get auth identity then create/link customer.
    const { success, authIdentity, error } = await authModuleService.authenticate(
      "app-sso",
      {
        url: req.url,
        headers: req.headers as any,
        query: req.query as any,
        body: req.body as any,
        protocol: req.protocol,
      } as AuthenticationInput
    )

    if (!success || !authIdentity?.id) {
      throw new MedusaError(
        MedusaError.Types.UNAUTHORIZED,
        error || "Unable to authenticate app session"
      )
    }

    const email =
      (authIdentity?.user_metadata?.email as string | undefined) ||
      (authIdentity?.provider_identities?.[0]?.entity_id as string | undefined)

    if (!email) {
      throw new MedusaError(MedusaError.Types.INVALID_DATA, "Authenticated user has no email")
    }

    const customers = await customerModuleService.listCustomers(
      { email, has_account: true },
      { take: 1 }
    )

    const existingCustomer = customers?.[0]

    if (existingCustomer?.id) {
      const first_name =
        (authIdentity?.user_metadata?.first_name as string | undefined) ||
        (authIdentity?.user_metadata?.firstName as string | undefined) ||
        (email ? email.split("@")[0] : null)

      const last_name =
        (authIdentity?.user_metadata?.last_name as string | undefined) ||
        (authIdentity?.user_metadata?.lastName as string | undefined) ||
        null

      if (
        (first_name && first_name !== existingCustomer.first_name) ||
        (last_name && last_name !== existingCustomer.last_name)
      ) {
        await customerModuleService.updateCustomers(existingCustomer.id, {
          ...(first_name ? { first_name } : {}),
          ...(last_name ? { last_name } : {}),
        })
      }

      try {
        await linkCustomerToAuthIdentityWorkflow(req.scope).run({
          input: {
            authIdentityId: authIdentity.id,
            customerId: existingCustomer.id,
          },
        })
      } catch (err: any) {
        const msg = String(err?.message || "")
        if (!msg.includes("Key customer_id already exists")) {
          throw err
        }
      }
    } else {
      const first_name =
        (authIdentity?.user_metadata?.first_name as string | undefined) ||
        (authIdentity?.user_metadata?.firstName as string | undefined) ||
        (email ? email.split("@")[0] : null)

      const last_name =
        (authIdentity?.user_metadata?.last_name as string | undefined) ||
        (authIdentity?.user_metadata?.lastName as string | undefined) ||
        null

      await createCustomerAccountWorkflow(req.scope).run({
        input: {
          authIdentityId: authIdentity.id,
          customerData: {
            email,
            first_name,
            last_name,
            phone: null,
            has_account: true,
          },
        },
      })
    }

    const token2 = await callAuthProvider(req)
    const token = await refreshToken(req, token2)

    res.json({ token })
  } catch (e: any) {
    console.error("/store/app-sso/login failed", e)

    const message = e?.message || "Internal error"
    const type = e?.type || e?.name

    if (type === MedusaError.Types.UNAUTHORIZED || /unauthorized/i.test(String(type))) {
      res.status(401).json({ message } as any)
      return
    }

    if (type === MedusaError.Types.INVALID_DATA || /invalid/i.test(String(type))) {
      res.status(400).json({ message } as any)
      return
    }

    res.status(500).json({ message } as any)
  }
}
