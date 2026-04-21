import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { listShippingOptionsForCartWithPricingWorkflow } from "@medusajs/core-flows"
import {
  ContainerRegistrationKeys,
  MedusaError,
} from "@medusajs/framework/utils"

function normalizeShippingProfileId(option: any) {
  const profileId =
    option?.shipping_profile_id ||
    option?.shippingProfileId ||
    option?.shipping_profile?.id ||
    option?.shippingProfile?.id ||
    option?.profile_id ||
    ""

  return profileId ? String(profileId) : ""
}

function resolveOptionAmount(option: any) {
  const amount =
    option?.amount ??
    option?.calculated_price?.calculated_amount ??
    option?.calculatedPrice?.calculatedAmount ??
    option?.price?.amount ??
    option?.price_amount ??
    0

  const numeric = Number(amount)
  return Number.isFinite(numeric) ? numeric : 0
}

export const GET = async (req: MedusaRequest, res: MedusaResponse) => {
  const cartId = (req.params?.id || "").toString().trim()

  if (!cartId) {
    throw new MedusaError(MedusaError.Types.INVALID_DATA, "Cart id is required")
  }

  const query = req.scope.resolve(ContainerRegistrationKeys.QUERY)
  const { data } = await query.graph({
    entity: "cart",
    fields: [
      "id",
      "shipping_address.id",
      "shipping_address.postal_code",
      "shipping_methods.id",
      "shipping_methods.shipping_option_id",
      "items.id",
      "items.requires_shipping",
      "items.variant.id",
      "items.variant.product.id",
      "items.variant.product.shipping_profile.id",
    ],
    filters: {
      id: [cartId],
    },
  })

  const cart = Array.isArray(data) ? data[0] || null : null

  if (!cart) {
    throw new MedusaError(MedusaError.Types.NOT_FOUND, `Cart ${cartId} not found`)
  }

  const items = Array.isArray(cart?.items) ? cart.items : []
  const requiredProfiles = Array.from(
    new Set(
      items
        .filter((item: any) => item?.requires_shipping !== false)
        .map((item: any) => item?.variant?.product?.shipping_profile?.id)
        .filter((profileId: unknown) => typeof profileId === "string" && profileId)
    )
  ) as string[]

  if (!requiredProfiles.length) {
    return res.status(200).json({
      cart_id: cartId,
      ready: true,
      message: null,
      required_profile_ids: [],
      missing_profile_ids: [],
      selected_option_ids: [],
      profiles: [],
    })
  }

  if (!cart?.shipping_address?.postal_code) {
    return res.status(200).json({
      cart_id: cartId,
      ready: false,
      message: "Shipping address is missing or incomplete",
      required_profile_ids: requiredProfiles,
      missing_profile_ids: requiredProfiles,
      selected_option_ids: [],
      profiles: requiredProfiles.map((profileId) => ({
        profile_id: profileId,
        selected_option_id: null,
        recommended_option_id: null,
        available_option_ids: [],
      })),
    })
  }

  const { result } = await listShippingOptionsForCartWithPricingWorkflow(req.scope).run(
    {
      input: {
        cart_id: cartId,
        is_return: false,
      },
    }
  )

  const availableOptions = Array.isArray(result) ? result : []
  const optionById = new Map(
    availableOptions.map((option: any) => [String(option.id), option])
  )

  const optionsByProfile = new Map<string, any[]>()
  for (const option of availableOptions) {
    const profileId = normalizeShippingProfileId(option)
    if (!profileId) {
      continue
    }

    if (!optionsByProfile.has(profileId)) {
      optionsByProfile.set(profileId, [])
    }

    optionsByProfile.get(profileId)?.push(option)
  }

  const selectedProfileOptions = new Map<string, string>()
  const currentShippingMethods = Array.isArray(cart?.shipping_methods)
    ? cart.shipping_methods
    : []

  for (const method of currentShippingMethods) {
    const optionId = String(method?.shipping_option_id || "")
    const option = optionById.get(optionId)
    const profileId = normalizeShippingProfileId(option)

    if (profileId && optionId) {
      selectedProfileOptions.set(profileId, optionId)
    }
  }

  const profiles = requiredProfiles.map((profileId) => {
    const profileOptions = [...(optionsByProfile.get(profileId) || [])].sort(
      (left, right) => resolveOptionAmount(left) - resolveOptionAmount(right)
    )

    return {
      profile_id: profileId,
      selected_option_id: selectedProfileOptions.get(profileId) || null,
      recommended_option_id: profileOptions[0]?.id ? String(profileOptions[0].id) : null,
      available_option_ids: profileOptions.map((option) => String(option.id)),
    }
  })

  const missingProfiles = profiles
    .filter(
      (profile) =>
        !profile.selected_option_id &&
        (!Array.isArray(profile.available_option_ids) ||
          profile.available_option_ids.length === 0)
    )
    .map((profile) => profile.profile_id)

  const selectedOptionIds = profiles
    .map((profile) => profile.selected_option_id)
    .filter((optionId): optionId is string => typeof optionId === "string" && !!optionId)

  const ready = missingProfiles.length === 0
  const message = ready
    ? null
    : availableOptions.length
      ? "Some items in your cart still need compatible shipping methods before checkout can continue."
      : "No shipping options are available for this cart."

  return res.status(200).json({
    cart_id: cartId,
    ready,
    message,
    required_profile_ids: requiredProfiles,
    missing_profile_ids: missingProfiles,
    selected_option_ids: selectedOptionIds,
    profiles,
  })
}
