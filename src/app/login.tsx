import { useState, type FormEvent } from "react"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"

export default function LoginPage() {
  const [message, setMessage] = useState("")

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setMessage("Sign-in is not connected yet. Authentication needs to be configured.")
  }

  return (
    <main className="flex min-h-svh items-center justify-center bg-muted/40 px-6 py-12">
      <section className="w-full max-w-sm rounded-xl border bg-card p-6 text-card-foreground shadow-sm sm:p-8">
        <header className="mb-8 flex flex-col gap-2">
          <span className="flex size-10 items-center justify-center rounded-full bg-primary text-xs font-semibold text-primary-foreground">
            BTB
          </span>
          <h1 className="mt-3 text-2xl font-semibold tracking-tight">
            Welcome back
          </h1>
          <p className="text-sm text-muted-foreground">
            Sign in to continue to Burn The Boat.
          </p>
        </header>

        <form className="flex flex-col gap-5" onSubmit={handleSubmit}>
          <div className="flex flex-col gap-2">
            <label className="text-sm font-medium" htmlFor="email">
              Email
            </label>
            <Input
              autoComplete="email"
              id="email"
              name="email"
              placeholder="name@example.com"
              required
              type="email"
            />
          </div>

          <div className="flex flex-col gap-2">
            <label className="text-sm font-medium" htmlFor="password">
              Password
            </label>
            <Input
              autoComplete="current-password"
              id="password"
              name="password"
              placeholder="Enter your password"
              required
              type="password"
            />
          </div>

          <Button className="w-full" type="submit">
            Sign in
          </Button>
          {message && (
            <p aria-live="polite" className="text-sm text-muted-foreground">
              {message}
            </p>
          )}
        </form>
      </section>
    </main>
  )
}
