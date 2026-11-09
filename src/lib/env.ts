export const supabaseEnv = {
  url: import.meta.env.VITE_SUPABASE_URL,
  anonKey: import.meta.env.VITE_SUPABASE_ANON_KEY,
}

export const paypalEnv = {
  clientId: import.meta.env.VITE_PAYPAL_CLIENT_ID as string | undefined,
}
