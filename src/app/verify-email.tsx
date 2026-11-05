import { useEffect, useState } from "react"
import { Navigate, useLocation, useNavigate } from "react-router-dom"
import type { SupabaseClient } from "@supabase/supabase-js"
import { mapAuthUser, type User } from "@/lib/auth"
import { getErrorMessage } from "@/lib/errors"
import { MailCheck } from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { Skeleton } from "@/components/ui/skeleton"

type VerifyEmailPageProps = {
  supabase: SupabaseClient | null
}

type Feedback = {
  kind: "error" | "success"
  message: string
}

export default function VerifyEmailPage({ supabase }: VerifyEmailPageProps) {
  const navigate = useNavigate()
  const location = useLocation()
  const signupEmail =
    typeof location.state === "object" &&
    location.state !== null &&
    "email" in location.state &&
    typeof location.state.email === "string"
      ? location.state.email
      : ""
  const [user, setUser] = useState<User | null>(null)
  const [isLoading, setIsLoading] = useState(Boolean(supabase))
  const [isBusy, setIsBusy] = useState(false)
  const [feedback, setFeedback] = useState<Feedback | null>(null)

  useEffect(() => {
    if (!supabase) {
      return
    }
    let active = true
    void supabase.auth.getSession().then(({ data, error }) => {
      if (!active) return
      if (error) setFeedback({ kind: "error", message: getErrorMessage(error) })
      const currentUser = mapAuthUser(data.session?.user ?? null)
      setUser(currentUser)
      setIsLoading(false)
      if (
        currentUser &&
        (currentUser.providerId !== "email" || currentUser.emailVerified)
      ) {
        navigate("/home", { replace: true })
      }
    })
    // Continue automatically when the link is opened (same or another tab).
    const { data: listener } = supabase.auth.onAuthStateChange(
      (_event, session) => {
        const nextUser = mapAuthUser(session?.user ?? null)
        if (nextUser?.emailVerified) navigate("/home", { replace: true })
      }
    )
    return () => {
      active = false
      listener.subscription.unsubscribe()
    }
  }, [supabase, navigate])

  async function handleResend() {
    setFeedback(null)
    const email = user?.email ?? signupEmail
    if (!email || !supabase) return

    setIsBusy(true)
    try {
      const { error } = await supabase.auth.resend({
        type: "signup",
        email,
        options: { emailRedirectTo: `${window.location.origin}/verify-email` },
      })
      if (error) throw error
      setFeedback({
        kind: "success",
        message: "Verification email sent. Check your inbox and spam folder.",
      })
    } catch (error) {
      setFeedback({ kind: "error", message: getErrorMessage(error) })
    } finally {
      setIsBusy(false)
    }
  }

  async function handleCheckVerification() {
    setFeedback(null)
    if (!supabase) return

    setIsBusy(true)
    try {
      const { data: sessionData, error: sessionError } =
        await supabase.auth.getSession()
      if (sessionError) throw sessionError
      // The cached session can be stale; refresh to pick up email_confirmed_at.
      const refreshed = sessionData.session
        ? await supabase.auth.refreshSession()
        : null
      if (refreshed?.error) throw refreshed.error
      const currentUser = mapAuthUser(
        refreshed?.data.session?.user ?? sessionData.session?.user ?? null
      )
      setUser(currentUser)
      if (currentUser?.emailVerified) {
        navigate("/home", { replace: true })
      } else if (!currentUser) {
        // Verified in another browser: there is no session here, so sign in.
        navigate("/login", { replace: true })
      } else {
        setFeedback({
          kind: "error",
          message:
            "Your email isn't verified yet. Open the link in your email, then try again.",
        })
      }
    } catch (error) {
      setFeedback({ kind: "error", message: getErrorMessage(error) })
    } finally {
      setIsBusy(false)
    }
  }

  async function handleUseAnotherAccount() {
    if (!supabase) return

    setIsBusy(true)
    try {
      const { error } = await supabase.auth.signOut()
      if (error) throw error
      navigate("/login", { replace: true })
    } catch (error) {
      setFeedback({ kind: "error", message: getErrorMessage(error) })
      setIsBusy(false)
    }
  }

  if (isLoading) {
    return (
      <main
        className="flex min-h-svh items-center justify-center"
        role="status"
        aria-label="Checking sign-in status"
      >
        <Skeleton className="h-8 w-40" />
      </main>
    )
  }

  if (!supabase || (!user && !signupEmail)) {
    return <Navigate to="/login" replace />
  }

  return (
    <main className="flex min-h-svh items-center justify-center bg-muted/50 px-4 py-10">
      <Card className="w-full max-w-md gap-0 rounded-2xl border-0 py-0 shadow-xl ring-1 shadow-foreground/5 ring-foreground/10">
        <CardHeader className="gap-4 px-6 pt-7 pb-5 sm:px-8 sm:pt-8">
          <span className="flex size-12 items-center justify-center rounded-xl bg-primary/10 text-primary">
            <MailCheck aria-hidden="true" />
          </span>
          <div className="flex flex-col gap-2">
            <CardTitle className="text-2xl font-semibold tracking-tight">
              Verify your email
            </CardTitle>
            <CardDescription className="leading-relaxed">
              To continue, verify this email address:{" "}
              {
                <span className="font-medium text-foreground">
                  {user?.email ?? signupEmail}
                </span>
              }
              . Open the link from your inbox, then come back here. If you
              don&apos;t see it, check your spam folder or request another.
            </CardDescription>
          </div>
        </CardHeader>
        <CardContent className="flex flex-col gap-3 px-6 pb-6 sm:px-8">
          {feedback && (
            <p
              className={
                feedback.kind === "error"
                  ? "text-sm text-destructive"
                  : "text-sm text-muted-foreground"
              }
              role={feedback.kind === "error" ? "alert" : "status"}
              aria-live="polite"
            >
              {feedback.message}
            </p>
          )}
          <Button
            className="h-11 w-full rounded-xl"
            onClick={handleCheckVerification}
            disabled={isBusy || (!user && !signupEmail)}
          >
            {isBusy ? "Please wait..." : "I've verified my email"}
          </Button>
          <Button
            variant="outline"
            className="h-11 w-full rounded-xl"
            onClick={handleResend}
            disabled={isBusy || (!user && !signupEmail)}
          >
            Resend verification email
          </Button>
          <Button
            variant="link"
            className="h-auto self-center"
            onClick={handleUseAnotherAccount}
            disabled={isBusy || !supabase}
          >
            Use another account
          </Button>
        </CardContent>
      </Card>
    </main>
  )
}
