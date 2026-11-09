import { db } from "./db.ts"

export async function accountHasUnresolvedBoat(userId: string) {
  return await db<boolean>("rpc/account_has_unresolved_boat", {
    method: "POST",
    body: JSON.stringify({ p_uid: userId }),
  })
}
