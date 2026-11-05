import type { User as SupabaseUser } from "@supabase/supabase-js"

export function meetsPasswordRequirements(password: string) {
  return (
    password.length >= 8 &&
    /[A-Z]/.test(password) &&
    /[a-z]/.test(password) &&
    /\d/.test(password) &&
    /[^A-Za-z0-9]/.test(password)
  )
}

export type User = {
  uid: string
  email: string | null
  emailVerified: boolean
  isAnonymous: boolean
  providerId: string
}

export function mapAuthUser(user: SupabaseUser | null): User | null {
  if (!user) return null
  const providerId = user.is_anonymous
    ? "anonymous"
    : (user.app_metadata.provider ??
      user.identities?.[0]?.provider ??
      (user.email ? "email" : "unknown"))
  return {
    uid: user.id,
    email: user.email ?? null,
    emailVerified: Boolean(user.email_confirmed_at),
    isAnonymous: user.is_anonymous ?? false,
    providerId,
  }
}
