import { useState } from "react"
import type { FormEvent } from "react"
import { defineWidgetConfig } from "@medusajs/admin-sdk"
import type { AdminOrder, DetailWidgetProps } from "@medusajs/framework/types"
import { Button, Container, Heading, Text } from "@medusajs/ui"

const OrderShiprocketWidget = ({ data: order }: DetailWidgetProps<AdminOrder>) => {
  const [meta, setMeta] = useState<Record<string, any>>(
    (order.metadata || {}) as Record<string, any>
  )

  const hasShipment = !!(meta.shiprocket_shipment_id || meta.shiprocket_order_id)
  const hasAwb = !!meta.shiprocket_awb_code
  const hasError = !!meta.shiprocket_error_code

  const [retryOrderLoading, setRetryOrderLoading] = useState(false)
  const [retryAwbLoading, setRetryAwbLoading] = useState(false)
  const [weightKg, setWeightKg] = useState<string>(
    meta.shiprocket_weight_kg !== undefined && meta.shiprocket_weight_kg !== null
      ? String(meta.shiprocket_weight_kg)
      : ""
  )
  const [lengthCm, setLengthCm] = useState<string>(
    meta.shiprocket_length_cm !== undefined && meta.shiprocket_length_cm !== null
      ? String(meta.shiprocket_length_cm)
      : ""
  )
  const [breadthCm, setBreadthCm] = useState<string>(
    meta.shiprocket_breadth_cm !== undefined && meta.shiprocket_breadth_cm !== null
      ? String(meta.shiprocket_breadth_cm)
      : ""
  )
  const [heightCm, setHeightCm] = useState<string>(
    meta.shiprocket_height_cm !== undefined && meta.shiprocket_height_cm !== null
      ? String(meta.shiprocket_height_cm)
      : ""
  )
  const [weightDimsSaving, setWeightDimsSaving] = useState(false)
  const [labelLoading, setLabelLoading] = useState(false)
  const [invoiceLoading, setInvoiceLoading] = useState(false)

  const handleRetryOrder = async () => {
    setRetryOrderLoading(true)
    try {
      const res = await fetch(`/admin/orders/${order.id}/shiprocket/retry`, {
        method: "POST",
      })
      if (!res.ok) {
        console.error("Shiprocket order retry failed", await res.text())
      } else {
        const data = (await res.json().catch(() => null)) as
          | { metadata?: Record<string, any> }
          | null
        if (data?.metadata) {
          setMeta((prev) => ({ ...prev, ...data.metadata }))
        }
      }
      // No full page reload; rely on admin's data refresh or manual reload
    } catch (e) {
      console.error("Shiprocket order retry error", e)
    } finally {
      setRetryOrderLoading(false)
    }
  }

  const handleRetryAwb = async () => {
    setRetryAwbLoading(true)
    try {
      const res = await fetch(`/admin/orders/${order.id}/shiprocket/awb/retry`, {
        method: "POST",
      })
      if (!res.ok) {
        console.error("Shiprocket AWB retry failed", await res.text())
      } else {
        const data = (await res.json().catch(() => null)) as
          | { metadata?: Record<string, any> }
          | null
        if (data?.metadata) {
          setMeta((prev) => ({ ...prev, ...data.metadata }))
        }
      }
      // No full page reload; rely on admin's data refresh or manual reload
    } catch (e) {
      console.error("Shiprocket AWB retry error", e)
    } finally {
      setRetryAwbLoading(false)
    }
  }

  const handleSaveWeightDims = async (e: FormEvent) => {
    e.preventDefault()
    setWeightDimsSaving(true)
    try {
      const body: Record<string, any> = {}

      if (weightKg !== "") {
        body.weight_kg = Number(weightKg)
      }
      if (lengthCm !== "") {
        body.length_cm = Number(lengthCm)
      }
      if (breadthCm !== "") {
        body.breadth_cm = Number(breadthCm)
      }
      if (heightCm !== "") {
        body.height_cm = Number(heightCm)
      }

      const res = await fetch(
        `/admin/orders/${order.id}/shiprocket/weight-dimensions`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify(body),
        }
      )

      if (!res.ok) {
        console.error("Shiprocket weight/dimensions update failed", await res.text())
      } else {
        const data = (await res.json().catch(() => null)) as
          | { metadata?: Record<string, any> }
          | null
        if (data?.metadata) {
          setMeta((prev) => ({ ...prev, ...data.metadata }))
        }
      }
      // No full page reload; rely on admin's data refresh or manual reload
    } catch (err) {
      console.error("Shiprocket weight/dimensions update error", err)
    } finally {
      setWeightDimsSaving(false)
    }
  }

  const orderStatus = hasShipment
    ? hasError
      ? "Created in Shiprocket, but has an error"
      : "Created in Shiprocket"
    : hasError
    ? "Creation failed"
    : "Not created in Shiprocket yet"

  const awbStatus = hasAwb
    ? "AWB assigned"
    : hasShipment
    ? hasError
      ? "AWB failed"
      : "AWB not assigned yet"
    : "No Shiprocket shipment yet"

  const canRetryOrder = !hasShipment || hasError
  const canRetryAwb = !!meta.shiprocket_shipment_id && (!hasAwb || hasError)

  const hasLabel = !!meta.shiprocket_label_url
  const hasInvoice = !!meta.shiprocket_invoice_url

  const handleGenerateLabel = async () => {
    if (!meta.shiprocket_shipment_id) {
      return
    }

    setLabelLoading(true)
    try {
      const res = await fetch(`/admin/orders/${order.id}/shiprocket/label`, {
        method: "POST",
      })

      if (!res.ok) {
        console.error("Shiprocket label generation failed", await res.text())
      } else {
        const data = (await res.json().catch(() => null)) as
          | { label_url?: string; metadata?: Record<string, any> }
          | null

        if (data?.metadata) {
          setMeta((prev) => ({ ...prev, ...data.metadata }))
        }

        if (data?.label_url) {
          window.open(data.label_url, "_blank")
        }
      }
    } catch (e) {
      console.error("Shiprocket label generation error", e)
    } finally {
      setLabelLoading(false)
    }
  }

  const handleGenerateInvoice = async () => {
    if (!meta.shiprocket_order_id) {
      return
    }

    setInvoiceLoading(true)
    try {
      const res = await fetch(`/admin/orders/${order.id}/shiprocket/invoice`, {
        method: "POST",
      })

      if (!res.ok) {
        console.error("Shiprocket invoice generation failed", await res.text())
      } else {
        const data = (await res.json().catch(() => null)) as
          | { invoice_url?: string; metadata?: Record<string, any> }
          | null

        if (data?.metadata) {
          setMeta((prev) => ({ ...prev, ...data.metadata }))
        }

        if (data?.invoice_url) {
          window.open(data.invoice_url, "_blank")
        }
      }
    } catch (e) {
      console.error("Shiprocket invoice generation error", e)
    } finally {
      setInvoiceLoading(false)
    }
  }

  return (
    <Container className="divide-y p-0">
      <div className="flex items-center justify-between px-6 py-4">
        <Heading level="h2">Shiprocket</Heading>
      </div>
      <div className="space-y-3 px-6 py-4 text-sm">
        <div>
          <Text weight="plus">Order creation</Text>
          <Text className="text-ui-fg-subtle">{orderStatus}</Text>
          {meta.shiprocket_shipment_id && (
            <Text className="text-ui-fg-subtle">
              Shipment ID: {String(meta.shiprocket_shipment_id)}
            </Text>
          )}
          {meta.shiprocket_order_id && (
            <Text className="text-ui-fg-subtle">
              Shiprocket Order ID: {String(meta.shiprocket_order_id)}
            </Text>
          )}
        </div>
        <div>
          <Text weight="plus">AWB</Text>
          <Text className="text-ui-fg-subtle">{awbStatus}</Text>
          {meta.shiprocket_awb_code && (
            <Text className="text-ui-fg-subtle">
              AWB: {meta.shiprocket_awb_code}
            </Text>
          )}
          {meta.shiprocket_courier_name && (
            <Text className="text-ui-fg-subtle">
              Courier: {meta.shiprocket_courier_name}
            </Text>
          )}
          {hasLabel && (
            <Text className="text-ui-fg-subtle">
              Label: <a href={meta.shiprocket_label_url} target="_blank" rel="noreferrer">Download</a>
            </Text>
          )}
          {hasInvoice && (
            <Text className="text-ui-fg-subtle">
              Invoice: <a href={meta.shiprocket_invoice_url} target="_blank" rel="noreferrer">Download</a>
            </Text>
          )}
        </div>
        {hasError && (
          <div>
            <Text weight="plus">Last error</Text>
            <Text className="text-ui-fg-subtle">
              {meta.shiprocket_error_code}: {meta.shiprocket_error_message}
            </Text>
          </div>
        )}
        <div className="flex gap-2 flex-wrap pt-2">
          {canRetryOrder && (
            <Button
              size="small"
              variant="secondary"
              disabled={retryOrderLoading}
              onClick={handleRetryOrder}
            >
              {retryOrderLoading ? "Retrying Order..." : "Retry Shiprocket Order"}
            </Button>
          )}
          {canRetryAwb && (
            <Button
              size="small"
              variant="secondary"
              disabled={retryAwbLoading}
              onClick={handleRetryAwb}
            >
              {retryAwbLoading ? "Retrying AWB..." : "Retry AWB"}
            </Button>
          )}
          {meta.shiprocket_awb_code && (
            <Button
              size="small"
              variant="secondary"
              disabled={labelLoading}
              onClick={handleGenerateLabel}
            >
              {labelLoading ? "Generating Label..." : "Download Label"}
            </Button>
          )}
          {meta.shiprocket_order_id && (
            <Button
              size="small"
              variant="secondary"
              disabled={invoiceLoading}
              onClick={handleGenerateInvoice}
            >
              {invoiceLoading ? "Generating Invoice..." : "Download Invoice"}
            </Button>
          )}
        </div>
        <form className="space-y-2 pt-4" onSubmit={handleSaveWeightDims}>
          <Text weight="plus">Weight &amp; Dimensions (overrides)</Text>
          <div className="grid grid-cols-2 gap-2">
            <label className="flex flex-col text-xs">
              <span>Weight (kg)</span>
              <input
                type="number"
                step="0.01"
                value={weightKg}
                onChange={(e) => setWeightKg(e.target.value)}
                className="border rounded px-2 py-1"
              />
            </label>
            <label className="flex flex-col text-xs">
              <span>Length (cm)</span>
              <input
                type="number"
                step="0.1"
                value={lengthCm}
                onChange={(e) => setLengthCm(e.target.value)}
                className="border rounded px-2 py-1"
              />
            </label>
            <label className="flex flex-col text-xs">
              <span>Breadth (cm)</span>
              <input
                type="number"
                step="0.1"
                value={breadthCm}
                onChange={(e) => setBreadthCm(e.target.value)}
                className="border rounded px-2 py-1"
              />
            </label>
            <label className="flex flex-col text-xs">
              <span>Height (cm)</span>
              <input
                type="number"
                step="0.1"
                value={heightCm}
                onChange={(e) => setHeightCm(e.target.value)}
                className="border rounded px-2 py-1"
              />
            </label>
          </div>
          <Button
            type="submit"
            size="small"
            variant="primary"
            disabled={weightDimsSaving}
          >
            {weightDimsSaving ? "Saving..." : "Save Weight & Dimensions"}
          </Button>
        </form>
      </div>
    </Container>
  )
}

export const config = defineWidgetConfig({
  zone: "order.details.after",
})

export default OrderShiprocketWidget
