export { cn } from "cn"

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

export type LogLevel = "debug" | "info" | "warn" | "error"

export function logging(
  level: LogLevel = "info",
  message: string,
  identify: string = "",
) {
  const logMessage = `[${new Date().toISOString()}] ${level.toUpperCase()} ${identify} message='${message}'`
  console.log(logMessage)
}