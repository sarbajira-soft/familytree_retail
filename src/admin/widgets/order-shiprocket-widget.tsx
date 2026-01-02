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
  const [pickupLoading, setPickupLoading] = useState(false)
  const [statusLoading, setStatusLoading] = useState(false)
  const [trackingLoading, setTrackingLoading] = useState(false)
  const [attachTrackingLoading, setAttachTrackingLoading] = useState(false)
  const [trackingTimeline, setTrackingTimeline] = useState<any[] | null>(null)

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
    if (hasAwb) {
      return
    }
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

  const normalizedStatus = (meta.shiprocket_status_normalized || "") as string

  const isPickedUpOrBeyond =
    normalizedStatus === "picked_up" ||
    normalizedStatus === "in_transit" ||
    normalizedStatus === "delivered" ||
    normalizedStatus === "rto_initiated"

  const awbStatus = hasAwb
    ? isPickedUpOrBeyond
      ? "Shipped"
      : "AWB assigned"
    : hasShipment
    ? hasError
      ? "AWB failed"
      : "AWB not assigned yet"
    : "No Shiprocket shipment yet"

  const canRetryOrder = !hasShipment || hasError
  const canRetryAwb = !!meta.shiprocket_shipment_id && (!hasAwb || hasError)

  const canSchedulePickup = !!meta.shiprocket_awb_code && !meta.shiprocket_pickup_scheduled
  const canRefreshStatus = !!meta.shiprocket_awb_code

  const hasLabel = !!meta.shiprocket_label_url
  const hasInvoice = !!meta.shiprocket_invoice_url
  const trackingUrl: string | undefined =
    (typeof meta.shiprocket_tracking_url === "string" && meta.shiprocket_tracking_url) ||
    (meta.shiprocket_awb_code
      ? `https://track.shiprocket.in/${meta.shiprocket_awb_code}`
      : undefined)

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

  const handleSchedulePickup = async () => {
    if (!meta.shiprocket_shipment_id || !meta.shiprocket_awb_code) {
      return
    }

    setPickupLoading(true)
    try {
      const res = await fetch(`/admin/orders/${order.id}/shiprocket/pickup`, {
        method: "POST",
      })

      if (!res.ok) {
        console.error("Shiprocket pickup scheduling failed", await res.text())
      } else {
        const data = (await res.json().catch(() => null)) as
          | { metadata?: Record<string, any> }
          | null

        if (data?.metadata) {
          setMeta((prev) => ({ ...prev, ...data.metadata }))
        }
      }
    } catch (e) {
      console.error("Shiprocket pickup scheduling error", e)
    } finally {
      setPickupLoading(false)
    }
  }

  const handleRefreshStatus = async () => {
    if (!meta.shiprocket_awb_code) {
      return
    }

    setStatusLoading(true)
    try {
      const res = await fetch(`/admin/orders/${order.id}/shiprocket/status`, {
        method: "POST",
      })

      if (!res.ok) {
        console.error("Shiprocket status refresh failed", await res.text())
      } else {
        const data = (await res.json().catch(() => null)) as
          | { metadata?: Record<string, any> }
          | null

        if (data?.metadata) {
          setMeta((prev) => ({ ...prev, ...data.metadata }))
        }
      }
    } catch (e) {
      console.error("Shiprocket status refresh error", e)
    } finally {
      setStatusLoading(false)
    }
  }

  const handleLoadTracking = async () => {
    setTrackingLoading(true)

    try {
      const res = await fetch(`/admin/orders/${order.id}/shiprocket/tracking`)

      if (!res.ok) {
        console.error("Shiprocket tracking fetch failed", await res.text())
      } else {
        const data = (await res.json().catch(() => null)) as any
        const tracking = data?.shiprocket_tracking
        const td: any = tracking?.tracking_data || {}

        let events: any[] = []

        if (Array.isArray(td.scans)) {
          events = td.scans
        } else if (Array.isArray(td.shipment_track_activities)) {
          events = td.shipment_track_activities
        } else if (Array.isArray(td.shipment_track)) {
          const flattened = (td.shipment_track as any[]).flatMap((s) =>
            Array.isArray((s as any).shipment_track_activities)
              ? (s as any).shipment_track_activities
              : []
          )
          events = flattened.length ? flattened : td.shipment_track
        }

        setTrackingTimeline(events)
      }
    } catch (e) {
      console.error("Shiprocket tracking fetch error", e)
    } finally {
      setTrackingLoading(false)
    }
  }

  const handleAttachTracking = async () => {
    if (!meta.shiprocket_awb_code) {
      return
    }

    setAttachTrackingLoading(true)

    try {
      const res = await fetch(
        `/admin/orders/${order.id}/shiprocket/attach-tracking`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
        }
      )

      if (!res.ok) {
        console.error("Shiprocket attach tracking failed", await res.text())
      } else {
        const data = (await res.json().catch(() => null)) as
          | { metadata?: Record<string, any> }
          | null

        if (data?.metadata) {
          setMeta((prev) => ({ ...prev, ...data.metadata }))
        }
      }
    } catch (e) {
      console.error("Shiprocket attach tracking error", e)
    } finally {
      setAttachTrackingLoading(false)
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
          {trackingUrl && (
            <Text className="text-ui-fg-subtle">
              Tracking: <a href={trackingUrl} target="_blank" rel="noreferrer">View shipment</a>
            </Text>
          )}
          {meta.shiprocket_status_normalized && (
            <Text className="text-ui-fg-subtle">
              Status: {normalizedStatus.replace(/_/g, " ")}
              {meta.shiprocket_last_status
                ? ` (${String(meta.shiprocket_last_status)})`
                : ""}
            </Text>
          )}
          {(() => {
            let pickupLabel: string | null = null

            if (
              normalizedStatus === "pickup_scheduled" ||
              normalizedStatus === "pickup scheduled"
            ) {
              pickupLabel = "Scheduled"
            } else if (normalizedStatus === "picked_up" || normalizedStatus === "picked up") {
              pickupLabel = "Picked up"
            } else if (
              normalizedStatus === "in_transit" ||
              normalizedStatus === "delivered" ||
              normalizedStatus === "rto_initiated"
            ) {
              pickupLabel = "Completed"
            }

            return pickupLabel ? (
              <Text className="text-ui-fg-subtle">Pickup: {pickupLabel}</Text>
            ) : null
          })()}
          {!meta.shiprocket_pickup_scheduled && meta.shiprocket_pickup_error_code && (
            <Text className="text-ui-fg-subtle">
              Pickup error: {meta.shiprocket_pickup_error_code}
              {meta.shiprocket_pickup_error_message
                ? ` - ${meta.shiprocket_pickup_error_message}`
                : ""}
            </Text>
          )}
          {Array.isArray(trackingTimeline) && trackingTimeline.length > 0 && (
            <div className="mt-2 space-y-1">
              <Text weight="plus">Tracking timeline</Text>
              <ul className="list-disc ml-4 space-y-1">
                {trackingTimeline.map((scan, idx) => {
                  const s: any = scan as any
                  const label =
                    s["sr-status-label"] ||
                    s["sr_status_label"] ||
                    s.activity ||
                    s.status ||
                    ""
                  const date =
                    s.date ||
                    s["sr-status-date"] ||
                    s["sr_status_date"] ||
                    ""
                  const time =
                    s.time ||
                    s["sr-status-time"] ||
                    s["sr_status_time"] ||
                    ""
                  const location =
                    s.location ||
                    s["sr-status-location"] ||
                    s["sr_status_location"]
                  const when =
                    date && time ? `${date} ${time}` : date || time || ""

                  return (
                    <li key={idx}>
                      <Text className="text-ui-fg-subtle">
                        {when
                          ? `${when} - ${label || "Update"}`
                          : label || "Update"}
                        {location ? ` (${location})` : ""}
                      </Text>
                    </li>
                  )
                })}
              </ul>
            </div>
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
          {canSchedulePickup && (
            <Button
              size="small"
              variant="secondary"
              disabled={pickupLoading}
              onClick={handleSchedulePickup}
            >
              {pickupLoading ? "Scheduling Pickup..." : "Schedule Pickup"}
            </Button>
          )}
          {canRefreshStatus && (
            <Button
              size="small"
              variant="secondary"
              disabled={statusLoading}
              onClick={handleRefreshStatus}
            >
              {statusLoading ? "Refreshing Status..." : "Refresh Status"}
            </Button>
          )}
          {meta.shiprocket_awb_code && (
            <Button
              size="small"
              variant="secondary"
              disabled={attachTrackingLoading}
              onClick={handleAttachTracking}
            >
              {attachTrackingLoading
                ? "Attaching Tracking..."
                : "Attach Tracking to Fulfillment"}
            </Button>
          )}
          {meta.shiprocket_awb_code && (
            <Button
              size="small"
              variant="secondary"
              disabled={trackingLoading}
              onClick={handleLoadTracking}
            >
              {trackingLoading ? "Loading Tracking..." : "Load Tracking Timeline"}
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
                disabled={hasAwb}
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
                disabled={hasAwb}
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
                disabled={hasAwb}
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
                disabled={hasAwb}
                className="border rounded px-2 py-1"
              />
            </label>
          </div>
          <Button
            type="submit"
            size="small"
            variant="primary"
            disabled={weightDimsSaving || hasAwb}
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
