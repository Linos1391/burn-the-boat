import { accountHasUnresolvedBoat } from "../_shared/unresolved-boats.ts"

type AuthUser = {
  id: string
  is_anonymous: boolean
  created_at: string
  last_sign_in_at: string | null
}

const PAGE_SIZE = 1000
const INACTIVE_DAYS = 30
const AVATAR_BUCKET = "burn-the-boat-avatars"

function isInactiveGuest(user: AuthUser, cutoff: number) {
  if (user.is_anonymous !== true) return false
  const activityTime = Date.parse(user.last_sign_in_at ?? user.created_at)
  if (Number.isNaN(activityTime)) {
    throw new Error("Supabase Auth returned an invalid guest activity date.")
  }
  return activityTime < cutoff
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  })
}

Deno.serve(async (request: Request) => {
  if (request.method !== "POST") {
    return jsonResponse({ error: "Method not allowed." }, 405)
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL")
  const serviceRoleKey = Deno.env.get("SERVICE_ROLE_KEY")
  if (!supabaseUrl || !serviceRoleKey) {
    console.error("Missing required Supabase function environment variables.")
    return jsonResponse({ error: "Guest cleanup is not configured." }, 500)
  }
  if (request.headers.get("apikey") !== serviceRoleKey) {
    return jsonResponse({ error: "Unauthorized." }, 401)
  }

  const apiHeaders = {
    apikey: serviceRoleKey,
    Authorization: `Bearer ${serviceRoleKey}`,
  }
  const cutoff = Date.now() - INACTIVE_DAYS * 24 * 60 * 60 * 1000
  const users: AuthUser[] = []

  try {
    for (let page = 1; ; page += 1) {
      const usersUrl = new URL("/auth/v1/admin/users", supabaseUrl)
      usersUrl.searchParams.set("page", String(page))
      usersUrl.searchParams.set("per_page", String(PAGE_SIZE))
      const response = await fetch(usersUrl, { headers: apiHeaders })
      if (!response.ok) {
        throw new Error(`Unable to list Auth users (${response.status}).`)
      }

      const result = (await response.json()) as { users?: AuthUser[] }
      if (!Array.isArray(result.users)) {
        throw new Error("Supabase Auth returned an invalid user list.")
      }
      users.push(...result.users)
      if (result.users.length < PAGE_SIZE) break
    }

    const inactiveGuests = users.filter((user) => isInactiveGuest(user, cutoff))

    let deleted = 0
    let failures = 0

    for (const user of inactiveGuests) {
      try {
        const currentUserResponse = await fetch(
          `${supabaseUrl}/auth/v1/admin/users/${encodeURIComponent(user.id)}`,
          { headers: apiHeaders }
        )
        if (currentUserResponse.status === 404) continue
        if (!currentUserResponse.ok) {
          throw new Error(
            `Unable to recheck guest account (${currentUserResponse.status}).`
          )
        }
        const currentUser = (await currentUserResponse.json()) as AuthUser
        if (
          currentUser.id !== user.id ||
          !isInactiveGuest(currentUser, cutoff)
        ) {
          continue
        }
        if (await accountHasUnresolvedBoat(user.id)) continue

        const profileUrl = new URL("/rest/v1/profiles", supabaseUrl)
        profileUrl.searchParams.set("id", `eq.${user.id}`)
        profileUrl.searchParams.set("select", "avatar_path")
        const profileResponse = await fetch(profileUrl, {
          headers: apiHeaders,
        })
        if (!profileResponse.ok) {
          throw new Error(
            `Unable to load guest profile (${profileResponse.status}).`
          )
        }

        const profiles = (await profileResponse.json()) as Array<{
          avatar_path?: unknown
        }>
        const avatarPath = profiles[0]?.avatar_path
        if (typeof avatarPath === "string") {
          if (!avatarPath.startsWith(`${user.id}/`)) {
            throw new Error("Guest profile contains an invalid avatar path.")
          }
          const avatarResponse = await fetch(
            `${supabaseUrl}/storage/v1/object/${AVATAR_BUCKET}`,
            {
              method: "DELETE",
              headers: {
                ...apiHeaders,
                "Content-Type": "application/json",
              },
              body: JSON.stringify({ prefixes: [avatarPath] }),
            }
          )
          if (!avatarResponse.ok) {
            throw new Error(
              `Unable to remove guest avatar (${avatarResponse.status}).`
            )
          }
        }

        const deleteResponse = await fetch(
          `${supabaseUrl}/auth/v1/admin/users/${encodeURIComponent(user.id)}`,
          { method: "DELETE", headers: apiHeaders }
        )
        if (!deleteResponse.ok) {
          throw new Error(
            `Unable to delete guest account (${deleteResponse.status}).`
          )
        }
        deleted += 1
      } catch (error) {
        console.error("Failed to clean up an inactive guest account.", error)
        failures += 1
      }
    }

    if (failures > 0) {
      return jsonResponse(
        {
          error: "Some inactive guest accounts could not be deleted.",
          deleted,
          failed: failures,
        },
        500
      )
    }

    return jsonResponse({ deleted, checked: users.length })
  } catch (error) {
    console.error("Inactive guest cleanup failed.", error)
    return jsonResponse({ error: "Inactive guest cleanup failed." }, 500)
  }
})
