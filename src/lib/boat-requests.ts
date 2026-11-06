import type { SupabaseClient } from "@supabase/supabase-js"
import { APP_ERRORS, AppError } from "./errors"
import { isRecord } from "./utils"
import { DbTimestamp, parseTimestamp } from "./supabase"
import type { Pairing } from "./pairings"

export type BoatPlanTask = {
  id: string
  title: string
  estimatedMinutes: number
  category: string
  dependsOn: string[]
}

export type BoatPlan = {
  id: string
  title: string
  description: string
  mode: "casual" | "fire" | "inferno"
  boatReady: boolean
  totalEstimatedMinutes: number
  tasks: BoatPlanTask[]
}

export type BoatRequestStatus =
  "pending" | "review" | "active" | "completed" | "denied" | "cancelled"

export type BoatStakeMode = "collaborate" | "racing"

export type BoatRequest = {
  id: string
  cycleId: string
  requesterUid: string
  partnerUid: string
  status: BoatRequestStatus
  requesterPlan: BoatPlan
  partnerPlan: BoatPlan | null
  stakeMode: BoatStakeMode
  deadlineAt: DbTimestamp | null
  requesterBetCents: number
  partnerBetCents: number
  requesterForfeited: boolean
  partnerForfeited: boolean
  createdAt: DbTimestamp
}

export type BoatChatMessage = {
  id: string
  cycleId: string
  senderUid: string
  text: string
  createdAt: DbTimestamp
}

const LIVE_STATUSES: BoatRequestStatus[] = ["pending", "review", "active"]

function parsePlan(value: unknown): BoatPlan {
  if (!isRecord(value) || !Array.isArray(value.tasks)) {
    throw new AppError(APP_ERRORS.invalid_data)
  }
  const { id, title, description, mode, totalEstimatedMinutes, tasks } = value
  if (
    typeof id !== "string" ||
    typeof title !== "string" ||
    typeof description !== "string" ||
    (mode !== "casual" && mode !== "fire" && mode !== "inferno") ||
    typeof totalEstimatedMinutes !== "number" ||
    !Number.isInteger(totalEstimatedMinutes) ||
    tasks.length > 50
  ) {
    throw new AppError(APP_ERRORS.invalid_data)
  }
  const parsedTasks = tasks.map((task) => {
    if (
      !isRecord(task) ||
      typeof task.id !== "string" ||
      typeof task.title !== "string" ||
      typeof task.estimatedMinutes !== "number" ||
      typeof task.category !== "string" ||
      !Array.isArray(task.dependsOn) ||
      !task.dependsOn.every((id) => typeof id === "string")
    ) {
      throw new AppError(APP_ERRORS.invalid_data)
    }
    return {
      id: task.id,
      title: task.title,
      estimatedMinutes: task.estimatedMinutes,
      category: task.category,
      dependsOn: task.dependsOn,
    }
  })
  return {
    id,
    title,
    description,
    mode,
    boatReady: value.boatReady === true,
    totalEstimatedMinutes,
    tasks: parsedTasks,
  }
}

export function parseBoatRequest(value: Record<string, unknown>): BoatRequest {
  if (
    typeof value.id !== "string" ||
    typeof value.cycle_id !== "string" ||
    typeof value.requester_uid !== "string" ||
    typeof value.partner_uid !== "string" ||
    typeof value.status !== "string" ||
    !LIVE_STATUSES.concat(["completed", "denied", "cancelled"]).includes(
      value.status as BoatRequestStatus
    )
  ) {
    throw new AppError(APP_ERRORS.invalid_data)
  }
  return {
    id: value.id,
    cycleId: value.cycle_id,
    requesterUid: value.requester_uid,
    partnerUid: value.partner_uid,
    status: value.status as BoatRequestStatus,
    requesterPlan: parsePlan(value.requester_plan),
    partnerPlan: value.partner_plan ? parsePlan(value.partner_plan) : null,
    stakeMode: value.stake_mode === "racing" ? "racing" : "collaborate",
    deadlineAt: value.deadline_at ? parseTimestamp(value.deadline_at) : null,
    requesterBetCents: Number(value.requester_bet_cents) || 0,
    partnerBetCents: Number(value.partner_bet_cents) || 0,
    requesterForfeited: typeof value.requester_forfeited_at === "string",
    partnerForfeited: typeof value.partner_forfeited_at === "string",
    createdAt: parseTimestamp(value.created_at),
  }
}

export function parseBoatChatMessage(
  value: Record<string, unknown>
): BoatChatMessage {
  if (
    typeof value.id !== "string" ||
    typeof value.pairing_id !== "string" ||
    typeof value.sender_uid !== "string" ||
    typeof value.text !== "string"
  ) {
    throw new AppError(APP_ERRORS.invalid_data)
  }
  return {
    id: value.id,
    cycleId: value.pairing_id,
    senderUid: value.sender_uid,
    text: value.text,
    createdAt: parseTimestamp(value.created_at),
  }
}

export async function createBoatRequest(
  supabase: SupabaseClient,
  pairing: Pairing,
  requesterUid: string,
  requesterPlan: BoatPlan,
  terms: { mode: BoatStakeMode; deadline: Date; betCents: number }
) {
  const partnerUid =
    pairing.ownerUid === requesterUid ? pairing.partnerUid : pairing.ownerUid
  const { error } = await supabase.rpc("create_boat_request_with_terms", {
    p_pairing_id: pairing.id,
    p_requester_plan: requesterPlan,
    p_mode: terms.mode,
    p_deadline: terms.deadline.toISOString(),
    p_bet_cents: terms.betCents,
  })
  if (error) throw error
  return partnerUid
}

export async function setPartnerBet(
  supabase: SupabaseClient,
  request: BoatRequest,
  betCents: number
) {
  const { error } = await supabase.rpc("set_boat_partner_bet", {
    p_request_id: request.id,
    p_cycle_id: request.cycleId,
    p_bet_cents: betCents,
  })
  if (error) throw error
}

export function parseBetInput(value: string) {
  const dollars = Number(value.trim() === "" ? "0" : value)
  if (!Number.isFinite(dollars) || dollars < 0 || dollars > 500) return null
  return Math.round(dollars * 100)
}

export function formatBet(cents: number) {
  return cents === 0 ? "$0" : `$${(cents / 100).toFixed(2)}`
}

export async function submitPartnerPlan(
  supabase: SupabaseClient,
  request: BoatRequest,
  _partnerUid: string,
  partnerPlan: BoatPlan
) {
  const { error } = await supabase.rpc("submit_partner_plan", {
    p_request_id: request.id,
    p_cycle_id: request.cycleId,
    p_partner_plan: partnerPlan,
  })
  if (error) throw error
}

export async function decideBoatRequest(
  supabase: SupabaseClient,
  request: BoatRequest,
  decision: "accept" | "deny",
  requesterPlan?: BoatPlan
) {
  const { error } = await supabase.rpc("decide_boat_request", {
    p_request_id: request.id,
    p_cycle_id: request.cycleId,
    p_decision: decision,
    p_requester_plan: requesterPlan ?? null,
  })
  if (error) throw error
}

export async function cancelBoatRequest(
  supabase: SupabaseClient,
  request: BoatRequest
) {
  const { error } = await supabase.rpc("cancel_boat_request", {
    p_request_id: request.id,
    p_cycle_id: request.cycleId,
  })
  if (error) throw error
}

export async function forfeitBoatRequest(
  supabase: SupabaseClient,
  request: BoatRequest
) {
  const { error } = await supabase.rpc("forfeit_boat_request", {
    p_request_id: request.id,
    p_cycle_id: request.cycleId,
  })
  if (error) throw error
}

export async function sendBoatChatMessage(
  supabase: SupabaseClient,
  pairing: Pairing,
  senderUid: string,
  text: string
) {
  const { error } = await supabase.from("pair_chat_messages").insert({
    pairing_id: pairing.id,
    sender_uid: senderUid,
    text,
  })
  if (error) throw error
}
