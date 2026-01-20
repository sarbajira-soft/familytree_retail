import { AbstractAuthModuleProvider, MedusaError } from "@medusajs/framework/utils"
import type {
  AuthIdentityProviderService,
  AuthenticationInput,
  AuthenticationResponse,
  Logger,
} from "@medusajs/framework/types"

type InjectedDependencies = {
  logger?: Logger
}

type Options = {
  backendUrl: string
}

class AppSsoAuthProviderService extends AbstractAuthModuleProvider {
  static identifier = "app-sso"

  protected logger_: Logger | undefined
  protected options_: Options

  constructor(container: InjectedDependencies, options: Options) {
    // @ts-ignore - base class constructor signature is compatible
    super(container, options)

    this.logger_ = container.logger
    this.options_ = options

    if (!this.options_?.backendUrl) {
      throw new MedusaError(
        MedusaError.Types.INVALID_DATA,
        "App SSO auth provider requires backendUrl."
      )
    }
  }

  static validateOptions(options: Record<string, any>) {
    if (!options?.backendUrl) {
      throw new MedusaError(
        MedusaError.Types.INVALID_DATA,
        "App SSO auth provider options must include backendUrl."
      )
    }
  }

  protected extractBearerToken(headers: Record<string, any> | undefined) {
    const raw = (headers?.authorization || headers?.Authorization) as string | undefined
    if (!raw) {
      return null
    }

    const parts = raw.split(" ")
    if (parts.length === 2 && /^Bearer$/i.test(parts[0])) {
      return parts[1]
    }

    return raw
  }

  protected async fetchAppProfile(appToken: string) {
    const url = `${this.options_.backendUrl.replace(/\/$/, "")}/user/myProfile`

    const res = await fetch(url, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${appToken}`,
      },
    })

    if (!res.ok) {
      throw new MedusaError(
        MedusaError.Types.UNAUTHORIZED,
        `App session invalid (${res.status})`
      )
    }

    const json: any = await res.json()
    return json?.data || json
  }

  async authenticate(
    data: AuthenticationInput,
    authIdentityProviderService: AuthIdentityProviderService
  ): Promise<AuthenticationResponse> {
    try {
      const token = this.extractBearerToken(data?.headers as any)
      if (!token) {
        return { success: false, error: "Missing app bearer token" }
      }

      const profile = await this.fetchAppProfile(token)
      const email = (profile?.email as string | undefined)?.trim()?.toLowerCase()

      if (!email) {
        return { success: false, error: "App profile missing email" }
      }

      const firstName =
        (profile?.userProfile?.firstName as string | undefined) ||
        (profile?.userProfile?.first_name as string | undefined) ||
        (profile?.firstName as string | undefined) ||
        (profile?.first_name as string | undefined) ||
        null

      const lastName =
        (profile?.userProfile?.lastName as string | undefined) ||
        (profile?.userProfile?.last_name as string | undefined) ||
        (profile?.lastName as string | undefined) ||
        (profile?.last_name as string | undefined) ||
        null

      const fallbackFirstName = email.split("@")[0]
      const resolvedFirstName = firstName || fallbackFirstName
      const resolvedLastName = lastName || null

      let authIdentity: any

      try {
        authIdentity = await authIdentityProviderService.retrieve({
          entity_id: email,
        })
      } catch {
        authIdentity = await authIdentityProviderService.create({
          entity_id: email,
          user_metadata: {
            email,
            first_name: resolvedFirstName,
            last_name: resolvedLastName,
          },
        })
      }

      authIdentity.user_metadata = {
        ...(authIdentity.user_metadata || {}),
        email,
        first_name: resolvedFirstName,
        last_name: resolvedLastName,
      }

      return {
        success: true,
        authIdentity,
      }
    } catch (e: any) {
      this.logger_?.warn?.(`App SSO authenticate failed: ${e?.message || e }`)
      return {
        success: false,
        error: e?.message || "Authentication failed",
      }
    }
  }

  async register(
    data: AuthenticationInput,
    authIdentityProviderService: AuthIdentityProviderService
  ): Promise<AuthenticationResponse> {
    return this.authenticate(data, authIdentityProviderService)
  }

  async update(
    _data: Record<string, unknown>,
    _authIdentityProviderService: AuthIdentityProviderService
  ): Promise<AuthenticationResponse> {
    return {
      success: false,
      error: "Not supported",
    }
  }
}

export default AppSsoAuthProviderService
