import { accountHasUnresolvedBoat } from "../_shared/unresolved-boats.ts"

Deno.serve(async (request: Request) => {
  const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers":
      "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
  }
  if (request.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders })
  }
  if (request.method !== "POST") {
    return new Response("Method not allowed", {
      status: 405,
      headers: corsHeaders,
    })
  }

  const authorization = request.headers.get("Authorization")
  if (!authorization?.startsWith("Bearer ")) {
    return new Response("Unauthorized", { status: 401, headers: corsHeaders })
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL")
  const serviceRoleKey = Deno.env.get("SERVICE_ROLE_KEY")
  if (!supabaseUrl || !serviceRoleKey) {
    console.error("Missing required Supabase function environment variables.")
    return new Response("Account deletion is not configured.", {
      status: 500,
      headers: corsHeaders,
    })
  }

  const headers = {
    apikey: serviceRoleKey,
    Authorization: authorization,
  }
  const userResponse = await fetch(`${supabaseUrl}/auth/v1/user`, { headers })
  if (userResponse.status === 401 || userResponse.status === 403) {
    return new Response("Unauthorized", { status: 401, headers: corsHeaders })
  }
  if (!userResponse.ok) {
    console.error(
      "Failed to verify authenticated account.",
      userResponse.status
    )
    return new Response("Unable to verify account.", {
      status: 502,
      headers: corsHeaders,
    })
  }
  const user = (await userResponse.json()) as { id?: unknown }
  if (typeof user.id !== "string") {
    console.error("Supabase Auth returned a user without an ID.")
    return new Response("Unable to verify account.", {
      status: 502,
      headers: corsHeaders,
    })
  }

  try {
    if (await accountHasUnresolvedBoat(user.id)) {
      return new Response("Resolve your active boat and pending payments before deleting your account.", {
        status: 409,
        headers: corsHeaders,
      })
    }
  } catch (error) {
    console.error("Failed to check account for unresolved boats.", error)
    return new Response("Unable to check pending payments.", {
      status: 500,
      headers: corsHeaders,
    })
  }

  const profileUrl = new URL("/rest/v1/profiles", supabaseUrl)
  profileUrl.searchParams.set("id", `eq.${user.id}`)
  profileUrl.searchParams.set("select", "avatar_path")
  const profileResponse = await fetch(profileUrl, {
    headers: {
      apikey: serviceRoleKey,
      Authorization: `Bearer ${serviceRoleKey}`,
    },
  })
  if (!profileResponse.ok) {
    console.error(
      "Failed to load account profile for avatar cleanup.",
      profileResponse.status
    )
    return new Response("Unable to delete account.", {
      status: 500,
      headers: corsHeaders,
    })
  }
  const profiles = (await profileResponse.json()) as Array<{
    avatar_path?: unknown
  }>
  const avatarPath = profiles[0]?.avatar_path
  if (typeof avatarPath === "string") {
    if (!avatarPath.startsWith(`${user.id}/`)) {
      console.error("Account profile contains an invalid avatar path.")
      return new Response("Unable to delete account.", {
        status: 500,
        headers: corsHeaders,
      })
    }

    const avatarResponse = await fetch(
      `${supabaseUrl}/storage/v1/object/burn-the-boat-avatars`,
      {
        method: "DELETE",
        headers: {
          apikey: serviceRoleKey,
          Authorization: `Bearer ${serviceRoleKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ prefixes: [avatarPath] }),
      }
    )
    if (!avatarResponse.ok) {
      console.error("Failed to remove account avatar.", avatarResponse.status)
      return new Response("Unable to delete account.", {
        status: 500,
        headers: corsHeaders,
      })
    }
  }

  const deleteResponse = await fetch(
    `${supabaseUrl}/auth/v1/admin/users/${encodeURIComponent(user.id)}`,
    {
      method: "DELETE",
      headers: {
        apikey: serviceRoleKey,
        Authorization: `Bearer ${serviceRoleKey}`,
      },
    }
  )
  if (!deleteResponse.ok) {
    console.error(
      "Failed to delete authenticated account.",
      deleteResponse.status,
      await deleteResponse.text()
    )
    return new Response("Unable to delete account.", {
      status: 500,
      headers: corsHeaders,
    })
  }
  return new Response(null, { status: 204, headers: corsHeaders })
})
