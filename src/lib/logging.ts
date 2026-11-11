export type LogLevel = "debug" | "info" | "warn" | "error"

interface LogEntry {
  timestamp: string
  level: LogLevel
  context: string
  message: string
  data?: unknown
}

class Logger {
  private context: string
  private isDevelopment: boolean

  constructor(context: string) {
    this.context = context
    this.isDevelopment = import.meta.env.DEV
  }

  private formatEntry(level: LogLevel, message: string, data?: unknown): LogEntry {
    return {
      timestamp: new Date().toISOString(),
      level,
      context: this.context,
      message,
      data,
    }
  }

  private log(level: LogLevel, message: string, data?: unknown): void {
    const entry = this.formatEntry(level, message, data)
    const prefix = `[${entry.timestamp}] [${level.toUpperCase()}] [${this.context}]`
    const logMessage = `${prefix} ${message}`

    // Only log in development
    if (!this.isDevelopment) return

    if (level === "error") {
      console.error(logMessage, data)
    } else if (level === "warn") {
      console.warn(logMessage, data)
    } else if (level === "debug") {
      console.debug(logMessage, data)
    } else {
      console.log(logMessage, data)
    }
  }

  debug(message: string, data?: unknown): void {
    this.log("debug", message, data)
  }

  info(message: string, data?: unknown): void {
    this.log("info", message, data)
  }

  warn(message: string, error?: unknown): void {
    this.log("warn", message, error)
  }

  error(message: string, error?: unknown): void {
    this.log("error", message, error)
  }
}

export function createLogger(context: string): Logger {
  return new Logger(context)
}

// Global error handler for uncaught exceptions
if (import.meta.env.DEV) {
  window.addEventListener("error", (event) => {
    const logger = createLogger("GLOBAL")
    logger.error("Uncaught error", event.error)
  })

  window.addEventListener("unhandledrejection", (event) => {
    const logger = createLogger("GLOBAL")
    logger.error("Unhandled promise rejection", event.reason)
  })
}
