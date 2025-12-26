import axios, { AxiosInstance } from "axios"


export type ShiprocketAuthResponse = {
  token: string
}

export class ShiprocketTokenManager {
  private static instance: ShiprocketTokenManager
  private token: string | null = null
  private tokenExpiresAt: number | null = null
  private axios: AxiosInstance

  private constructor() {
    const baseURL = process.env.SHIPROCKET_BASE_URL || "https://apiv2.shiprocket.in"

    this.axios = axios.create({
      baseURL,
      timeout: 10000,
    })
  }

  static getInstance(): ShiprocketTokenManager {
    if (!ShiprocketTokenManager.instance) {
      ShiprocketTokenManager.instance = new ShiprocketTokenManager()
    }
    return ShiprocketTokenManager.instance
  }

  /**
   * Return a valid token, logging in if needed.
   * Shiprocket tokens are valid for ~240 hours, so we conservatively
   * set an in-memory TTL of 200 hours from issuance.
   */
  async getToken(): Promise<string> {
    const now = Date.now()

    if (this.token && this.tokenExpiresAt && now < this.tokenExpiresAt) {
      return this.token
    }

    const email = process.env.SHIPROCKET_EMAIL
    const password = process.env.SHIPROCKET_PASSWORD

    if (!email || !password) {
      throw new Error("Shiprocket credentials (SHIPROCKET_EMAIL / SHIPROCKET_PASSWORD) are not configured")
    }

     console.log("SHIPROCKET_EMAIL raw:", JSON.stringify(email))
  console.log("SHIPROCKET_PASSWORD length:", password?.length, JSON.stringify(password))

    const { data } = await this.axios.post<ShiprocketAuthResponse>(
      "/v1/external/auth/login",
      {
        email,
        password,
      }
    )

    if (!data?.token) {
      throw new Error("Shiprocket login did not return a token")
    }

    this.token = data.token
    // 200 hours from now, in ms
    this.tokenExpiresAt = now + 200 * 60 * 60 * 1000

    return this.token
  }

  /**
   * Get an axios instance with Authorization header set.
   * Callers should catch 401s and optionally force a token refresh.
   */
  async getAuthenticatedClient(): Promise<AxiosInstance> {
    const token = await this.getToken()

    const client = this.axios

    client.defaults.headers.common["Authorization"] = `Bearer ${token}`
    client.defaults.headers.common["Content-Type"] = "application/json"

    return client
  }
}
