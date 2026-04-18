import { MedusaContainer } from "@medusajs/framework/types"

export async function refetchCart(
  cartId: string,
  scope: MedusaContainer,
  fields?: string[]
) {
  const query = scope.resolve("query")
  
  const { data: carts } = await query.graph({
    entity: "cart",
    fields: fields?.length ? fields : ["*"],
    filters: {
      id: cartId,
    },
  })

  return carts[0]
}
