const PAYPAL_BASE =
  Deno.env.get("PAYPAL_ENV") === "live" // If someone git clones and made it live.
    ? "https://api-m.paypal.com"
    : "https://api-m.sandbox.paypal.com"

export class PayPalError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly issues: string[]
  ) {
    super(message)
  }
}

export function dollars(cents: number) {
  return (cents / 100).toFixed(2)
}

async function accessToken() {
  const id = Deno.env.get("PAYPAL_CLIENT_ID")
  const secret = Deno.env.get("PAYPAL_CLIENT_SECRET")
  if (!id || !secret) throw new Error("PayPal is not configured.")
  const response = await fetch(`${PAYPAL_BASE}/v1/oauth2/token`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${btoa(`${id}:${secret}`)}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: "grant_type=client_credentials",
  })
  if (!response.ok) throw new Error("Unable to sign in to PayPal.")
  return (await response.json()).access_token as string
}

export async function paypal(
  path: string,
  body: unknown,
  requestId: string
): Promise<Record<string, any>> {
  const response = await fetch(`${PAYPAL_BASE}${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${await accessToken()}`,
      "Content-Type": "application/json",
      "PayPal-Request-Id": requestId,
      Prefer: "return=representation",
    },
    body: JSON.stringify(body ?? {}),
  })
  const text = await response.text()
  const data = text ? JSON.parse(text) : {}
  if (!response.ok) {
    const issues = [
      data.name,
      ...(Array.isArray(data.details)
        ? data.details.map((detail: { issue?: string }) => detail.issue)
        : []),
    ].filter((issue): issue is string => typeof issue === "string")
    throw new PayPalError(
      data.message ?? "PayPal request failed.",
      response.status,
      issues
    )
  }
  return data
}

export function createAuthorizeOrder(
  amountCents: number,
  customId: string,
  requestId: string
) {
  return paypal(
    "/v2/checkout/orders",
    {
      intent: "AUTHORIZE",
      purchase_units: [
        {
          custom_id: customId,
          description: "Burn The Boat stake",
          amount: { currency_code: "USD", value: dollars(amountCents) },
        },
      ],
    },
    requestId
  )
}

export const authorizeOrder = (orderId: string) =>
  paypal(`/v2/checkout/orders/${orderId}/authorize`, {}, `authorize-${orderId}`)

// Returns the capture ID, or null when the authorization was already captured earlier.
export async function captureAuthorization(
  id: string,
  stakeId: string
): Promise<string | null> {
  try {
    const data = await paypal(
      `/v2/payments/authorizations/${id}/capture`,
      { final_capture: true },
      `capture-${stakeId}`
    )
    return typeof data.id === "string" ? data.id : null
  } catch (error) {
    if (
      !(error instanceof PayPalError) ||
      !error.issues.includes("AUTHORIZATION_ALREADY_CAPTURED")
    ) {
      throw error
    }
    return null
  }
}

export async function refundCapture(captureId: string, stakeId: string) {
  try {
    await paypal(
      `/v2/payments/captures/${captureId}/refund`,
      {},
      `refund-${stakeId}`
    )
  } catch (error) {
    if (
      !(error instanceof PayPalError) ||
      !error.issues.includes("CAPTURE_FULLY_REFUNDED")
    ) {
      throw error
    }
  }
}

// PayPal allows one reauthorization, between day 4 and day 29 of an authorization.
export async function reauthorize(
  id: string,
  amountCents: number,
  stakeId: string
) {
  const data = await paypal(
    `/v2/payments/authorizations/${id}/reauthorize`,
    { amount: { currency_code: "USD", value: dollars(amountCents) } },
    `reauthorize-${stakeId}`
  )
  return typeof data.id === "string" ? data.id : id
}

export async function voidAuthorization(id: string, stakeId: string) {
  try {
    await paypal(
      `/v2/payments/authorizations/${id}/void`,
      {},
      `void-${stakeId}`
    )
  } catch (error) {
    if (
      !(error instanceof PayPalError) ||
      !error.issues.some((issue) =>
        ["AUTHORIZATION_VOIDED", "PREVIOUSLY_VOIDED"].includes(issue)
      )
    ) {
      throw error
    }
  }
}

// The sender batch ID makes payouts idempotent: PayPal rejects a repeated batch.
export async function sendPayout(
  email: string,
  amountCents: number,
  stakeId: string
) {
  try {
    const data = await paypal(
      "/v1/payments/payouts",
      {
        sender_batch_header: {
          sender_batch_id: `stake-${stakeId}`,
          email_subject: "You won a Burn The Boat stake",
        },
        items: [
          {
            recipient_type: "EMAIL",
            receiver: email,
            sender_item_id: stakeId,
            note: "Burn The Boat stake winnings",
            amount: { currency: "USD", value: dollars(amountCents) },
          },
        ],
      },
      `payout-${stakeId}`
    )
    return (data.batch_header?.payout_batch_id as string) ?? `stake-${stakeId}`
  } catch (error) {
    if (
      error instanceof PayPalError &&
      error.issues.includes("BATCH_ID_ALREADY_EXISTS")
    ) {
      return `stake-${stakeId}`
    }
    throw error
  }
}
