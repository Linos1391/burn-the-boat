import { useCallback, useEffect, useRef, useState } from "react"
import type { SupabaseClient } from "@supabase/supabase-js"
import type { BoatRequest } from "./boat-requests"
import { APP_ERRORS } from "./errors"
import { createLogger } from "./logging"

const logger = createLogger("boat-stakes")

export type StakeStatus =
  "created" | "authorized" | "captured" | "voided" | "failed" | "unpaid" | "refunded"

export type BoatStake = {
  userUid: string
  amountCents: number
  status: StakeStatus
  payoutStatus: "sent" | "skipped" | "failed" | "refunded" | null
  atRisk: boolean
}

const REFRESH_INTERVAL_MS = 10000
const MAX_RETRIES = 3
const INITIAL_BACKOFF_MS = 500

// Exponential backoff retry helper
async function retryWithBackoff<T>(
  fn: () => Promise<T>,
  maxRetries: number = MAX_RETRIES
): Promise<T> {
  let lastError: unknown
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      return await fn()
    } catch (error) {
      lastError = error
      if (attempt < maxRetries - 1) {
        const delayMs = INITIAL_BACKOFF_MS * Math.pow(2, attempt)
        await new Promise((resolve) => setTimeout(resolve, delayMs))
      }
    }
  }
  throw lastError
}

export function useBoatStakes(
  supabase: SupabaseClient | null,
  request: BoatRequest | undefined
) {
  const [state, setState] = useState<{
    key: string
    stakes: BoatStake[]
    payoutEmailUids: string[]
    error: string | null
    loaded: boolean
  }>({ key: "", stakes: [], payoutEmailUids: [], error: null, loaded: false })
  
  const sequence = useRef(0)
  const abortControllerRef = useRef<AbortController | null>(null)
  const isLoadingRef = useRef(false)
  const visibilityHandlerRef = useRef<(() => void) | null>(null)
  
  const requestId = request?.id
  const cycleId = request?.cycleId
  const key = requestId && cycleId ? `${requestId}:${cycleId}` : ""

  const refresh = useCallback(async () => {
    if (!supabase || !requestId || !cycleId || isLoadingRef.current) return
    
    const requestSequence = ++sequence.current
    const currentKey = `${requestId}:${cycleId}`
    
    // Cancel any in-flight request
    abortControllerRef.current?.abort()
    abortControllerRef.current = new AbortController()
    
    isLoadingRef.current = true
    
    try {
      const loadData = async () => {
        const [stakeResult, emailResult] = await Promise.all([
          supabase
            .from("boat_stakes")
            .select("user_uid, amount_cents, status, payout_status, at_risk")
            .eq("request_id", requestId)
            .eq("cycle_id", cycleId),
          supabase
            .from("boat_payout_emails")
            .select("user_uid")
            .eq("request_id", requestId)
            .eq("cycle_id", cycleId),
        ])
        
        if (stakeResult.error) throw stakeResult.error
        if (emailResult.error) throw emailResult.error
        if (!stakeResult.data || !emailResult.data) {
          throw new Error("Missing payment data.")
        }
        
        return { stakeResult, emailResult }
      }

      const { stakeResult, emailResult } = await retryWithBackoff(loadData)

      if (sequence.current !== requestSequence) {
        logger.debug("Request cancelled due to newer sequence", { requestSequence, current: sequence.current })
        return
      }

      setState({
        key: currentKey,
        error: null,
        loaded: true,
        payoutEmailUids: emailResult.data.map((row) => row.user_uid as string),
        stakes: stakeResult.data.map((row) => ({
          userUid: row.user_uid,
          amountCents: row.amount_cents,
          status: row.status,
          payoutStatus: row.payout_status,
          atRisk: row.at_risk === true,
        })),
      })
    } catch (error) {
      if (sequence.current !== requestSequence) return
      logger.error("Unable to load boat payment details", error)
      setState({
        key: currentKey,
        stakes: [],
        payoutEmailUids: [],
        error: "Unable to load payment details. Please try again.",
        loaded: false,
      })
    } finally {
      isLoadingRef.current = false
    }
  }, [supabase, requestId, cycleId])

  useEffect(() => {
    if (!key) return

    // Handle document visibility to pause polling when tab is hidden
    const handleVisibilityChange = () => {
      if (document.hidden) {
        logger.debug("Tab hidden, pausing polling")
      } else {
        logger.debug("Tab visible, resuming polling")
        void refresh()
      }
    }

    document.addEventListener("visibilitychange", handleVisibilityChange)
    visibilityHandlerRef.current = handleVisibilityChange

    // Initial load
    const first = window.setTimeout(() => void refresh(), 0)
    
    // Set up polling interval (respects visibility)
    const timer = window.setInterval(() => {
      if (!document.hidden) {
        void refresh()
      }
    }, REFRESH_INTERVAL_MS)

    return () => {
      sequence.current += 1
      abortControllerRef.current?.abort()
      window.clearTimeout(first)
      window.clearInterval(timer)
      if (visibilityHandlerRef.current) {
        document.removeEventListener("visibilitychange", visibilityHandlerRef.current)
      }
    }
  }, [key, refresh])

  const current = state.key === key
  return {
    stakes: current ? state.stakes : [],
    payoutEmailUids: current ? state.payoutEmailUids : [],
    loaded: current && state.loaded,
    error: current ? state.error : null,
    refresh,
  }
}

export function isStakeAuthorized(
  stakes: BoatStake[],
  userUid: string,
  betCents: number
) {
  return (
    betCents === 0 ||
    stakes.some(
      (stake) =>
        stake.userUid === userUid &&
        stake.amountCents === betCents &&
        ["authorized", "captured"].includes(stake.status)
    )
  )
}

// A user with a $0 bet only needs a payout email when the other side bets money.
export function needsPayoutEmail(request: BoatRequest, userUid: string) {
  const isRequester = request.requesterUid === userUid
  const mine = isRequester ? request.requesterBetCents : request.partnerBetCents
  const theirs = isRequester
    ? request.partnerBetCents
    : request.requesterBetCents
  return mine === 0 && theirs > 0
}

export function isPayoutReady(
  request: BoatRequest,
  userUid: string,
  payoutEmailUids: string[]
) {
  return (
    !needsPayoutEmail(request, userUid) || payoutEmailUids.includes(userUid)
  )
}

// The user's winnings are sent to the payout email of the boat the user bet $0 on.
export async function savePayoutEmail(
  supabase: SupabaseClient,
  requestId: string,
  email: string,
  confirmEmail: string
) {
  await callStakes(supabase, {
    action: "set-payout-email",
    requestId,
    email,
    confirmEmail,
  })
}

// Applies the default payout email, or the payer email of an earlier bet. Returns null when neither exists.
export async function applySavedPayoutEmail(
  supabase: SupabaseClient,
  requestId: string
) {
  const data = await callStakes(supabase, {
    action: "use-saved-payout-email",
    requestId,
  })
  return typeof data.email === "string" ? data.email : null
}

export async function saveDefaultPayoutEmail(
  supabase: SupabaseClient,
  email: string,
  confirmEmail: string
) {
  await callStakes(supabase, {
    action: "set-default-payout-email",
    email,
    confirmEmail,
  })
}

export function maskEmail(email: string) {
  const [name = "", domain = ""] = email.split("@")
  return `${name.slice(0, 1)}***@${domain}`
}

// A payout the server gave up on, which the $0 side can fix by updating their email.
export function hasFailedPayout(stakes: BoatStake[]) {
  return stakes.some((stake) => stake.payoutStatus === "failed")
}

async function callStakes(
  supabase: SupabaseClient,
  body: Record<string, string>
) {
  const makeRequest = async () => {
    const { data, error } = await supabase.functions.invoke("boat-stakes", {
      body,
    })
    if (error) {
      const response = (error as { context?: Response }).context
      const message = response
        ? ((await response.json().catch(() => null)) as { error?: string } | null)
            ?.error
        : undefined
      throw new Error(message ?? APP_ERRORS.paypal_step)
    }
    return data as Record<string, unknown>
  }

  return retryWithBackoff(makeRequest)
}

export async function createStakeOrder(
  supabase: SupabaseClient,
  requestId: string
) {
  const data = await callStakes(supabase, { action: "create-order", requestId })
  if (typeof data.orderId !== "string") throw new Error(APP_ERRORS.paypal_order)
  return data.orderId
}

export async function authorizeStakeOrder(
  supabase: SupabaseClient,
  requestId: string,
  orderId: string
) {
  await callStakes(supabase, { action: "authorize-order", requestId, orderId })
}

export function useDefaultPayoutEmail(
  supabase: SupabaseClient | null,
  userId: string
) {
  const [state, setState] = useState<{
    userId: string
    email: string | null
    error: string | null
  } | null>(null)
  const sequence = useRef(0)
  const abortControllerRef = useRef<AbortController | null>(null)

  const refresh = useCallback(async () => {
    if (!supabase) return
    
    const requestSequence = ++sequence.current
    
    // Cancel previous request
    abortControllerRef.current?.abort()
    abortControllerRef.current = new AbortController()
    
    try {
      const { data, error } = await supabase
        .from("user_payout_emails")
        .select("email")
        .eq("user_uid", userId)
        .maybeSingle()
      if (error) throw error
      if (sequence.current !== requestSequence) return
      setState({ userId, email: (data?.email as string | undefined) ?? null, error: null })
    } catch (error) {
      if (sequence.current !== requestSequence) return
      logger.error("Unable to load payout email", error)
      setState({ userId, email: null, error: "Unable to load your payout email. Please try again." })
    }
  }, [supabase, userId])

  useEffect(() => {
    const timer = window.setTimeout(() => void refresh(), 0)
    return () => {
      sequence.current += 1
      abortControllerRef.current?.abort()
      window.clearTimeout(timer)
    }
  }, [refresh])

  const current = state?.userId === userId
  return {
    loaded: current && !state.error,
    email: current ? state.email : null,
    error: current ? state.error : null,
    refresh,
  }
}
