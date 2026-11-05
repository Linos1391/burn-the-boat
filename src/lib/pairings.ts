import type { SupabaseClient } from "@supabase/supabase-js"
import {
  APP_ERRORS,
  AppError,
  getErrorCode,
  getErrorMessage,
} from "./errors"
import { DbTimestamp, parseTimestamp } from "./supabase"
import { logging } from "./utils"

const PAIRING_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
export const PAIRING_CODE_LENGTH = 12
const MAX_PAIRING_CODE_ATTEMPTS = 5
const PAIRING_CODE_TTL_MS = 5 * 60 * 1000 // 5min, in ms

export type Pairing = {
  id: string
  code: string
  ownerUid: string
  createdAt: DbTimestamp
  partnerUid: string
  pairedAt: DbTimestamp
}

export type PairingInvite = {
  id: string
  ownerUid: string
  createdAt: DbTimestamp
}

type PairingRow = {
  id: string
  code: string
  owner_uid: string
  partner_uid: string
  created_at: string
  paired_at: string
}

type InviteRow = { code: string; owner_uid: string; created_at: string }

export function isValidPairingCode(code: string) {
  return code.length === PAIRING_CODE_LENGTH && /^[A-HJ-NP-Z2-9]+$/.test(code)
}

export function getExpireTime(createdTime: DbTimestamp) {
  return createdTime.toMillis() + PAIRING_CODE_TTL_MS
}

export function parsePairingInvite(data: InviteRow): PairingInvite {
  if (typeof data.owner_uid !== "string" || typeof data.code !== "string") {
    logging("error", "Data in invalid format.", `pairingInviteId=${data.code}`)
    throw new AppError(APP_ERRORS.pairing_invalid)
  }
  return {
    id: data.code,
    ownerUid: data.owner_uid,
    createdAt: parseTimestamp(data.created_at),
  }
}

export function parsePairing(data: PairingRow): Pairing {
  if (
    typeof data.id !== "string" ||
    typeof data.code !== "string" ||
    typeof data.owner_uid !== "string" ||
    typeof data.partner_uid !== "string"
  ) {
    logging("error", "Data in invalid format.", `pairingId=${data.id}`)
    throw new AppError(APP_ERRORS.pairing_invalid)
  }
  return {
    id: data.id,
    code: data.code,
    ownerUid: data.owner_uid,
    createdAt: parseTimestamp(data.created_at),
    partnerUid: data.partner_uid,
    pairedAt: parseTimestamp(data.paired_at),
  }
}

function generateCode() {
  const randomValues = new Uint8Array(PAIRING_CODE_LENGTH)
  crypto.getRandomValues(randomValues)
  return Array.from(
    randomValues,
    (value) => PAIRING_CODE_ALPHABET[value % PAIRING_CODE_ALPHABET.length]
  ).join("")
}

export async function createPairingCode(
  supabase: SupabaseClient,
  ownerUid: string
) {
  const { data: existing, error: lookupError } = await supabase
    .from("pairing_invites")
    .select("code, owner_uid, created_at")
    .eq("owner_uid", ownerUid)
    .maybeSingle()
  if (lookupError) throw new AppError(APP_ERRORS.generic, lookupError)
  if (existing && !isPairingExpired(parsePairingInvite(existing))) {
    throw new AppError(APP_ERRORS.pairing_active)
  }

  for (let attempt = 0; attempt < MAX_PAIRING_CODE_ATTEMPTS; attempt += 1) {
    const code = generateCode()
    const { error } = await supabase.rpc("create_pairing_invite", {
      p_code: code,
    })
    if (!error) return code
    if (error.code === "23505") {
      if (error.message.includes("pairing_invites_owner_uid_key")) {
        throw new AppError(APP_ERRORS.pairing_active, error)
      }
      continue
    }
    logging(
      "error",
      `Unable to create pairing invite: ${error.message}`,
      `ownerUid=${ownerUid}`
    )
    throw new AppError(APP_ERRORS.generic, error)
  }
  logging("error", "User cannot create invite code.", `ownerUid=${ownerUid}`)
  throw new AppError(APP_ERRORS.pairing_cannot_create)
}

export async function cancelPairingCode(
  supabase: SupabaseClient,
  ownerUid: string,
  code: string
) {
  const { error } = await supabase
    .from("pairing_invites")
    .delete()
    .eq("code", code)
    .eq("owner_uid", ownerUid)
  if (error) throw new AppError(APP_ERRORS.pairing_cannot_remove, error)
}

export async function redeemPairingCode(
  supabase: SupabaseClient,
  code: string
) {
  const { error } = await supabase.rpc("redeem_pairing_invite", {
    p_code: code,
  })
  if (error) throw new AppError(APP_ERRORS.pairing_cannot_pair, error)
}

export async function removePairing(
  supabase: SupabaseClient,
  pairingId: string
) {
  const { error } = await supabase.from("pairings").delete().eq("id", pairingId)
  if (error) throw new AppError(APP_ERRORS.pairing_cannot_remove, error)
}

export function getPairingPartnerUid(pairing: Pairing, currentUserUid: string) {
  return pairing.ownerUid === currentUserUid
    ? pairing.partnerUid
    : pairing.ownerUid
}

export function isPairingExpired(
  item: { createdAt: DbTimestamp },
  now = Date.now()
) {
  return getExpireTime(item.createdAt) <= now
}

export function getPairingStatusMessage(error: unknown) {
  const code =
    getErrorCode(error) ??
    getErrorCode(error instanceof Error ? error.cause : null)
  return code === "23505" ? APP_ERRORS.pairing_active : getErrorMessage(error)
}
