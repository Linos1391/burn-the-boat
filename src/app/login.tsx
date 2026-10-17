import { useEffect, useState, type SubmitEvent } from "react"
import { Link, useNavigate } from "react-router-dom"
import {
  createUserWithEmailAndPassword,
  GoogleAuthProvider,
  getAuth,
  onAuthStateChanged,
  sendPasswordResetEmail,
  sendEmailVerification,
  signInAnonymously,
  signInWithEmailAndPassword,
  signInWithPopup,
  type Auth,
} from "firebase/auth"
import type { FirebaseApp } from "firebase/app"
import { ArrowRight, Flame, UserRound } from "lucide-react"
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

type LoginPageProps = {
  firebaseApp: FirebaseApp | null
}

type Feedback = {
  kind: "error" | "success"
  message: string
}

function meetsPasswordRequirements(password: string) {
  return (
    /[A-Z]/.test(password) &&
    /[a-z]/.test(password) &&
    /\d/.test(password) &&
    /[^A-Za-z0-9]/.test(password)
  )
}

function getAuthErrorMessage(error: unknown) {
  if (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    "message" in error &&
    typeof error.code === "string" &&
    typeof error.message === "string"
  ) {
    switch (error.code) {
      case "auth/email-already-in-use":
        return "An account already exists for this email. Try signing in instead."
      case "auth/invalid-email":
        return "Enter a valid email address."
      case "auth/invalid-credential":
      case "auth/user-not-found":
      case "auth/wrong-password":
        return "That email and password combination wasn't recognized."
      case "auth/weak-password":
        return "Choose a stronger password."
      case "auth/too-many-requests":
        return "Too many attempts. Please wait a little and try again."
      case "auth/network-request-failed":
        return "Couldn't connect to Firebase. Check your connection and try again."
      case "auth/operation-not-allowed":
        return "This sign-in method isn't enabled for this Firebase project."
      case "auth/unauthorized-domain":
        return "This domain isn't authorized for sign-in. Add it in Firebase Authentication settings."
      default:
        return error.message
    }
  }

  return error instanceof Error
    ? error.message
    : "Something went wrong. Please try again."
}

export default function LoginPage({ firebaseApp }: LoginPageProps) {
  const navigate = useNavigate()
  const [mode, setMode] = useState<"login" | "signup">("login")
  const [email, setEmail] = useState("")
  const [password, setPassword] = useState("")
  const [confirmPassword, setConfirmPassword] = useState("")
  const [feedback, setFeedback] = useState<Feedback | null>(null)
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [providerAction, setProviderAction] = useState<
    "google" | "anonymous" | null
  >(null)

  const auth: Auth | null = firebaseApp ? getAuth(firebaseApp) : null

  useEffect(() => {
    if (!auth) return

    return onAuthStateChanged(auth, (user) => {
      if (user) {
        const needsVerification =
          user.providerData.some(
            (provider) => provider.providerId === "password"
          ) && !user.emailVerified
        navigate(needsVerification ? "/verify-email" : "/home", {
          replace: true,
        })
      }
    })
  }, [auth, navigate])

  function changeMode(nextMode: "login" | "signup") {
    setMode(nextMode)
    setFeedback(null)
    setPassword("")
    setConfirmPassword("")
  }

  async function handleSubmit(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault()
    setFeedback(null)

    if (!auth) return
    if (mode === "signup" && password !== confirmPassword) {
      setFeedback({ kind: "error", message: "Your passwords don't match." })
      return
    }
    if (mode === "signup" && !meetsPasswordRequirements(password)) {
      setFeedback({
        kind: "error",
        message:
          "Your password must include an uppercase letter, a lowercase letter, a number, and a special character.",
      })
      return
    }

    setIsSubmitting(true)
    try {
      if (mode === "signup") {
        const credential = await createUserWithEmailAndPassword(
          auth,
          email.trim(),
          password
        )
        await sendEmailVerification(credential.user)
        navigate("/verify-email", { replace: true })
      } else {
        const credential = await signInWithEmailAndPassword(
          auth,
          email.trim(),
          password
        )
        const needsVerification =
          credential.user.providerData.some(
            (provider) => provider.providerId === "password"
          ) && !credential.user.emailVerified
        navigate(needsVerification ? "/verify-email" : "/home", {
          replace: true,
        })
      }
    } catch (error) {
      setFeedback({ kind: "error", message: getAuthErrorMessage(error) })
    } finally {
      setIsSubmitting(false)
    }
  }

  async function handlePasswordReset() {
    setFeedback(null)
    if (!auth) return
    if (!email.trim()) {
      setFeedback({
        kind: "error",
        message: "Enter your email address first, then request a reset link.",
      })
      return
    }

    setIsSubmitting(true)
    try {
      await sendPasswordResetEmail(auth, email.trim())
      setFeedback({
        kind: "success",
        message:
          "If an account exists for that email, a reset link is on its way.",
      })
    } catch (error) {
      setFeedback({ kind: "error", message: getAuthErrorMessage(error) })
    } finally {
      setIsSubmitting(false)
    }
  }

  async function handleProviderSignIn(provider: "google" | "anonymous") {
    setFeedback(null)
    if (!auth) return

    setProviderAction(provider)
    try {
      if (provider === "google") {
        await signInWithPopup(auth, new GoogleAuthProvider())
      } else {
        await signInAnonymously(auth)
      }
      navigate("/home", { replace: true })
    } catch (error) {
      setFeedback({ kind: "error", message: getAuthErrorMessage(error) })
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
            to="https://"
            className="flex w-fit items-center gap-3 rounded-lg outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
          >
            <span className="flex size-10 items-center justify-center rounded-xl bg-primary text-primary-foreground shadow-sm">
              <Flame aria-hidden="true" className="size-5" />
            </span>
            <span className="text-sm font-semibold tracking-tight">
              Burn the Boat
            </span>
          </Link>
          <div className="flex flex-col gap-2">
            <CardTitle className="text-3xl font-semibold tracking-tight">
              {mode === "login" ? "Welcome back" : "Start your journey"}
            </CardTitle>
            <CardDescription className="text-sm leading-relaxed">
              {mode === "login"
                ? "Sign in to pick up where you left off."
                : "Create an account and make your next move."}
            </CardDescription>
          </div>
        </CardHeader>

        <CardContent className="px-6 pb-6 sm:px-8">
          <form onSubmit={handleSubmit} className="flex flex-col gap-5">
            <FieldGroup className="gap-4">
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

              <Field>
                <div className="flex items-center justify-between gap-4">
                  <FieldLabel htmlFor="password">Password</FieldLabel>
                  {mode === "login" && (
                    <Button
                      type="button"
                      variant="link"
                      className="h-auto p-0 text-xs"
                      onClick={handlePasswordReset}
                      disabled={isBusy || !auth}
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
                  placeholder={"Enter your password"}
                  className="h-11 rounded-xl bg-background"
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  minLength={6}
                  required
                />
                {mode === "signup" && (
                  <ul className="mt-2 grid grid-cols-2 gap-x-2 gap-y-1 text-xs text-muted-foreground">
                    <li>An uppercase letter</li>
                    <li>A lowercase letter</li>
                    <li>A number</li>
                    <li>A special character</li>
                  </ul>
                )}
              </Field>

              {mode === "signup" && (
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
              disabled={isBusy || !auth}
            >
              {isSubmitting
                ? "Please wait..."
                : mode === "login"
                  ? "Sign in"
                  : "Create account"}
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
              disabled={isBusy || !auth}
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
                    disabled={isBusy || !auth}
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

          {!auth && (
            <p
              className="mt-5 rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive"
              role="alert"
            >
              For developer: Firebase isn&apos;t configured yet. Add{" "}
              VITE_FIREBASE_API_KEY, VITE_FIREBASE_AUTH_DOMAIN, and{" "}
              VITE_FIREBASE_PROJECT_ID to your environment.
            </p>
          )}
        </CardContent>

        <CardFooter className="justify-center border-t px-6 py-5 sm:px-8">
          <p className="text-center text-sm text-muted-foreground">
            {mode === "login"
              ? "New to Burn the Boat?"
              : "Already have an account?"}{" "}
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
