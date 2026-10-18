import {
  collection,
  doc,
  getDocs,
  query,
  runTransaction,
  serverTimestamp,
  Timestamp,
  where,
  type DocumentData,
  type Firestore,
} from "firebase/firestore"

const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
export const CODE_LENGTH = 12
const MAX_CODE_ATTEMPTS = 5
export const PAIRING_CODE_TTL_MS = 5 * 60 * 1000 // 5min, in ms

export function isValidPairingCode(code: string) {
  return code.length === CODE_LENGTH && /^[A-HJ-NP-Z2-9]+$/.test(code)
}

export type Pairing = {
  id: string
  code: string
  ownerUid: string
  ownerName: string
  createdAt: Timestamp
  partnerUid: string
  partnerName: string
  pairedAt: unknown
}

export type PairingInvite = {
  id: string
  ownerUid: string
  ownerName: string
  createdAt: Timestamp
}

export class PairingCodeCollisionError extends Error {
  constructor() {
    super("The generated pairing code is already in use.")
    this.name = "PairingCodeCollisionError"
  }
}

export function getExpireTime(createdTime: Timestamp) {
  return createdTime.toMillis() + PAIRING_CODE_TTL_MS
}

export function parsePairingInvite(
  id: string,
  data: DocumentData
): PairingInvite {
  if (
    typeof data.ownerUid !== "string" ||
    typeof data.ownerName !== "string" ||
    !(data.createdAt instanceof Timestamp)
  ) {
    throw new Error("A pairing invite has an invalid format.")
  }

  return {
    id,
    ownerUid: data.ownerUid,
    ownerName: data.ownerName,
    createdAt: data.createdAt,
  }
}

export function parsePairing(id: string, data: DocumentData): Pairing {
  if (
    typeof data.code !== "string" ||
    typeof data.ownerUid !== "string" ||
    typeof data.ownerName !== "string" ||
    !(data.createdAt instanceof Timestamp) ||
    typeof data.partnerUid !== "string" ||
    typeof data.partnerName !== "string"
  ) {
    throw new Error("A pairing record has an invalid format.")
  }

  return {
    id,
    code: data.code,
    ownerUid: data.ownerUid,
    ownerName: data.ownerName,
    createdAt: data.createdAt,
    partnerUid: data.partnerUid,
    partnerName: data.partnerName,
    pairedAt: data.pairedAt,
  }
}

function generateCode() {
  const randomValues = new Uint8Array(CODE_LENGTH)
  crypto.getRandomValues(randomValues)

  return Array.from(
    randomValues,
    (value) => CODE_ALPHABET[value % CODE_ALPHABET.length]
  ).join("")
}

function getPairingRef(db: Firestore, uid1: string, uid2: string) {
  const [firstUid, secondUid] = uid1 < uid2 ? [uid1, uid2] : [uid2, uid1]

  return doc(db, "pairing", `${firstUid}_${secondUid}`)
}

export async function createPairingCode(
  db: Firestore,
  ownerUid: string,
  ownerName: string
) {
  const ownerPendingPairings = await getDocs(
    query(collection(db, "pairingInvites"), where("ownerUid", "==", ownerUid))
  )
  const hasActiveInvite = ownerPendingPairings.docs.some((pairingDoc) => {
    const invite = parsePairingInvite(pairingDoc.id, pairingDoc.data())
    return !isPairingExpired(invite)
  })

  if (hasActiveInvite) {
    throw new Error(
      "You already have an active invite. Wait for it to be paired or expire before creating another."
    )
  }

  for (let attempt = 0; attempt < MAX_CODE_ATTEMPTS; attempt += 1) {
    const code = generateCode()
    const pairingRef = doc(db, "pairingInvites", code)
    const activeInviteRef = doc(db, "pairingActiveInvites", ownerUid)

    try {
      await runTransaction(db, async (transaction) => {
        const activeInvite = await transaction.get(activeInviteRef)
        const previousInvite = activeInvite.exists()
          ? await transaction.get(
              doc(db, "pairingInvites", activeInvite.data().code)
            )
          : null
        const existingPairing = await transaction.get(pairingRef)

        if (existingPairing.exists()) {
          throw new PairingCodeCollisionError()
        }

        if (
          previousInvite?.exists() &&
          !isPairingExpired(
            parsePairingInvite(previousInvite.id, previousInvite.data())
          )
        ) {
          throw new Error(
            "You already have an active invite. Wait for it to expire before creating another."
          )
        }

        if (activeInvite.exists() && previousInvite?.exists()) {
          transaction.delete(previousInvite.ref)
        }

        transaction.set(pairingRef, {
          ownerUid,
          ownerName,
          createdAt: serverTimestamp(),
        })
        transaction.set(activeInviteRef, {
          code,
          createdAt: serverTimestamp(),
        })
      })

      return code
    } catch (error) {
      if (!(error instanceof PairingCodeCollisionError)) {
        throw error
      }
    }
  }

  throw new Error("Unable to create a unique code. Please try again.")
}

export async function cancelPairingCode(
  db: Firestore,
  ownerUid: string,
  code: string
) {
  const pairingRef = doc(db, "pairingInvites", code)
  const activeInviteRef = doc(db, "pairingActiveInvites", ownerUid)

  await runTransaction(db, async (transaction) => {
    const [pairingSnapshot, activeInviteSnapshot] = await Promise.all([
      transaction.get(pairingRef),
      transaction.get(activeInviteRef),
    ])

    if (!pairingSnapshot.exists()) {
      throw new Error("This invite code no longer exists.")
    }

    const invite = parsePairingInvite(code, pairingSnapshot.data())
    if (invite.ownerUid !== ownerUid) {
      throw new Error("You can only remove an invite code you created.")
    }
    if (
      !activeInviteSnapshot.exists() ||
      activeInviteSnapshot.data().code !== code
    ) {
      throw new Error("This invite code is no longer active.")
    }

    transaction.delete(pairingRef)
    transaction.delete(activeInviteRef)
  })
}

export async function redeemPairingCode(
  db: Firestore,
  code: string,
  partnerUid: string,
  partnerName: string
) {
  const inviteRef = doc(db, "pairingInvites", code)

  await runTransaction(db, async (transaction) => {
    const inviteSnapshot = await transaction.get(inviteRef)

    if (!inviteSnapshot.exists()) {
      throw new Error("That code wasn't found.")
    }

    const invite = parsePairingInvite(code, inviteSnapshot.data())
    if (invite.ownerUid === partnerUid) {
      throw new Error("You can't pair with your own code.")
    }
    if (isPairingExpired(invite)) {
      throw new Error(
        "That code has expired. Ask them to create a new invite code."
      )
    }

    const pairingRef = getPairingRef(db, invite.ownerUid, partnerUid)
    const pairingSnapshot = await transaction.get(pairingRef)
    if (pairingSnapshot.exists()) {
      throw new Error("You're already paired with this person.")
    }

    transaction.set(pairingRef, {
      code,
      ownerUid: invite.ownerUid,
      ownerName: invite.ownerName,
      createdAt: invite.createdAt,
      partnerUid,
      partnerName,
      pairedAt: serverTimestamp(),
    })
    transaction.delete(inviteRef)
    transaction.delete(
      doc(db, "pairingActiveInvites", invite.ownerUid)
    )
  })
}

export async function removePairing(
  db: Firestore,
  currentUserUid: string,
  code: string
) {
  const pairingRef = doc(db, "pairing", code)

  await runTransaction(db, async (transaction) => {
    const pairingSnapshot = await transaction.get(pairingRef)
    if (!pairingSnapshot.exists()) {
      throw new Error("This pairing no longer exists.")
    }

    const pairing = parsePairing(code, pairingSnapshot.data())
    if (
      pairing.ownerUid !== currentUserUid &&
      pairing.partnerUid !== currentUserUid
    ) {
      throw new Error("You can only remove one of your own pairings.")
    }

    transaction.delete(pairingRef)
  })
}

export function getPairingDisplayName(
  pairing: Pairing,
  currentUserUid: string
) {
  return pairing.ownerUid === currentUserUid
    ? pairing.partnerName
    : pairing.ownerName
}

export function isPairingExpired(
  item: { createdAt: Timestamp },
  now = Date.now()
) {
  return getExpireTime(item.createdAt) <= now
}

export function getPairingStatusMessage(error: unknown) {
  if (error instanceof Error) {
    if (
      error.message.includes("permission") ||
      error.message.includes("insufficient")
    ) {
      return "Firestore denied this request. Check that the pairing rules are deployed."
    }
    return error.message
  }

  return "Something went wrong. Please try again."
}
