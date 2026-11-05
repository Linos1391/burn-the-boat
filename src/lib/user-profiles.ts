import type { SupabaseClient } from "@supabase/supabase-js"

export const avatarBucket = "burn-the-boat-avatars"

export const profileUpdatedEvent = "profile-updated"

export function getProfileAvatarUrl(
  supabase: SupabaseClient,
  path: string | null
) {
  return path
    ? supabase.storage.from(avatarBucket).getPublicUrl(path).data.publicUrl
    : undefined
}

export async function fetchProfileDisplayNames(
  supabase: SupabaseClient,
  uids: string[]
): Promise<Record<string, string>> {
  const uniqueUids = [...new Set(uids)]
  if (uniqueUids.length === 0) return {}

  const { data, error } = await supabase
    .from("profiles")
    .select("id, display_name")
    .in("id", uniqueUids)
  if (error) throw error
  return Object.fromEntries(
    data.map((profile) => [profile.id, profile.display_name])
  )
}

export function getProfileDisplayName(
  uid: string,
  displayNames: Record<string, string>
) {
  const profileDisplayName = displayNames[uid]?.trim()
  return profileDisplayName || `User ${uid}`
}
