import type { SubscriberArgs, SubscriberConfig } from "@medusajs/framework"
import type { Logger, CartDTO } from "@medusajs/framework/types"
import { Modules } from "@medusajs/framework/utils"

export default async function shiprocketCartUpdated({
  event: { data },
  container,
}: SubscriberArgs<{ id: string }>) {
  const logger: Logger = container.resolve("logger")
  const cartModuleService = container.resolve(Modules.CART)
  const productModuleService = container.resolve(Modules.PRODUCT)

  const cartId = (data as any).id as string | undefined

  if (!cartId) {
    logger.warn?.("Shiprocket cart subscriber: cart.updated event missing id")
    return
  }

  let cart: CartDTO
  try {
    cart = await cartModuleService.retrieveCart(cartId, {
      relations: ["items"],
    })
  } catch (e: any) {
    logger.warn?.(
      `Shiprocket cart subscriber: failed to retrieve cart ${cartId} (${e?.message || "unknown error"})`
    )
    return
  }

  const items = ((cart as any).items || []) as any[]

  if (!Array.isArray(items) || items.length === 0) {
    return
  }

  const variantIds = Array.from(
    new Set(
      items
        .map((item) => (item as any).variant_id || (item as any).variant?.id)
        .filter((id) => typeof id === "string" && id)
    )
  ) as string[]

  if (!variantIds.length) {
    return
  }

  let variants: any[] = []
  try {
    variants = await productModuleService.listProductVariants(
      {
        id: variantIds,
      },
      {
        relations: ["product"],
        take: variantIds.length,
      }
    )
  } catch (e: any) {
    logger.warn?.(
      `Shiprocket cart subscriber: failed to load product variants for cart ${cartId} (${e?.message || "unknown error"})`
    )
    return
  }

  if (!Array.isArray(variants) || variants.length === 0) {
    return
  }

  const variantById = new Map<string, any>()
  for (const v of variants) {
    if (v && typeof v.id === "string" && v.id) {
      variantById.set(v.id, v)
    }
  }

  if (!variantById.size) {
    return
  }

  const defaultWeight = Number(process.env.SHIPROCKET_DEFAULT_WEIGHT_KG || 0.5)
  const defaultLength = Number(process.env.SHIPROCKET_DEFAULT_LENGTH || 10)
  const defaultBreadth = Number(process.env.SHIPROCKET_DEFAULT_BREADTH || 10)
  const defaultHeight = Number(process.env.SHIPROCKET_DEFAULT_HEIGHT || 10)

  const parsePositive = (value: any): number => {
    const num = typeof value === "number" ? value : Number(value)
    return Number.isFinite(num) && num > 0 ? num : 0
  }

  const updates: Array<{ selector: { id: string }; data: { metadata: Record<string, any> } }> = []

  for (const item of items) {
    const itemId = (item as any).id as string | undefined

    if (!itemId) {
      continue
    }

    const existingMeta = ((item as any).metadata || {}) as Record<string, any>

    const metaWeightNum = Number(existingMeta.weight_kg)
    const metaLengthNum = Number(existingMeta.length_cm)
    const metaBreadthNum = Number(existingMeta.breadth_cm)
    const metaHeightNum = Number(existingMeta.height_cm)

    const hasMetaWeight = Number.isFinite(metaWeightNum) && metaWeightNum > 0
    const hasMetaLength = Number.isFinite(metaLengthNum) && metaLengthNum > 0
    const hasMetaBreadth = Number.isFinite(metaBreadthNum) && metaBreadthNum > 0
    const hasMetaHeight = Number.isFinite(metaHeightNum) && metaHeightNum > 0

    const metaWeightIsDefault = hasMetaWeight && Math.abs(metaWeightNum - defaultWeight) < 1e-6
    const metaLengthIsDefault = hasMetaLength && Math.abs(metaLengthNum - defaultLength) < 1e-6
    const metaBreadthIsDefault = hasMetaBreadth && Math.abs(metaBreadthNum - defaultBreadth) < 1e-6
    const metaHeightIsDefault = hasMetaHeight && Math.abs(metaHeightNum - defaultHeight) < 1e-6

    const variantId = (item as any).variant_id || (item as any).variant?.id
    if (!variantId || typeof variantId !== "string") {
      continue
    }

    const variant = variantById.get(variantId)
    if (!variant) {
      continue
    }

    const product = (variant as any).product as any | undefined

    const variantWeightNum = parsePositive((variant as any).weight)
    const productWeightNum = parsePositive(product?.weight)

    const grams =
      (variantWeightNum && variantWeightNum > 0 ? variantWeightNum : 0) ||
      (productWeightNum && productWeightNum > 0 ? productWeightNum : 0)

    const realWeightKg = grams > 0 ? grams / 1000 : 0

    let weightKg: number | undefined = hasMetaWeight ? metaWeightNum : undefined

    // If metadata is missing OR it is just the default placeholder, prefer real product/variant weight.
    if ((!hasMetaWeight || metaWeightIsDefault) && realWeightKg > 0) {
      weightKg = realWeightKg
    } else if (!hasMetaWeight) {
      weightKg = defaultWeight
    }

    let lengthCm: number | undefined = hasMetaLength ? metaLengthNum : undefined
    let breadthCm: number | undefined = hasMetaBreadth ? metaBreadthNum : undefined
    let heightCm: number | undefined = hasMetaHeight ? metaHeightNum : undefined

    // If metadata is missing OR it is just default placeholders, prefer real product/variant dimensions.
    if (!hasMetaLength || !hasMetaBreadth || !hasMetaHeight || metaLengthIsDefault || metaBreadthIsDefault || metaHeightIsDefault) {
      let maxLength = 0
      let maxBreadth = 0
      let maxHeight = 0

      const lengthCandidates = [
        (variant as any).length,
        product?.length,
      ]
      const widthCandidates = [
        (variant as any).width,
        product?.width,
      ]
      const heightCandidates = [
        (variant as any).height,
        product?.height,
      ]

      for (const candidate of lengthCandidates) {
        const n = parsePositive(candidate)
        if (n > maxLength) {
          maxLength = n
        }
      }

      for (const candidate of widthCandidates) {
        const n = parsePositive(candidate)
        if (n > maxBreadth) {
          maxBreadth = n
        }
      }

      for (const candidate of heightCandidates) {
        const n = parsePositive(candidate)
        if (n > maxHeight) {
          maxHeight = n
        }
      }

      if ((!hasMetaLength || metaLengthIsDefault) && maxLength > 0) {
        lengthCm = maxLength
      } else if (!hasMetaLength) {
        lengthCm = defaultLength
      }

      if ((!hasMetaBreadth || metaBreadthIsDefault) && maxBreadth > 0) {
        breadthCm = maxBreadth
      } else if (!hasMetaBreadth) {
        breadthCm = defaultBreadth
      }

      if ((!hasMetaHeight || metaHeightIsDefault) && maxHeight > 0) {
        heightCm = maxHeight
      } else if (!hasMetaHeight) {
        heightCm = defaultHeight
      }
    }

    const newMetadata: Record<string, any> = {
      ...existingMeta,
    }

    if ((
      !hasMetaWeight ||
      (metaWeightIsDefault && realWeightKg > 0 && Math.abs((weightKg ?? 0) - metaWeightNum) > 1e-6)
    ) && weightKg && Number.isFinite(weightKg) && weightKg > 0) {
      newMetadata.weight_kg = weightKg
    }

    if ((!hasMetaLength || (metaLengthIsDefault && lengthCm !== metaLengthNum)) && lengthCm && Number.isFinite(lengthCm) && lengthCm > 0) {
      newMetadata.length_cm = lengthCm
    }

    if ((!hasMetaBreadth || (metaBreadthIsDefault && breadthCm !== metaBreadthNum)) && breadthCm && Number.isFinite(breadthCm) && breadthCm > 0) {
      newMetadata.breadth_cm = breadthCm
    }

    if ((!hasMetaHeight || (metaHeightIsDefault && heightCm !== metaHeightNum)) && heightCm && Number.isFinite(heightCm) && heightCm > 0) {
      newMetadata.height_cm = heightCm
    }

    const changed =
      newMetadata.weight_kg !== existingMeta.weight_kg ||
      newMetadata.length_cm !== existingMeta.length_cm ||
      newMetadata.breadth_cm !== existingMeta.breadth_cm ||
      newMetadata.height_cm !== existingMeta.height_cm

    if (!changed) {
      continue
    }

    updates.push({
      selector: {
        id: itemId,
      },
      data: {
        metadata: newMetadata,
      },
    })
  }

  if (!updates.length) {
    return
  }

  try {
    await cartModuleService.updateLineItems(updates as any)
  } catch (e: any) {
    logger.warn?.(
      `Shiprocket cart subscriber: failed to update line item metadata for cart ${cartId} (${e?.message || "unknown error"})`
    )
  }
}

export const config: SubscriberConfig = {
  event: "cart.updated",
}
