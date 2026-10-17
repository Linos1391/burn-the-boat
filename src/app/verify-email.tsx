import { useEffect, useState } from "react"
import { Navigate, useNavigate } from "react-router-dom"
import {
  getAuth,
  onAuthStateChanged,
  reload,
  sendEmailVerification,
  signOut,
  type Auth,
  type User,
} from "firebase/auth"
import type { FirebaseApp } from "firebase/app"
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
  firebaseApp: FirebaseApp | null
}

type Feedback = {
  kind: "error" | "success"
  message: string
}

function getErrorMessage(error: unknown) {
  if (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string"
  ) {
    if (error.code === "auth/too-many-requests") {
      return "Too many requests. Please wait a little before trying again."
    }
    if (error.code === "auth/network-request-failed") {
      return "Couldn't connect to Firebase. Check your connection and try again."
    }
  }

  return error instanceof Error
    ? error.message
    : "Something went wrong. Please try again."
}

export default function VerifyEmailPage({
  firebaseApp,
}: VerifyEmailPageProps) {
  const navigate = useNavigate()
  const auth: Auth | null = firebaseApp ? getAuth(firebaseApp) : null
  const [user, setUser] = useState<User | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [isBusy, setIsBusy] = useState(false)
  const [feedback, setFeedback] = useState<Feedback | null>(null)

  useEffect(() => {
    if (!auth) {
      setIsLoading(false)
      return
    }

    return onAuthStateChanged(
      auth,
      (currentUser) => {
        setUser(currentUser)
        setIsLoading(false)

        if (!currentUser) {
          navigate("/login", { replace: true })
          return
        }

        const isEmailPasswordUser = currentUser.providerData.some(
          (provider) => provider.providerId === "password"
        )
        if (!isEmailPasswordUser || currentUser.emailVerified) {
          navigate("/home", { replace: true })
        }
      },
      (error) => {
        console.error("Failed to determine the current Firebase user.", error)
        setFeedback({
          kind: "error",
          message: "We couldn't check your sign-in status. Refresh and try again.",
        })
        setIsLoading(false)
      }
    )
  }, [auth, navigate])

  async function handleResend() {
    setFeedback(null)
    if (!user) return

    setIsBusy(true)
    try {
      await sendEmailVerification(user)
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
    const currentUser = auth?.currentUser
    if (!currentUser) return

    setIsBusy(true)
    try {
      await reload(currentUser)
      if (currentUser.emailVerified) {
        navigate("/home", { replace: true })
      } else {
        setFeedback({
          kind: "error",
          message: "Your email isn't verified yet. Open the link in your email, then try again.",
        })
      }
    } catch (error) {
      setFeedback({ kind: "error", message: getErrorMessage(error) })
    } finally {
      setIsBusy(false)
    }
  }

  async function handleUseAnotherAccount() {
    if (!auth) return

    setIsBusy(true)
    try {
      await signOut(auth)
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

  if (!auth) {
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
              <span className="font-medium text-foreground">
                {user?.email ?? "your email address"}
              </span>
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
            disabled={isBusy || !user}
          >
            {isBusy ? "Please wait..." : "I've verified my email"}
          </Button>
          <Button
            variant="outline"
            className="h-11 w-full rounded-xl"
            onClick={handleResend}
            disabled={isBusy || !user}
          >
            Resend verification email
          </Button>
          <Button
            variant="link"
            className="h-auto self-center"
            onClick={handleUseAnotherAccount}
            disabled={isBusy || !auth}
          >
            Use another account
          </Button>
        </CardContent>
      </Card>
    </main>
  )
}
