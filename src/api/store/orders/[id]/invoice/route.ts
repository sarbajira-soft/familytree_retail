import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"

import {
  getOwnedOrder,
  listOrderRefundRecords,
  listOrderReturns,
} from "../../retail-helpers"

function escapeHtml(value: unknown) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;")
}

function formatMinorAmount(amount: unknown, currencyCode: unknown) {
  const numeric = Number(amount || 0)
  const safeAmount = Number.isFinite(numeric) ? numeric : 0
  const currency = String(currencyCode || "INR").toUpperCase()

  try {
    return new Intl.NumberFormat("en-IN", {
      style: "currency",
      currency,
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(safeAmount / 100)
  } catch {
    return `${currency} ${(safeAmount / 100).toFixed(2)}`
  }
}

function asIsoDate(value: unknown) {
  if (!value) {
    return null
  }

  const date = new Date(String(value))
  return Number.isNaN(date.getTime()) ? null : date.toISOString()
}

function formatReadableDate(value: unknown) {
  const iso = asIsoDate(value)
  if (!iso) {
    return ""
  }

  try {
    return new Intl.DateTimeFormat("en-IN", {
      dateStyle: "medium",
      timeStyle: "short",
    }).format(new Date(iso))
  } catch {
    return iso
  }
}

function joinAddressLines(address: any) {
  if (!address) {
    return ["Not available"]
  }

  const lines = [
    [address.first_name, address.last_name].filter(Boolean).join(" ").trim(),
    address.address_1,
    address.address_2,
    [address.city, address.province, address.postal_code].filter(Boolean).join(", "),
    address.country_code ? String(address.country_code).toUpperCase() : null,
    address.phone,
  ].filter(Boolean)

  return lines.length ? lines : ["Not available"]
}

export const GET = async (req: MedusaRequest, res: MedusaResponse) => {
  const orderId = (req.params?.id || "").toString()
  const order = await getOwnedOrder(req, orderId)
  const orderAny = order as any
  const metadata = (orderAny.metadata || {}) as Record<string, any>

  const [refundRecords, returns] = await Promise.all([
    listOrderRefundRecords(req, orderId),
    listOrderReturns(req, orderId),
  ])

  const currencyCode = orderAny.currency_code || "INR"
  const items = Array.isArray(orderAny.items) ? orderAny.items : []
  const shippingAddressLines = joinAddressLines(orderAny.shipping_address)
  const billingAddressLines = joinAddressLines(orderAny.billing_address)
  const refundRows = (Array.isArray(refundRecords) ? refundRecords : []).map((refund: any) => ({
    reference:
      refund.razorpay_refund_id || refund.medusa_refund_id || refund.payment_id || refund.id,
    status: refund.status || "pending",
    amount: refund.refund_amount_minor || 0,
    processed_at: refund.processed_at || refund.created_at || null,
  }))
  const returnRows = (Array.isArray(returns) ? returns : []).map((orderReturn: any) => ({
    reference: orderReturn.display_id || orderReturn.id,
    status: orderReturn.status || "open",
    refund_amount: orderReturn.refund_amount || 0,
    requested_at: orderReturn.requested_at || orderReturn.created_at || null,
  }))

  const itemsHtml = items
    .map((item: any) => {
      const lineTotalValue =
        item.total || (Number(item.unit_price || 0) * Number(item.quantity || 0))

      return `<tr>
        <td>${escapeHtml(item.title || "")}</td>
        <td class="muted">${escapeHtml(item.variant?.title || item.sku || "")}</td>
        <td class="center">${escapeHtml(item.quantity || 1)}</td>
        <td class="right">${escapeHtml(formatMinorAmount(lineTotalValue, currencyCode))}</td>
      </tr>`
    })
    .join("")

  const refundsHtml = refundRows.length
    ? `<h2>Refunds</h2>
      <table>
        <thead>
          <tr>
            <th>Reference</th>
            <th>Status</th>
            <th class="right">Amount</th>
            <th>Processed</th>
          </tr>
        </thead>
        <tbody>
          ${refundRows
            .map(
              (refund) => `<tr>
                <td>${escapeHtml(refund.reference)}</td>
                <td>${escapeHtml(refund.status)}</td>
                <td class="right">${escapeHtml(
                  formatMinorAmount(refund.amount, currencyCode)
                )}</td>
                <td>${escapeHtml(formatReadableDate(refund.processed_at))}</td>
              </tr>`
            )
            .join("")}
        </tbody>
      </table>`
    : ""

  const returnsHtml = returnRows.length
    ? `<h2>Returns</h2>
      <table>
        <thead>
          <tr>
            <th>Reference</th>
            <th>Status</th>
            <th class="right">Refund amount</th>
            <th>Requested</th>
          </tr>
        </thead>
        <tbody>
          ${returnRows
            .map(
              (orderReturn) => `<tr>
                <td>${escapeHtml(orderReturn.reference)}</td>
                <td>${escapeHtml(orderReturn.status)}</td>
                <td class="right">${escapeHtml(
                  formatMinorAmount(orderReturn.refund_amount, currencyCode)
                )}</td>
                <td>${escapeHtml(formatReadableDate(orderReturn.requested_at))}</td>
              </tr>`
            )
            .join("")}
        </tbody>
      </table>`
    : ""

  const html = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>Invoice_${escapeHtml(orderAny.display_id || orderAny.id || "")}</title>
    <style>
      body { font-family: Arial, sans-serif; color: #111827; margin: 0; padding: 24px; }
      .header { display: flex; justify-content: space-between; gap: 20px; align-items: flex-start; }
      .pill { display: inline-block; padding: 4px 10px; border-radius: 999px; background: #f3f4f6; font-size: 12px; font-weight: 600; }
      .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; margin-top: 20px; }
      .card { border: 1px solid #e5e7eb; border-radius: 12px; padding: 16px; }
      h1 { margin: 0 0 8px; font-size: 24px; }
      h2 { margin: 0 0 10px; font-size: 14px; }
      p { margin: 0 0 6px; font-size: 12px; }
      table { width: 100%; border-collapse: collapse; margin-top: 16px; }
      th, td { border: 1px solid #e5e7eb; padding: 8px 10px; font-size: 12px; text-align: left; vertical-align: top; }
      th { background: #f9fafb; }
      .right { text-align: right; }
      .center { text-align: center; }
      .muted { color: #6b7280; }
      .summary { margin-top: 18px; }
      .summary-row { display: flex; justify-content: space-between; margin-bottom: 6px; font-size: 12px; }
      .summary-row.total { font-weight: 700; font-size: 14px; margin-top: 10px; }
      .links a { color: #2563eb; text-decoration: none; }
      @media print {
        body { padding: 0; }
        .print-note { display: none; }
      }
    </style>
  </head>
  <body>
    <div class="header">
      <div>
        <h1>Order Invoice</h1>
        <p>Order ${escapeHtml(orderAny.display_id || orderAny.id || "")}</p>
        <p>Placed ${escapeHtml(formatReadableDate(orderAny.created_at))}</p>
      </div>
      <div style="text-align:right;">
        <div class="pill">${escapeHtml(String(orderAny.payment_status || "pending"))}</div>
        <p style="margin-top:10px;">Fulfillment: ${escapeHtml(
          String(orderAny.fulfillment_status || "not_fulfilled")
        )}</p>
        <p>Email: ${escapeHtml(orderAny.email || "")}</p>
      </div>
    </div>

    <div class="grid">
      <div class="card">
        <h2>Shipping address</h2>
        ${shippingAddressLines.map((line) => `<p>${escapeHtml(line)}</p>`).join("")}
      </div>
      <div class="card">
        <h2>Billing address</h2>
        ${billingAddressLines.map((line) => `<p>${escapeHtml(line)}</p>`).join("")}
      </div>
    </div>

    <table>
      <thead>
        <tr>
          <th>Product</th>
          <th>Variant</th>
          <th class="center">Qty</th>
          <th class="right">Total</th>
        </tr>
      </thead>
      <tbody>${itemsHtml}</tbody>
    </table>

    <div class="summary">
      <div class="summary-row"><span>Subtotal</span><span>${escapeHtml(
        formatMinorAmount(orderAny.subtotal || 0, currencyCode)
      )}</span></div>
      <div class="summary-row"><span>Tax</span><span>${escapeHtml(
        formatMinorAmount(orderAny.tax_total || 0, currencyCode)
      )}</span></div>
      <div class="summary-row"><span>Shipping</span><span>${escapeHtml(
        formatMinorAmount(orderAny.shipping_total || 0, currencyCode)
      )}</span></div>
      <div class="summary-row total"><span>Grand total</span><span>${escapeHtml(
        formatMinorAmount(orderAny.total || 0, currencyCode)
      )}</span></div>
    </div>

    ${refundsHtml}
    ${returnsHtml}

    <div class="grid" style="margin-top: 18px;">
      <div class="card">
        <h2>Payment references</h2>
        <p>Provider: ${escapeHtml(metadata.payment_provider_id || "Not available")}</p>
        <p>Razorpay order: ${escapeHtml(metadata.razorpay_order_id || "Not available")}</p>
        <p>Razorpay payment: ${escapeHtml(
          metadata.razorpay_payment_id || "Not available"
        )}</p>
      </div>
      <div class="card">
        <h2>Shipping references</h2>
        <p>AWB: ${escapeHtml(metadata.shiprocket_awb_code || "Pending")}</p>
        <p>Courier: ${escapeHtml(metadata.shiprocket_courier_name || "Pending")}</p>
        <div class="links">
          ${
            metadata.shiprocket_tracking_url
              ? `<p><a href="${escapeHtml(
                  metadata.shiprocket_tracking_url
                )}" target="_blank" rel="noreferrer">Open tracking link</a></p>`
              : ""
          }
          ${
            metadata.shiprocket_invoice_url
              ? `<p><a href="${escapeHtml(
                  metadata.shiprocket_invoice_url
                )}" target="_blank" rel="noreferrer">Open Shiprocket invoice</a></p>`
              : ""
          }
          ${
            metadata.shiprocket_label_url
              ? `<p><a href="${escapeHtml(
                  metadata.shiprocket_label_url
                )}" target="_blank" rel="noreferrer">Open shipping label</a></p>`
              : ""
          }
        </div>
      </div>
    </div>

    <p class="print-note" style="margin-top: 20px; color: #6b7280; font-size: 11px;">
      Use your browser print dialog to save this invoice as PDF.
    </p>
    <script>window.onload = function () { window.print(); };</script>
  </body>
</html>`

  res.setHeader("content-type", "text/html; charset=utf-8")
  return res.status(200).send(html)
}
