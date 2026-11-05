import { logging } from "./utils"

export const APP_ERRORS = {
  ai_busy: "Gemini is temporarily busy. Please try again in a moment.",
  ai_empty_response: "The AI returned an empty response. Please try again.",
  ai_file_failed: "The AI could not process that file. Try a different one.",
  ai_file_pending:
    "The AI is still processing that file. Please try again shortly.",
  ai_inferno_locked: "Inferno plans are permanent and cannot be changed.",
  ai_invalid_response:
    "The AI returned an unusable response. Please try again.",
  ai_match: "Unable to get an AI recommendation. Please try again.",
  ai_no_match: "The AI could not recommend a matching plan.",
  ai_no_plan: "Create a plan before asking AI for a match.",
  avatar_cleanup:
    "Your avatar changed, but the old image could not be removed.",
  avatar_save: "Unable to save your avatar. Please try again.",
  bet_authorize: "Unable to authorize your bet. Please try again.",
  chat_send: "Unable to send your message. Please try again.",
  delete_account: "Unable to delete your account. Please try again.",
  denied: "You are not allowed to do that. Please sign in again.",
  email_save: "Unable to save your PayPal email. Please try again.",
  generic: "Something went wrong. Please try again.",
  history_load: "Unable to load your transaction history. Please try again.",
  invalid_data: "Some saved data is invalid. Please refresh and try again.",
  network: "Unable to reach the server. Check your connection and try again.",
  pairing_active:
    "You already have an active invite. Wait for it to be paired or expire before creating another.",
  pairing_cannot_create: "Unable to create a unique code. Please try again.",
  pairing_cannot_pair: "Unable to pair the code. Please try again.",
  pairing_cannot_remove: "Unable to remove the code. Please try again.",
  pairing_invalid: "The pairing invite is invalid. Please create a new one.",
  paypal_order: "Unable to start the PayPal payment. Please try again.",
  paypal_step: "Unable to complete the PayPal step. Please try again.",
  plan_submit: "Unable to submit your plan. Please try again.",
  profile_load: "Unable to load your profile. Please try again.",
  rate_limited: "Too many attempts. Please wait a little and try again.",
  realtime: "Unable to get live updates. Check your connection.",
  request_cancel: "Unable to cancel this request. Please try again.",
  request_send: "Unable to send your request. Please try again.",
  request_update: "Unable to update this request. Please try again.",
  sign_out: "Unable to sign out. Please try again.",
} as const

// Base class for errors whose message is written for users; everything else is hidden.
export class AppError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message, { cause })
    this.name = "AppError"
  }
}

export function getErrorCode(error: unknown) {
  return typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string"
    ? error.code
    : null
}

const CODE_ERRORS: Record<string, string> = {
  "42501": APP_ERRORS.denied,
  PGRST301: APP_ERRORS.denied,
  "08000": APP_ERRORS.network,
  "08003": APP_ERRORS.network,
  "08006": APP_ERRORS.network,
  PGRST000: APP_ERRORS.network,
  over_request_rate_limit: APP_ERRORS.rate_limited,
}

export const AUTH_ERRORS: Record<string, string> = {
  user_already_exists:
    "An account already exists for this email. Try signing in instead.",
  invalid_email: "Enter a valid email address.",
  invalid_credentials: "That email and password combination wasn't recognized.",
  weak_password: "Choose a stronger password.",
  email_not_confirmed: "Verify your email address before signing in.",
}

// Only app-authored messages (AppError or a plain Error) reach the user. Errors from
// Supabase, Gemini or the browser can expose internals, so they are logged and generalized.
export function getErrorMessage(
  error: unknown,
  fallback: string = APP_ERRORS.generic
): string {
  const code = getErrorCode(error)
  if (code && (AUTH_ERRORS[code] ?? CODE_ERRORS[code])) {
    return AUTH_ERRORS[code] ?? CODE_ERRORS[code]
  }
  if (error instanceof AppError) {
    if (error.message === APP_ERRORS.generic && error.cause) {
      return getErrorMessage(error.cause, fallback)
    }
    return error.message
  }
  if (error instanceof Error && error.constructor === Error) {
    return error.message
  }
  const detail =
    typeof error === "object" && error !== null && "message" in error
      ? String(error.message)
      : String(error)
  logging("error", "Hidden error.", `detail=${detail}`)
  return fallback
}
