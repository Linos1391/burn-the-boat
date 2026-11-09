import { PayPalButtons, PayPalScriptProvider } from "@paypal/react-paypal-js"
import type { SupabaseClient } from "@supabase/supabase-js"
import { Info, LoaderCircle, Mail, TriangleAlert, Wallet } from "lucide-react"
import { useEffect, useRef, useState, type SubmitEvent } from "react"

import { Button } from "@/components/ui/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { formatBet, type BoatRequest } from "@/lib/boat-requests"
import {
  applySavedPayoutEmail,
  authorizeStakeOrder,
  createStakeOrder,
  hasFailedPayout,
  isPayoutReady,
  isStakeAuthorized,
  maskEmail,
  needsPayoutEmail,
  saveDefaultPayoutEmail,
  savePayoutEmail,
  useDefaultPayoutEmail,
  type BoatStake,
} from "@/lib/boat-stakes"
import { paypalEnv } from "@/lib/env"
import { APP_ERRORS, getErrorMessage } from "@/lib/errors"

type PayoutEmailFormProps = {
  idPrefix: string
  submitLabel: string
  onSubmit: (email: string, confirmEmail: string) => Promise<void>
}

// The email is typed twice because a wrong address sends winnings to the wrong person.
export function PayoutEmailForm({
  idPrefix,
  submitLabel,
  onSubmit,
}: PayoutEmailFormProps) {
  const [email, setEmail] = useState("")
  const [confirmEmail, setConfirmEmail] = useState("")
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const submit = (event: SubmitEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (email.trim().toLowerCase() !== confirmEmail.trim().toLowerCase()) {
      setError("The two email addresses do not match.")
      return
    }
    setSaving(true)
    setError(null)
    void onSubmit(email.trim(), confirmEmail.trim())
      .then(() => {
        setEmail("")
        setConfirmEmail("")
      })
      .catch((submitError: unknown) =>
        setError(getErrorMessage(submitError, APP_ERRORS.email_save))
      )
      .finally(() => setSaving(false))
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-3">
      <FieldGroup>
        <Field data-invalid={error ? true : undefined}>
          <FieldLabel htmlFor={`${idPrefix}-email`}>PayPal email</FieldLabel>
          <Input
            id={`${idPrefix}-email`}
            type="email"
            autoComplete="off"
            maxLength={254}
            required
            placeholder="you@example.com"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            disabled={saving}
            aria-invalid={error ? true : undefined}
          />
        </Field>
        <Field data-invalid={error ? true : undefined}>
          <FieldLabel htmlFor={`${idPrefix}-confirm`}>
            Type it again to confirm
          </FieldLabel>
          <Input
            id={`${idPrefix}-confirm`}
            type="email"
            autoComplete="off"
            maxLength={254}
            required
            placeholder="you@example.com"
            value={confirmEmail}
            onChange={(event) => setConfirmEmail(event.target.value)}
            onPaste={(event) => event.preventDefault()}
            disabled={saving}
            aria-invalid={error ? true : undefined}
          />
        </Field>
      </FieldGroup>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      <Button type="submit" disabled={saving} className="self-start">
        {saving && (
          <LoaderCircle className="animate-spin" data-icon="inline-start" />
        )}
        {submitLabel}
      </Button>
    </form>
  )
}

type PayoutEmailCardProps = {
  supabase: SupabaseClient
  userId: string
}

export function PayoutEmailCard({ supabase, userId }: PayoutEmailCardProps) {
  const { loaded, email, error, refresh } = useDefaultPayoutEmail(supabase, userId)
  const [editing, setEditing] = useState(false)

  return (
    <Card>
      <CardHeader>
        <CardTitle>PayPal payout email</CardTitle>
        <CardDescription>
          Winnings are sent here when you bet $0 and your partner bets money. It
          is used automatically on new boats. Existing boats keep the email they
          already have.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {error && (
          <div className="flex flex-col items-start gap-2">
            <p role="alert" className="text-sm text-destructive">{error}</p>
            <Button type="button" variant="outline" onClick={() => void refresh()}>
              Retry
            </Button>
          </div>
        )}
        {loaded && (
          <p className="flex items-center gap-2 text-sm">
            <Wallet aria-hidden="true" className="size-4 text-primary" />
            {email ? (
              <>
                Current: <strong>{maskEmail(email)}</strong>
              </>
            ) : (
              <span className="text-muted-foreground">
                No payout email saved yet.
              </span>
            )}
          </p>
        )}
        {loaded && (editing || !email) ? (
          <PayoutEmailForm
            idPrefix="settings-payout"
            submitLabel={email ? "Update email" : "Save email"}
            onSubmit={async (value, confirmValue) => {
              await saveDefaultPayoutEmail(supabase, value, confirmValue)
              await refresh()
              setEditing(false)
            }}
          />
        ) : (
          loaded && (
            <Button
              type="button"
              variant="outline"
              className="self-start"
              onClick={() => setEditing(true)}
            >
              Change email
            </Button>
          )
        )}
      </CardContent>
    </Card>
  )
}


type StakePaymentProps = {
  supabase: SupabaseClient
  request: BoatRequest
  userId: string
  stakes: BoatStake[]
  payoutEmailUids: string[]
  onChanged: () => void
}

const STATUS_LABEL: Record<string, string> = {
  authorized: "Held",
  captured: "Charged",
  voided: "Released",
  failed: "Failed",
  unpaid: "Unpaid",
  refunded: "Refunded",
  created: "Not authorized",
}

export function StakePayment({
  supabase,
  request,
  userId,
  stakes,
  payoutEmailUids,
  onChanged,
}: StakePaymentProps) {
  const [error, setError] = useState<string | null>(null)
  const [editingEmail, setEditingEmail] = useState(false)
  const [savedEmail, setSavedEmail] = useState<string | null>(null)
  const isRequester = request.requesterUid === userId
  const myBet = isRequester
    ? request.requesterBetCents
    : request.partnerBetCents
  const theirBet = isRequester
    ? request.partnerBetCents
    : request.requesterBetCents
  const partnerUid = isRequester ? request.partnerUid : request.requesterUid
  const mineReady = isStakeAuthorized(stakes, userId, myBet)
  const theirsReady =
    isStakeAuthorized(stakes, partnerUid, theirBet) &&
    isPayoutReady(request, partnerUid, payoutEmailUids)
  const payoutFailed =
    needsPayoutEmail(request, userId) && hasFailedPayout(stakes)
  const wantsEmail =
    needsPayoutEmail(request, userId) &&
    (payoutFailed ||
      request.status === "review" ||
      (isRequester && request.status === "pending"))
  const emailSaved = isPayoutReady(request, userId, payoutEmailUids)
  const showForm = payoutFailed || editingEmail || !emailSaved

  // Fills in the default payout email (or an earlier PayPal payer email) so most users never type one.
  const triedSaved = useRef<string | null>(null)
  useEffect(() => {
    if (!wantsEmail || emailSaved || payoutFailed) return
    const cycleKey = `${request.id}:${request.cycleId}`
    if (triedSaved.current === cycleKey) return
    triedSaved.current = cycleKey
    void applySavedPayoutEmail(supabase, request.id)
      .then((email) => {
        if (!email) return
        setSavedEmail(email)
        onChanged()
      })
      .catch((applyError: unknown) => {
        console.error("Unable to apply saved payout email.", applyError)
        setError("Unable to apply your saved payout email. Enter it below.")
      })
  }, [wantsEmail, emailSaved, payoutFailed, request.id, request.cycleId, supabase, onChanged])

  const saveEmail = async (email: string, confirmEmail: string) => {
    setError(null)
    await savePayoutEmail(supabase, request.id, email, confirmEmail)
    setSavedEmail(email)
    setEditingEmail(false)
    onChanged()
  }
  const canPay =
    myBet > 0 &&
    !mineReady &&
    (request.status === "review" ||
      (isRequester && request.status === "pending"))

  if (myBet === 0 && theirBet === 0) return null

  const longDeadline =
    request.deadlineAt !== null &&
    request.deadlineAt.toMillis() - request.createdAt.toMillis() >
      3 * 24 * 60 * 60 * 1000

  const statusFor = (uid: string, bet: number) => {
    if (bet === 0) return "No bet"
    const stake = stakes.find((item) => item.userUid === uid)
    if (stake?.status === "captured") {
      if (stake.payoutStatus === "sent") return "Charged; payout initiated"
      if (stake.payoutStatus === "failed") return "Charged; payout failed"
      if (stake.payoutStatus === "skipped") return "Charged; payout skipped"
      return "Charged; payout pending"
    }
    return STATUS_LABEL[stake?.status ?? "created"] ?? "Not authorized"
  }

  return (
    <div className="flex flex-col gap-3 rounded-lg border p-3 text-sm">
      <div className="flex items-start gap-2">
        <Info
          aria-hidden="true"
          className="mt-0.5 size-4 shrink-0 text-primary"
        />
        <p className="text-muted-foreground">
          Your bet is only held on PayPal, and you are charged only if you lose.
          Winnings are sent to the winner's PayPal email.
        </p>
      </div>
      {longDeadline && (
        <p role="note" className="text-amber-600 dark:text-amber-400">
          This deadline is more than 3 days away. PayPal only guarantees a hold
          for about 3 days. We renew it once before the deadline, but the
          payment may still not be collectable from the loser. Bets are capped
          at $50.
        </p>
      )}
      {stakes.some((stake) => stake.atRisk) && (
        <p role="alert" className="text-destructive">
          PayPal could not renew a hold on this boat. If that person loses,
          their payment may not be collectable.
        </p>
      )}
      <p>
        You ({formatBet(myBet)}): <strong>{statusFor(userId, myBet)}</strong> ·
        Partner ({formatBet(theirBet)}):{" "}
        <strong>{statusFor(partnerUid, theirBet)}</strong>
      </p>
      {wantsEmail && (
        <div
          className={
            payoutFailed
              ? "flex flex-col gap-3 rounded-lg border-2 border-destructive/40 bg-destructive/5 p-3"
              : "flex flex-col gap-3 rounded-lg border-2 border-primary/30 bg-primary/5 p-3"
          }
        >
          <div className="flex items-start gap-2">
            {payoutFailed ? (
              <TriangleAlert
                aria-hidden="true"
                className="mt-0.5 size-5 shrink-0 text-destructive"
              />
            ) : (
              <Mail
                aria-hidden="true"
                className="mt-0.5 size-5 shrink-0 text-primary"
              />
            )}
            <div className="flex flex-col gap-1">
              <p className="font-semibold text-foreground">
                {payoutFailed
                  ? "We could not send your winnings"
                  : "PayPal email for winnings"}
              </p>
              <p className="text-sm text-muted-foreground">
                {payoutFailed
                  ? "PayPal refused the payout. Fix your PayPal email below within 7 days, or the other bettor will be refunded."
                  : emailSaved
                    ? savedEmail
                      ? `Winnings will be sent to ${maskEmail(savedEmail)}.`
                      : "A payout email is saved for this boat."
                    : "Enter the PayPal email where your winnings should be sent."}
              </p>
            </div>
          </div>
          {showForm ? (
            <PayoutEmailForm
              idPrefix={`payout-${request.id}`}
              submitLabel={payoutFailed ? "Update and retry" : "Save email"}
              onSubmit={saveEmail}
            />
          ) : (
            <Button
              type="button"
              variant="outline"
              className="self-start"
              onClick={() => setEditingEmail(true)}
            >
              Change email
            </Button>
          )}
        </div>
      )}
      {canPay &&
        (paypalEnv.clientId ? (
          <PayPalScriptProvider
            options={{
              clientId: paypalEnv.clientId,
              intent: "authorize",
              currency: "USD",
              components: "buttons",
            }}
          >
            <PayPalButtons
              style={{ layout: "horizontal", tagline: false, height: 40 }}
              createOrder={() => createStakeOrder(supabase, request.id)}
              onApprove={async (data) => {
                setError(null)
                try {
                  await authorizeStakeOrder(supabase, request.id, data.orderID)
                  onChanged()
                } catch (authorizeError) {
                  setError(
                    getErrorMessage(authorizeError, APP_ERRORS.bet_authorize)
                  )
                }
              }}
              onError={() => setError("PayPal could not start. Try again.")}
            />
          </PayPalScriptProvider>
        ) : (
          <p role="alert" className="text-destructive">
            PayPal is not configured.
          </p>
        ))}
      {mineReady && !theirsReady && request.status !== "active" && (
        <p className="text-muted-foreground">
          Waiting for your partner to authorize.
        </p>
      )}
      {error && (
        <p role="alert" className="text-destructive">
          {error}
        </p>
      )}
    </div>
  )
}
