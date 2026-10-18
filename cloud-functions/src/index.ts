import { initializeApp } from "firebase-admin/app"
import { getFirestore } from "firebase-admin/firestore"
import * as functions from "firebase-functions/v1" // Only v1 has onDelete.

initializeApp()

const db = getFirestore()
const DELETE_BATCH_SIZE = 450

async function deletePairingsForUser(
  field: "ownerUid" | "partnerUid",
  uid: string
) {
  const pairings = db
    .collection("pairing")
    .where(field, "==", uid)
    .limit(DELETE_BATCH_SIZE)

  while (true) {
    const snapshot = await pairings.get()
    if (snapshot.empty) return

    const batch = db.batch()
    snapshot.docs.forEach((pairing) => batch.delete(pairing.ref))
    await batch.commit()

    if (snapshot.size < DELETE_BATCH_SIZE) return
  }
}

async function deletePairingInvitesForUser(uid: string) {
  const invites = db
    .collection("pairingInvites")
    .where("ownerUid", "==", uid)
    .limit(DELETE_BATCH_SIZE)

  while (true) {
    const snapshot = await invites.get()
    if (snapshot.empty) return

    const batch = db.batch()
    snapshot.docs.forEach((invite) => batch.delete(invite.ref))
    await batch.commit()

    if (snapshot.size < DELETE_BATCH_SIZE) return
  }
}

export const deleteUserPairings = functions
  .runWith({ failurePolicy: true })
  .auth.user()
  .onDelete(async (user) => {
    await Promise.all([
      deletePairingsForUser("ownerUid", user.uid),
      deletePairingsForUser("partnerUid", user.uid),
      deletePairingInvitesForUser(user.uid),
      db.collection("pairingActiveInvites").doc(user.uid).delete(),
    ])
  })
