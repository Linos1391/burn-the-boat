import { db, hasServiceConfig, patch } from "../_shared/db.ts"
import {
  captureAuthorization,
  PayPalError,
  reauthorize,
  refundCapture,
  sendPayout,
  voidAuthorization,
} from "../_shared/paypal.ts"

type Stake = {
  id: string
  user_uid: string
  amount_cents: number
  authorization_id: string | null
  payer_email: string | null
  status: string
  payout_status: string | null
  payout_attempts: number
  payout_failed_at: string | null
  capture_id: string | null
  planned_action: "capture" | "void" | null
}

type Boat = {
  id: string
  cycle_id: string
  requester_uid: string
  partner_uid: string
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  })

async function voidStake(stake: Stake) {
  if (stake.authorization_id && stake.status === "authorized") {
    await voidAuthorization(stake.authorization_id, stake.id)
  }
  await patch("boat_stakes", `id=eq.${stake.id}`, { status: "voided" })
}

async function releaseOrphans() {
  const orphans = await db<Stake[]>("rpc/boat_stakes_to_release", {
    method: "POST",
    body: "{}",
  })
  let failures = 0
  for (const stake of orphans) {
    try {
      await voidStake(stake)
    } catch (error) {
      failures += 1
      console.error("Unable to release stake.", stake.id, error)
    }
  }
  return failures
}

const DAY = 24 * 60 * 60 * 1000
// How long a winner has to fix a failed payout before the loser is refunded.
const REFUND_GRACE_DAYS = 7

// Holds older than PayPal's 3-day guarantee are renewed once, about 2 days before the deadline.
async function reauthorizeLongHolds() {
  const boats = await db<{ id: string; cycle_id: string }[]>(
    `boat_requests?status=eq.active&settled_at=is.null&deadline_at=lt.${new Date(Date.now() + 2 * DAY).toISOString()}&select=id,cycle_id`
  )
  for (const boat of boats) {
    const stakes = await db<
      { id: string; authorization_id: string; amount_cents: number }[]
    >(
      `boat_stakes?request_id=eq.${encodeURIComponent(boat.id)}&cycle_id=eq.${boat.cycle_id}&status=eq.authorized&reauthorized_at=is.null&authorized_at=lt.${new Date(Date.now() - 3 * DAY).toISOString()}&select=id,authorization_id,amount_cents`
    )
    for (const stake of stakes) {
      const now = new Date().toISOString()
      try {
        const id = await reauthorize(
          stake.authorization_id,
          stake.amount_cents,
          stake.id
        )
        await patch("boat_stakes", `id=eq.${stake.id}`, {
          authorization_id: id,
          reauthorized_at: now,
        })
      } catch (error) {
        console.error("Unable to reauthorize stake.", stake.id, error)
        await patch("boat_stakes", `id=eq.${stake.id}`, {
          reauthorized_at: now,
          at_risk: true,
        })
      }
    }
  }
}

async function settleBoat(boat: Boat) {
  const filter = `request_id=eq.${encodeURIComponent(boat.id)}&cycle_id=eq.${boat.cycle_id}`
  const select =
    "id,user_uid,amount_cents,authorization_id,payer_email,status,payout_status,payout_attempts,payout_failed_at,capture_id,planned_action"
  let stakes = await db<Stake[]>(`boat_stakes?${filter}&select=${select}`)
  const payoutEmails = new Map(
    (
      await db<{ user_uid: string; email: string }[]>(
        `boat_payout_emails?${filter}&select=user_uid,email`
      )
    ).map((row) => [row.user_uid, row.email])
  )
  const recipientEmail = (stake: Stake) => {
    const opponentUid =
      stake.user_uid === boat.requester_uid
        ? boat.partner_uid
        : boat.requester_uid
    return (
      stakes.find((other) => other.user_uid === opponentUid)?.payer_email ??
      payoutEmails.get(opponentUid) ??
      null
    )
  }

  // Decisions are saved before any money moves so a later task edit cannot flip them.
  if (!stakes.some((stake) => stake.planned_action)) {
    const [outcome] = await db<
      { settled: boolean; requester_action: string; partner_action: string }[]
    >("rpc/boat_stake_outcome", {
      method: "POST",
      body: JSON.stringify({ p_request_id: boat.id }),
    })
    if (!outcome?.settled) return false
    for (const stake of stakes) {
      const action =
        stake.user_uid === boat.requester_uid
          ? outcome.requester_action
          : outcome.partner_action
      // A winner without a PayPal email cannot be paid, so that hold is released instead.
      const planned =
        action === "capture" && recipientEmail(stake) ? "capture" : "void"
      await patch("boat_stakes", `id=eq.${stake.id}`, {
        planned_action: planned,
      })
    }
    stakes = await db<Stake[]>(`boat_stakes?${filter}&select=${select}`)
  }

  let complete = true
  for (const stake of stakes) {
    try {
      if (stake.status === "authorized" && stake.planned_action === "void") {
        await voidStake(stake)
      } else if (
        stake.status === "authorized" &&
        stake.planned_action === "capture"
      ) {
        const captureId = await captureAuthorization(
          stake.authorization_id!,
          stake.id
        )
        await patch("boat_stakes", `id=eq.${stake.id}`, {
          status: "captured",
          capture_id: captureId,
        })
        stake.status = "captured"
        stake.capture_id = captureId
      }
      if (
        stake.status === "captured" &&
        stake.payout_status === "failed" &&
        stake.capture_id &&
        stake.payout_failed_at &&
        Date.now() - Date.parse(stake.payout_failed_at) >=
          REFUND_GRACE_DAYS * DAY
      ) {
        await refundCapture(stake.capture_id, stake.id)
        await patch("boat_stakes", `id=eq.${stake.id}`, {
          status: "refunded",
          payout_status: "refunded",
        })
        stake.status = "refunded"
        stake.payout_status = "refunded"
      }
      if (stake.status === "captured" && !stake.payout_status) {
        let batchId: string
        try {
          batchId = await sendPayout(
            recipientEmail(stake)!,
            stake.amount_cents,
            stake.id
          )
        } catch (payoutError) {
          // A refused payout will not succeed on its own, so stop and let the winner fix the email.
          const attempts = stake.payout_attempts + 1
          const refused =
            payoutError instanceof PayPalError &&
            payoutError.status >= 400 &&
            payoutError.status < 500 &&
            payoutError.status !== 429
          const failed = refused || attempts >= 5
          await patch("boat_stakes", `id=eq.${stake.id}`, {
            payout_attempts: attempts,
            ...(failed
              ? {
                  payout_status: "failed",
                  payout_failed_at: new Date().toISOString(),
                }
              : {}),
          })
          console.error("Unable to send payout.", stake.id, payoutError)
          complete = false
          continue
        }
        await patch("boat_stakes", `id=eq.${stake.id}`, {
          payout_status: "sent",
          payout_batch_id: batchId,
        })
      }
    } catch (error) {
      // PayPal refusing the capture (not a network or server error) means the loser cannot pay.
      if (
        error instanceof PayPalError &&
        error.status >= 400 &&
        error.status < 500 &&
        error.status !== 429 &&
        stake.status === "authorized"
      ) {
        await patch("boat_stakes", `id=eq.${stake.id}`, { status: "unpaid" })
        console.error(
          "Capture refused; stake marked unpaid.",
          stake.id,
          error.issues
        )
        continue
      }
      complete = false
      console.error("Unable to settle stake.", stake.id, error)
    }
  }
  // The boat stays open until a failed payout is fixed and sent.
  if (stakes.some((stake) => stake.payout_status === "failed")) complete = false
  return complete
}

Deno.serve(async (request: Request) => {
  if (request.method !== "POST")
    return json({ error: "Method not allowed." }, 405)
  if (!hasServiceConfig())
    return json({ error: "Settlement is not configured." }, 500)
  if (request.headers.get("apikey") !== Deno.env.get("SERVICE_ROLE_KEY")) {
    return json({ error: "Unauthorized." }, 401)
  }

  let failures = await releaseOrphans()
  try {
    await reauthorizeLongHolds()
  } catch (error) {
    failures += 1
    console.error("Reauthorization pass failed.", error)
  }
  const boats = await db<Boat[]>("rpc/boats_to_settle", {
    method: "POST",
    body: "{}",
  })
  let settled = 0
  for (const boat of boats) {
    try {
      if (await settleBoat(boat)) {
        await patch(
          "boat_requests",
          `id=eq.${encodeURIComponent(boat.id)}&cycle_id=eq.${boat.cycle_id}`,
          {
            settled_at: new Date().toISOString(),
            status: "completed",
          }
        )
        settled += 1
      }
    } catch (error) {
      failures += 1
      console.error("Unable to settle boat.", boat.id, error)
    }
  }
  return json({ settled, failures }, failures > 0 ? 500 : 200)
})
