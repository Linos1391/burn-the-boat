import { db, hasServiceConfig, patch } from "../_shared/db.ts"
import {
  authorizeOrder,
  createAuthorizeOrder,
  dollars,
  PayPalError,
  voidAuthorization,
} from "../_shared/paypal.ts"

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, "Content-Type": "application/json" },
  })

type BoatRow = {
  id: string
  cycle_id: string
  requester_uid: string
  partner_uid: string
  status: string
  deadline_at: string | null
  requester_bet_cents: number
  partner_bet_cents: number
}

type StakeRow = {
  id: string
  amount_cents: number
  paypal_order_id: string
  authorization_id: string | null
  status: string
}

async function currentUserId(authorization: string) {
  const response = await fetch(`${Deno.env.get("SUPABASE_URL")}/auth/v1/user`, {
    headers: {
      apikey: Deno.env.get("SERVICE_ROLE_KEY")!,
      Authorization: authorization,
    },
  })
  if (!response.ok) return null
  const user = (await response.json()) as { id?: unknown }
  return typeof user.id === "string" ? user.id : null
}

async function saveBoatPayoutEmail(
  boat: BoatRow,
  uid: string,
  email: string
) {
  await db("boat_payout_emails?on_conflict=request_id,cycle_id,user_uid", {
    method: "POST",
    prefer: "resolution=merge-duplicates,return=minimal",
    body: JSON.stringify({
      request_id: boat.id,
      cycle_id: boat.cycle_id,
      user_uid: uid,
      email,
      updated_at: new Date().toISOString(),
    }),
  })
}

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

// Returns the cleaned email, or null when the two entries are invalid or differ.
function confirmedEmail(rawEmail: unknown, rawConfirm: unknown) {
  const email = typeof rawEmail === "string" ? rawEmail.trim() : ""
  const confirm = typeof rawConfirm === "string" ? rawConfirm.trim() : ""
  if (!EMAIL_PATTERN.test(email) || email.length > 254) {
    return { error: "Enter a valid PayPal email address." }
  }
  if (email.toLowerCase() !== confirm.toLowerCase()) {
    return { error: "The two email addresses do not match." }
  }
  return { email }
}

async function loadDefaultEmail(uid: string) {
  const [saved] = await db<{ email: string }[]>(
    `user_payout_emails?user_uid=eq.${uid}&select=email`
  )
  return saved?.email ?? null
}

async function saveDefaultEmail(uid: string, email: string) {
  await db("user_payout_emails?on_conflict=user_uid", {
    method: "POST",
    prefer: "resolution=merge-duplicates,return=minimal",
    body: JSON.stringify({
      user_uid: uid,
      email,
      updated_at: new Date().toISOString(),
    }),
  })
}

// After settlement gives up on a payout, the $0 side may still fix their email.
async function loadFailedPayoutBoat(requestId: string, uid: string) {
  const [boat] = await db<BoatRow[]>(
    `boat_requests?id=eq.${encodeURIComponent(requestId)}&select=id,cycle_id,requester_uid,partner_uid,status,deadline_at,requester_bet_cents,partner_bet_cents`
  )
  if (!boat) return null
  const isRequester = boat.requester_uid === uid
  if (!isRequester && boat.partner_uid !== uid) return null
  const mine = isRequester ? boat.requester_bet_cents : boat.partner_bet_cents
  if (mine !== 0) return null
  const failed = await db<{ id: string }[]>(
    `boat_stakes?request_id=eq.${encodeURIComponent(boat.id)}&cycle_id=eq.${boat.cycle_id}&payout_status=eq.failed&select=id`
  )
  return failed.length > 0 ? boat : null
}

async function setPayoutEmail(
  uid: string,
  requestId: string,
  rawEmail: unknown,
  rawConfirm: unknown
) {
  const checked = confirmedEmail(rawEmail, rawConfirm)
  if ("error" in checked) return json({ error: checked.error }, 400)
  const { email } = checked

  const context = await loadStakeContext(requestId, uid)
  let boat: BoatRow
  if ("error" in context) {
    const failedBoat = await loadFailedPayoutBoat(requestId, uid)
    if (!failedBoat) return json({ error: context.error }, 409)
    boat = failedBoat
  } else {
    if (context.amount > 0 || context.opponentAmount <= 0) {
      return json({ error: "A PayPal payout email is not needed for this boat." }, 409)
    }
    boat = context.boat
  }

  await saveBoatPayoutEmail(boat, uid, email)
  // Lets settlement try again for a payout that previously failed.
  await patch(
    "boat_stakes",
    `request_id=eq.${encodeURIComponent(boat.id)}&cycle_id=eq.${boat.cycle_id}&payout_status=eq.failed`,
    { payout_status: null, payout_attempts: 0 }
  )
  if (!(await loadDefaultEmail(uid))) await saveDefaultEmail(uid, email)
  return json({ ok: true, email })
}

// Uses the saved default, otherwise the verified payer email of an earlier PayPal bet.
async function useSavedPayoutEmail(uid: string, requestId: string) {
  const context = await loadStakeContext(requestId, uid)
  if ("error" in context) return json({ error: context.error }, 409)
  if (context.amount > 0 || context.opponentAmount <= 0) {
    return json({ error: "A PayPal payout email is not needed for this boat." }, 409)
  }
  let email = await loadDefaultEmail(uid)
  if (!email) {
    const [stake] = await db<{ payer_email: string | null }[]>(
      `boat_stakes?user_uid=eq.${uid}&payer_email=not.is.null&order=updated_at.desc&limit=1&select=payer_email`
    )
    email = stake?.payer_email ?? null
  }
  if (!email) return json({ ok: true, email: null })
  await saveBoatPayoutEmail(context.boat, uid, email)
  return json({ ok: true, email })
}

async function setDefaultPayoutEmail(
  uid: string,
  rawEmail: unknown,
  rawConfirm: unknown
) {
  const checked = confirmedEmail(rawEmail, rawConfirm)
  if ("error" in checked) return json({ error: checked.error }, 400)
  await saveDefaultEmail(uid, checked.email)
  return json({ ok: true, email: checked.email })
}

// The requester pays during pending or review; the partner only after replying (review).
async function loadStakeContext(requestId: string, uid: string) {
  const rows = await db<BoatRow[]>(
    `boat_requests?id=eq.${encodeURIComponent(requestId)}&select=id,cycle_id,requester_uid,partner_uid,status,deadline_at,requester_bet_cents,partner_bet_cents`
  )
  const boat = rows[0]
  if (!boat) return { error: "Boat request not found." }
  const isRequester = boat.requester_uid === uid
  if (!isRequester && boat.partner_uid !== uid)
    return { error: "Boat request not found." }
  const allowed = isRequester ? ["pending", "review"] : ["review"]
  if (!allowed.includes(boat.status)) {
    return { error: "This boat is not waiting for your payment authorization." }
  }
  if (!boat.deadline_at || Date.parse(boat.deadline_at) <= Date.now()) {
    return { error: "This boat has no valid deadline." }
  }
  const amount = isRequester ? boat.requester_bet_cents : boat.partner_bet_cents
  const opponentAmount = isRequester
    ? boat.partner_bet_cents
    : boat.requester_bet_cents
  return { boat, amount, opponentAmount }
}

Deno.serve(async (request: Request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: cors })
  if (request.method !== "POST")
    return json({ error: "Method not allowed." }, 405)
  if (!hasServiceConfig())
    return json({ error: "Stakes are not configured." }, 500)

  const authorization = request.headers.get("Authorization")
  if (!authorization?.startsWith("Bearer "))
    return json({ error: "Unauthorized." }, 401)
  const uid = await currentUserId(authorization)
  if (!uid) return json({ error: "Unauthorized." }, 401)

  let body: {
    action?: unknown
    requestId?: unknown
    orderId?: unknown
    email?: unknown
    confirmEmail?: unknown
  }
  try {
    body = await request.json()
  } catch {
    return json({ error: "Invalid request." }, 400)
  }
  try {
    if (body.action === "set-default-payout-email") {
      return await setDefaultPayoutEmail(uid, body.email, body.confirmEmail)
    }
    if (body.action === "set-payout-email") {
      if (typeof body.requestId !== "string")
        return json({ error: "Invalid request." }, 400)
      return await setPayoutEmail(
        uid,
        body.requestId,
        body.email,
        body.confirmEmail
      )
    }
    if (body.action === "use-saved-payout-email") {
      if (typeof body.requestId !== "string")
        return json({ error: "Invalid request." }, 400)
      return await useSavedPayoutEmail(uid, body.requestId)
    }
    if (body.action !== "create-order" && body.action !== "authorize-order")
      return json({ error: "Unknown action." }, 400)
    if (typeof body.requestId !== "string")
      return json({ error: "Invalid request." }, 400)
    const context = await loadStakeContext(body.requestId, uid)
    if ("error" in context) return json({ error: context.error }, 409)
    const { boat, amount } = context

    if (amount <= 0)
      return json({ error: "A $0 bet does not need PayPal." }, 409)
    const filter = `request_id=eq.${encodeURIComponent(boat.id)}&cycle_id=eq.${boat.cycle_id}&user_uid=eq.${uid}`
    const [stake] = await db<StakeRow[]>(
      `boat_stakes?${filter}&select=id,amount_cents,paypal_order_id,authorization_id,status`
    )

    if (body.action === "create-order") {
      if (stake?.status === "authorized" && stake.amount_cents === amount) {
        return json({ error: "Your bet is already authorized." }, 409)
      }
      if (stake && ["captured", "failed"].includes(stake.status)) {
        return json({ error: "This payment can no longer be changed." }, 409)
      }
      // A changed bet invalidates the old hold, so release it before making a new order.
      if (stake?.status === "authorized" && stake.authorization_id) {
        await voidAuthorization(stake.authorization_id, stake.id)
      }
      const order = await createAuthorizeOrder(
        amount,
        `${boat.id}:${boat.cycle_id}:${uid}`.slice(0, 127),
        `order-${crypto.randomUUID()}`
      )
      await db("boat_stakes?on_conflict=request_id,cycle_id,user_uid", {
        method: "POST",
        prefer: "resolution=merge-duplicates,return=minimal",
        body: JSON.stringify({
          request_id: boat.id,
          cycle_id: boat.cycle_id,
          user_uid: uid,
          amount_cents: amount,
          paypal_order_id: order.id,
          authorization_id: null,
          payer_email: null,
          status: "created",
          planned_action: null,
          updated_at: new Date().toISOString(),
        }),
      })
      return json({ orderId: order.id })
    }

    if (body.action === "authorize-order") {
      if (
        typeof body.orderId !== "string" ||
        stake?.paypal_order_id !== body.orderId ||
        stake.status !== "created" ||
        stake.amount_cents !== amount
      ) {
        return json(
          { error: "This payment does not match your current bet." },
          409
        )
      }
      const result = await authorizeOrder(body.orderId)
      const authorizationData =
        result.purchase_units?.[0]?.payments?.authorizations?.[0]
      if (
        authorizationData?.status !== "CREATED" ||
        authorizationData.amount?.value !== dollars(amount) ||
        authorizationData.amount?.currency_code !== "USD"
      ) {
        await patch("boat_stakes", `id=eq.${stake.id}`, { status: "failed" })
        return json({ error: "PayPal did not authorize this payment." }, 402)
      }
      await patch("boat_stakes", `id=eq.${stake.id}`, {
        status: "authorized",
        authorized_at: new Date().toISOString(),
        authorization_id: authorizationData.id,
        payer_email: result.payer?.email_address ?? null,
      })
      return json({ ok: true })
    }

    return json({ error: "Unknown action." }, 400)
  } catch (error) {
    console.error(
      "boat-stakes failed.",
      error instanceof PayPalError ? error.issues : error
    )
    return json(
      { error: "Unable to complete the PayPal step. Please try again." },
      502
    )
  }
})
