"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.deleteUserPairings = void 0;
const app_1 = require("firebase-admin/app");
const firestore_1 = require("firebase-admin/firestore");
const functions = __importStar(require("firebase-functions/v1")); // Only v1 has onDelete.
(0, app_1.initializeApp)();
const db = (0, firestore_1.getFirestore)();
const DELETE_BATCH_SIZE = 450;
async function deletePairingsForUser(field, uid) {
    const pairings = db
        .collection("pairing")
        .where(field, "==", uid)
        .limit(DELETE_BATCH_SIZE);
    while (true) {
        const snapshot = await pairings.get();
        if (snapshot.empty)
            return;
        const batch = db.batch();
        snapshot.docs.forEach((pairing) => batch.delete(pairing.ref));
        await batch.commit();
        if (snapshot.size < DELETE_BATCH_SIZE)
            return;
    }
}
async function deletePairingInvitesForUser(uid) {
    const invites = db
        .collection("pairingInvites")
        .where("ownerUid", "==", uid)
        .limit(DELETE_BATCH_SIZE);
    while (true) {
        const snapshot = await invites.get();
        if (snapshot.empty)
            return;
        const batch = db.batch();
        snapshot.docs.forEach((invite) => batch.delete(invite.ref));
        await batch.commit();
        if (snapshot.size < DELETE_BATCH_SIZE)
            return;
    }
}
exports.deleteUserPairings = functions
    .runWith({ failurePolicy: true })
    .auth.user()
    .onDelete(async (user) => {
    await Promise.all([
        deletePairingsForUser("ownerUid", user.uid),
        deletePairingsForUser("partnerUid", user.uid),
        deletePairingInvitesForUser(user.uid),
        db.collection("pairingActiveInvites").doc(user.uid).delete(),
    ]);
});
//# sourceMappingURL=index.js.map