import { useEffect, useState, type SubmitEvent } from "react"
import { Link, useNavigate } from "react-router-dom"
import type { SupabaseClient } from "@supabase/supabase-js"
import { mapAuthUser, meetsPasswordRequirements } from "@/lib/auth"
import { getErrorMessage } from "@/lib/errors"
import { ArrowRight, UserRound } from "lucide-react"
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Button } from "@/components/ui/button"
import { Separator } from "@/components/ui/separator"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog"
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar"

type LoginPageProps = {
  supabase: SupabaseClient | null
}

type Feedback = {
  kind: "error" | "success"
  message: string
}

export default function LoginPage({ supabase }: LoginPageProps) {
  const navigate = useNavigate()
  const [mode, setMode] = useState<"login" | "signup" | "recovery">(() =>
    new URLSearchParams(window.location.search).get("type") === "recovery"
      ? "recovery"
      : "login"
  )
  const [email, setEmail] = useState("")
  const [password, setPassword] = useState("")
  const [confirmPassword, setConfirmPassword] = useState("")
  const [feedback, setFeedback] = useState<Feedback | null>(null)
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [providerAction, setProviderAction] = useState<
    "google" | "anonymous" | null
  >(null)

  useEffect(() => {
    if (!supabase || mode === "recovery") return
    let active = true
    void supabase.auth.getSession().then(({ data, error }) => {
      if (error) {
        setFeedback({ kind: "error", message: getErrorMessage(error) })
        return
      }
      if (!active || !data.session) return
      const user = mapAuthUser(data.session.user)
      navigate(
        user && user.providerId === "email" && !user.emailVerified
          ? "/verify-email"
          : "/home",
        { replace: true }
      )
    })
    return () => {
      active = false
    }
  }, [supabase, navigate, mode])

  function changeMode(nextMode: "login" | "signup" | "recovery") {
    setMode(nextMode)
    setFeedback(null)
    setPassword("")
    setConfirmPassword("")
  }

  async function handleSubmit(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault()
    setFeedback(null)

    if (!supabase) return
    if (mode !== "login" && password !== confirmPassword) {
      setFeedback({ kind: "error", message: "Your passwords don't match." })
      return
    }
    if (mode !== "login" && !meetsPasswordRequirements(password)) {
      setFeedback({
        kind: "error",
        message:
          "Your password must include an uppercase letter, a lowercase letter, a number, and a special character.",
      })
      return
    }

    setIsSubmitting(true)
    try {
      if (mode === "recovery") {
        const { error } = await supabase.auth.updateUser({ password })
        if (error) throw error
        setMode("login")
        setPassword("")
        setConfirmPassword("")
        setFeedback({ kind: "success", message: "Your password was updated." })
        navigate("/home", { replace: true })
      } else if (mode === "signup") {
        const { data, error } = await supabase.auth.signUp({
          email: email.trim(),
          password,
          options: {
            emailRedirectTo: `${window.location.origin}/verify-email`,
            data: {
              display_name: email.trim(),
            },
          },
        })
        if (error) throw error
        // An already-registered email comes back with no identities.
        if (data.user && data.user.identities?.length === 0) {
          setFeedback({
            kind: "error",
            message: "This email is already registered. Sign in instead.",
          })
          return
        }
        navigate("/verify-email", {
          replace: true,
          state: { email: email.trim() },
        })
      } else {
        const { data, error } = await supabase.auth.signInWithPassword({
          email: email.trim(),
          password,
        })
        if (error) throw error
        const user = mapAuthUser(data.user)
        navigate(
          user &&
            !user.isAnonymous &&
            user.providerId === "email" &&
            !user.emailVerified
            ? "/verify-email"
            : "/home",
          { replace: true }
        )
      }
    } catch (error) {
      setFeedback({ kind: "error", message: getErrorMessage(error) })
    } finally {
      setIsSubmitting(false)
    }
  }

  async function handlePasswordReset() {
    setFeedback(null)
    if (!supabase) return
    if (!email.trim()) {
      setFeedback({
        kind: "error",
        message: "Enter your email address first, then request a reset link.",
      })
      return
    }

    setIsSubmitting(true)
    try {
      const { error } = await supabase.auth.resetPasswordForEmail(
        email.trim(),
        { redirectTo: `${window.location.origin}/login?type=recovery` }
      )
      if (error) throw error
      setFeedback({
        kind: "success",
        message:
          "If an account exists for that email, a reset link is on its way.",
      })
    } catch (error) {
      setFeedback({ kind: "error", message: getErrorMessage(error) })
    } finally {
      setIsSubmitting(false)
    }
  }

  async function handleProviderSignIn(provider: "google" | "anonymous") {
    setFeedback(null)
    if (!supabase) return

    setProviderAction(provider)
    try {
      if (provider === "google") {
        const { error } = await supabase.auth.signInWithOAuth({
          provider: "google",
          options: { redirectTo: `${window.location.origin}/home` },
        })
        if (error) throw error
      } else {
        const { error } = await supabase.auth.signInAnonymously()
        if (error) throw error
      }
      if (provider === "anonymous") navigate("/home", { replace: true })
    } catch (error) {
      setFeedback({ kind: "error", message: getErrorMessage(error) })
    } finally {
      setProviderAction(null)
    }
  }

  const isBusy = isSubmitting || providerAction !== null

  return (
    <main className="relative flex min-h-svh items-center justify-center overflow-hidden bg-muted/50 px-4 py-10">
      <Card className="relative w-full max-w-md gap-0 overflow-hidden rounded-2xl border-0 bg-card py-0 shadow-xl ring-1 shadow-foreground/5 ring-foreground/10">
        <CardHeader className="gap-6 px-6 pt-7 pb-6 sm:px-8 sm:pt-8">
          <Link
            to="/"
            className="flex w-fit items-center gap-3 rounded-2xl transition-opacity outline-none hover:opacity-80 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
          >
            <Avatar className="size-12 rounded-2xl border border-border/70 bg-background p-2 shadow-sm ring-1 ring-border/30 after:rounded-2xl">
              <AvatarImage
                src="/icon.svg"
                className="rounded-xl object-contain"
              />
              <AvatarFallback className="rounded-xl text-xs font-semibold">
                BTB
              </AvatarFallback>
            </Avatar>

            <span className="text-xl font-bold tracking-tight">
              Burn the Boat
            </span>
          </Link>
          <div className="flex flex-col gap-2">
            <CardTitle className="text-3xl font-semibold tracking-tight">
              {mode === "login"
                ? "Welcome back"
                : mode === "signup"
                  ? "Start your journey"
                  : "Choose a new password"}
            </CardTitle>
            <CardDescription className="text-sm leading-relaxed">
              {mode === "login"
                ? "Sign in to pick up where you left off."
                : mode === "signup"
                  ? "Create an account and make your next move."
                  : "Set a new password for your account."}
            </CardDescription>
          </div>
        </CardHeader>

        <CardContent className="px-6 pb-6 sm:px-8">
          <form onSubmit={handleSubmit} className="flex flex-col gap-5">
            <FieldGroup className="gap-4">
              {mode !== "recovery" && (
                <Field>
                  <FieldLabel htmlFor="email">Email address</FieldLabel>
                  <Input
                    autoComplete="email"
                    id="email"
                    name="email"
                    type="email"
                    placeholder="you@example.com"
                    className="h-11 rounded-xl bg-background"
                    value={email}
                    onChange={(event) => setEmail(event.target.value)}
                    required
                  />
                </Field>
              )}

              <Field>
                <div className="flex items-center justify-between gap-4">
                  <FieldLabel htmlFor="password">Password</FieldLabel>
                  {mode === "login" && (
                    <Button
                      type="button"
                      variant="link"
                      className="h-auto p-0 text-xs"
                      onClick={handlePasswordReset}
                      disabled={isBusy || !supabase}
                    >
                      Forgot password?
                    </Button>
                  )}
                </div>
                <Input
                  autoComplete={
                    mode === "login" ? "current-password" : "new-password"
                  }
                  id="password"
                  name="password"
                  type="password"
                  placeholder={"Enter a minimum 6 digits password"}
                  className="h-11 rounded-xl bg-background"
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  minLength={6}
                  required
                />
                {mode !== "login" && (
                  <ul className="mt-2 grid grid-cols-2 gap-x-2 gap-y-1 text-xs text-muted-foreground">
                    <li>An uppercase letter</li>
                    <li>A lowercase letter</li>
                    <li>A number</li>
                    <li>A special character</li>
                  </ul>
                )}
              </Field>

              {mode !== "login" && (
                <Field>
                  <FieldLabel htmlFor="confirm-password">
                    Confirm password
                  </FieldLabel>
                  <Input
                    autoComplete="new-password"
                    id="confirm-password"
                    name="confirm-password"
                    type="password"
                    placeholder="Enter your password again"
                    className="h-11 rounded-xl bg-background"
                    value={confirmPassword}
                    onChange={(event) => setConfirmPassword(event.target.value)}
                    minLength={6}
                    required
                  />
                </Field>
              )}
            </FieldGroup>

            {feedback && (
              <p
                aria-live="polite"
                className={
                  feedback.kind === "error"
                    ? "text-sm text-destructive"
                    : "text-sm text-muted-foreground"
                }
                role={feedback.kind === "error" ? "alert" : "status"}
              >
                {feedback.message}
              </p>
            )}

            <Button
              className="h-11 w-full rounded-xl"
              type="submit"
              disabled={isBusy || !supabase}
            >
              {isSubmitting
                ? "Please wait..."
                : mode === "login"
                  ? "Sign in"
                  : mode === "signup"
                    ? "Create account"
                    : "Update password"}
              {!isSubmitting && (
                <ArrowRight data-icon="inline-end" aria-hidden="true" />
              )}
            </Button>
          </form>

          <div className="mt-6 flex items-center gap-3">
            <Separator className="flex-1" />
            <span className="text-xs text-muted-foreground">
              or continue with
            </span>
            <Separator className="flex-1" />
          </div>

          <div className="mt-4 flex flex-col gap-3">
            <Button
              type="button"
              variant="outline"
              className="h-11 w-full rounded-xl"
              onClick={() => handleProviderSignIn("google")}
              disabled={isBusy || !supabase}
            >
              <svg
                aria-hidden="true"
                data-icon="inline-start"
                viewBox="0 0 48 48"
                fill="none"
              >
                <path
                  fill="#4285F4"
                  d="M43.6 24.5c0-1.4-.1-2.8-.4-4.1H24v7.8h11a9.4 9.4 0 0 1-4.1 6.2v5.1h6.6c3.9-3.6 6.1-8.9 6.1-15Z"
                />
                <path
                  fill="#34A853"
                  d="M24 44c5.5 0 10.1-1.8 13.5-4.9l-6.6-5.1c-1.8 1.2-4.1 2-6.9 2-5.3 0-9.8-3.6-11.4-8.4H5.8v5.3A20 20 0 0 0 24 44Z"
                />
                <path
                  fill="#FBBC05"
                  d="M12.6 27.6a12 12 0 0 1 0-7.2v-5.3H5.8a20 20 0 0 0 0 17.8l6.8-5.3Z"
                />
                <path
                  fill="#EA4335"
                  d="M24 12c3 0 5.7 1 7.8 3.1l5.9-5.9A19.7 19.7 0 0 0 24 4 20 20 0 0 0 5.8 15.1l6.8 5.3C14.2 15.6 18.7 12 24 12Z"
                />
              </svg>
              {providerAction === "google"
                ? "Connecting to Google..."
                : "Continue with Google"}
            </Button>

            <AlertDialog>
              <AlertDialogTrigger
                render={
                  <Button
                    type="button"
                    variant="outline"
                    className="h-11 w-full rounded-xl"
                    disabled={isBusy || !supabase}
                  >
                    <UserRound aria-hidden="true" data-icon="inline-start" />
                    {providerAction === "anonymous"
                      ? "Creating guest account..."
                      : "Continue as guest"}
                  </Button>
                }
              />

              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>Creating a Guest account</AlertDialogTitle>
                  <AlertDialogDescription>
                    This only gives you a trial test on our app. The account
                    WILL BE DELETED either when the session is finished or after
                    30 days timeout.
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter className="flex-row items-center justify-center">
                  <AlertDialogAction
                    className="min-w-0 flex-1"
                    onClick={() => handleProviderSignIn("anonymous")}
                  >
                    I Understand
                  </AlertDialogAction>
                  <AlertDialogCancel className="min-w-0 flex-1">
                    Cancel
                  </AlertDialogCancel>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          </div>

          {!supabase && (
            <p
              className="mt-5 rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive"
              role="alert"
            >
              Please contact the IT Support immediately: Supabase isn&apos;t
              configured yet.
            </p>
          )}
        </CardContent>

        <CardFooter className="flex-col justify-center gap-3 border-t px-6 py-5 sm:px-8">
          <p className="text-center text-xs text-muted-foreground">
            By continuing, you agree that we store your email address to run
            your account. See our{" "}
            <a
              href="https://github.com/Linos1391/burn-the-boat/blob/master/PRIVACY.md"
              target="_blank"
              rel="noopener noreferrer"
              className="underline"
            >
              Privacy Notice
            </a>
            .
          </p>
          <p className="text-center text-sm text-muted-foreground">
            {mode === "signup"
              ? "Already have an account?"
              : "New to Burn the Boat?"}{" "}
            <Button
              type="button"
              variant="link"
              className="h-auto p-0 font-medium text-foreground"
              onClick={() => changeMode(mode === "login" ? "signup" : "login")}
            >
              {mode === "login" ? "Create an account" : "Sign in"}
            </Button>
          </p>
        </CardFooter>
      </Card>
    </main>
  )
}
