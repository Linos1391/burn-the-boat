import { db, hasServiceConfig } from "../_shared/db.ts"

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
}
const models = new Set([
  "gemini-3.6-flash",
  "gemini-3.8-flash",
  "gemini-3.5-flash-lite",
  "gemini-3.1-flash-lite",
  "gemini-2.5-flash",
])
const maxBytes = 6 * 1024 * 1024
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, "Content-Type": "application/json" },
  })

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

Deno.serve(async (request: Request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: cors })
  if (request.method !== "POST") return json({ error: "Method not allowed." }, 405)
  const key = Deno.env.get("GEMINI_API_KEY")
  const url = Deno.env.get("SUPABASE_URL")
  const authorization = request.headers.get("authorization")
  if (!key || !url || !hasServiceConfig()) return json({ error: "AI is not configured." }, 500)
  if (!authorization?.startsWith("Bearer ")) return json({ error: "Sign in required." }, 401)

  try {
    const userResponse = await fetch(`${url}/auth/v1/user`, {
      headers: { Authorization: authorization, apikey: Deno.env.get("SERVICE_ROLE_KEY")! },
    })
    if (userResponse.status === 401 || userResponse.status === 403) {
      return json({ error: "Sign in required." }, 401)
    }
    if (!userResponse.ok) throw new Error("Unable to verify AI caller.")
    const user: unknown = await userResponse.json()
    if (!isRecord(user) || typeof user.id !== "string") throw new Error("Invalid authenticated user.")

    const length = Number(request.headers.get("content-length") ?? 0)
    if (length > maxBytes) return json({ error: "AI request is too large." }, 413)
    if (!request.body) return json({ error: "Invalid request." }, 400)
    const reader = request.body.getReader()
    const chunks: Uint8Array[] = []
    let total = 0
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.length
      if (total > maxBytes) {
        await reader.cancel()
        return json({ error: "AI request is too large." }, 413)
      }
      chunks.push(value)
    }
    const bytes = new Uint8Array(total)
    let offset = 0
    for (const chunk of chunks) {
      bytes.set(chunk, offset)
      offset += chunk.length
    }
    const raw = new TextDecoder().decode(bytes)
    let body: unknown
    try {
      body = JSON.parse(raw)
    } catch {
      return json({ error: "Invalid request." }, 400)
    }
    if (
      !isRecord(body) || typeof body.model !== "string" || !models.has(body.model) ||
      typeof body.systemInstruction !== "string" || body.systemInstruction.length > 20000 ||
      !Array.isArray(body.contents) || body.contents.length === 0 || body.contents.length > 25 ||
      (body.responseMimeType !== undefined && body.responseMimeType !== "application/json") ||
      (body.tools !== undefined && !Array.isArray(body.tools))
    ) return json({ error: "Invalid AI request." }, 400)
    for (const content of body.contents) {
      if (!isRecord(content) || !Array.isArray(content.parts) ||
        (content.role !== "user" && content.role !== "model")) {
        return json({ error: "Invalid AI content." }, 400)
      }
      for (const part of content.parts) {
        if (!isRecord(part) || !(
          (typeof part.text === "string" && Object.keys(part).length === 1) ||
          (isRecord(part.inlineData) && Object.keys(part).length === 1 &&
            typeof part.inlineData.mimeType === "string" &&
            typeof part.inlineData.data === "string" &&
            Object.keys(part.inlineData).every((key) => key === "mimeType" || key === "data"))
        )) return json({ error: "Invalid AI attachment." }, 400)
      }
    }

    const allowed = await db<boolean>("rpc/consume_ai_request", {
      method: "POST",
      body: JSON.stringify({ p_user_id: user.id }),
    })
    if (!allowed) return json({ error: "AI request limit reached." }, 429)

    const upstream = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${body.model}:generateContent`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": key },
        body: JSON.stringify({
          contents: body.contents,
          systemInstruction: { parts: [{ text: body.systemInstruction }] },
          generationConfig: {
            maxOutputTokens: 4096,
            ...(body.responseMimeType ? { responseMimeType: body.responseMimeType } : {}),
          },
          ...(body.tools ? { tools: body.tools } : {}),
        }),
      }
    )
    if (!upstream.ok) {
      console.error("Gemini request failed.", upstream.status)
      return json({ error: "AI request failed." }, upstream.status === 429 ? 503 : 502)
    }
    const result = await upstream.json()
    const parts = result.candidates?.[0]?.content?.parts
    if (!Array.isArray(parts)) return json({ error: "AI returned no response." }, 502)
    return json({
      text: parts.filter((part) => typeof part.text === "string" && part.thought !== true).map((part) => part.text).join(""),
      functionCalls: parts.filter((part) => isRecord(part.functionCall)).map((part) => part.functionCall),
    })
  } catch (error) {
    console.error("AI function failed.", error)
    return json({ error: "Unable to process AI request." }, 500)
  }
})
