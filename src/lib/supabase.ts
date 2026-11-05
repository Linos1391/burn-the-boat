import { createClient } from "@supabase/supabase-js"
import { supabaseEnv } from "./env"
import { APP_ERRORS, AppError } from "./errors"

export const supabase =
  supabaseEnv.url && supabaseEnv.anonKey
    ? createClient(supabaseEnv.url, supabaseEnv.anonKey, {
        auth: {
          autoRefreshToken: true,
          persistSession: true,
          detectSessionInUrl: true,
        },
        realtime: { params: { eventsPerSecond: 10 } },
      })
    : null

export class DbTimestamp {
  private readonly value: string

  constructor(value: string) {
    this.value = value
  }

  toMillis() {
    return new Date(this.value).getTime()
  }

  toDate() {
    return new Date(this.value)
  }
}

export function parseTimestamp(value: unknown): DbTimestamp {
  if (typeof value !== "string" || Number.isNaN(Date.parse(value))) {
    throw new AppError(APP_ERRORS.invalid_data)
  }
  return new DbTimestamp(value)
}
