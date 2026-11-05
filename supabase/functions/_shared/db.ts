const url = () => Deno.env.get("SUPABASE_URL")!
const key = () => Deno.env.get("SERVICE_ROLE_KEY")!

export function hasServiceConfig() {
  return Boolean(
    Deno.env.get("SUPABASE_URL") && Deno.env.get("SERVICE_ROLE_KEY")
  )
}

export async function db<T = any>(
  path: string,
  init: RequestInit & { prefer?: string } = {}
): Promise<T> {
  const { prefer, ...rest } = init
  const response = await fetch(`${url()}/rest/v1/${path}`, {
    ...rest,
    headers: {
      apikey: key(),
      Authorization: `Bearer ${key()}`,
      "Content-Type": "application/json",
      Prefer: prefer ?? "return=representation",
      ...(rest.headers ?? {}),
    },
  })
  if (!response.ok)
    throw new Error(`Database request failed (${response.status}).`)
  const text = await response.text()
  return (text ? JSON.parse(text) : null) as T
}

export const patch = (
  table: string,
  filter: string,
  values: Record<string, unknown>
) =>
  db(`${table}?${filter}`, {
    method: "PATCH",
    body: JSON.stringify({ ...values, updated_at: new Date().toISOString() }),
  })
