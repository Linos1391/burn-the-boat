import { useEffect, useMemo, useRef, useState, type SubmitEvent } from "react"
import type { SupabaseClient } from "@supabase/supabase-js"
import type { User } from "@/lib/auth"
import {
  Check,
  Copy,
  LoaderCircle,
  Plus,
  Trash2,
  UsersRound,
  UserRoundPlus,
} from "lucide-react"
import { Button } from "@/components/ui/button"
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
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import {
  PAIRING_CODE_LENGTH,
  parsePairing,
  parsePairingInvite,
  cancelPairingCode,
  createPairingCode,
  getPairingPartnerUid,
  getPairingStatusMessage,
  isValidPairingCode,
  isPairingExpired,
  removePairing,
  redeemPairingCode,
  type Pairing,
  type PairingInvite,
  getExpireTime,
} from "@/lib/pairings"
import { APP_ERRORS } from "@/lib/errors"
import {
  fetchProfileDisplayNames,
  getProfileDisplayName,
} from "@/lib/user-profiles"

type PairingPageProps = {
  supabase: SupabaseClient
  user: User
}

function formatTimeRemaining(milliseconds: number) {
  const totalSeconds = Math.max(0, Math.ceil(milliseconds / 1000))
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60

  return `${minutes}:${seconds.toString().padStart(2, "0")}`
}

export default function PairingPage({ supabase, user }: PairingPageProps) {
  const [ownedPairings, setOwnedPairings] = useState<Pairing[]>([])
  const [joinedPairings, setJoinedPairings] = useState<Pairing[]>([])
  const [displayNameLookup, setDisplayNameLookup] = useState<{
    key: string
    names: Record<string, string>
    unavailable: boolean
  }>({ key: "", names: {}, unavailable: false })
  const [ownedInvites, setOwnedInvites] = useState<PairingInvite[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [isCreating, setIsCreating] = useState(false)
  const [isJoining, setIsJoining] = useState(false)
  const [isRemoving, setIsRemoving] = useState(false)
  const [removingPairingId, setRemovingPairingId] = useState<string | null>(
    null
  )
  const [inviteCode, setInviteCode] = useState("")
  const [feedback, setFeedback] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [copiedCode, setCopiedCode] = useState<string | null>(null)
  const [now, setNow] = useState(() => Date.now())
  const deletionAttempts = useRef(new Map<string, number>())
  const activePairings = useMemo(
    () =>
      [...ownedPairings, ...joinedPairings].sort((a, b) =>
        a.id.localeCompare(b.id)
      ),
    [ownedPairings, joinedPairings]
  )
  const displayNameLookupKey = `${user.uid}:${activePairings
    .map((pairing) => pairing.id)
    .join(",")}`
  const displayNames =
    displayNameLookup.key === displayNameLookupKey
      ? displayNameLookup.names
      : {}
  const displayNamesUnavailable =
    displayNameLookup.key === displayNameLookupKey &&
    displayNameLookup.unavailable

  useEffect(() => {
    let cancelled = false
    const partnerUids = activePairings.map((pairing) =>
      getPairingPartnerUid(pairing, user.uid)
    )
    void fetchProfileDisplayNames(supabase, partnerUids)
      .then((names) => {
        if (!cancelled) {
          setDisplayNameLookup({
            key: displayNameLookupKey,
            names,
            unavailable: false,
          })
        }
      })
      .catch((lookupError: unknown) => {
        if (!cancelled) {
          console.warn("Unable to load paired account names.", lookupError)
          setDisplayNameLookup({
            key: displayNameLookupKey,
            names: {},
            unavailable: true,
          })
        }
      })
    return () => {
      cancelled = true
    }
  }, [activePairings, displayNameLookupKey, supabase, user.uid])

  useEffect(() => {
    const intervalId = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(intervalId)
  }, [])

  useEffect(() => {
    let ownerLoaded = false
    let partnerLoaded = false
    let invitesLoaded = false
    const finishLoadingIfReady = () => {
      if (ownerLoaded && partnerLoaded && invitesLoaded) setIsLoading(false)
    }
    let active = true
    const channel = supabase
      .channel(`pairing:${user.uid}`)
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "pairings",
          filter: `owner_uid=eq.${user.uid}`,
        },
        () => void loadPairings()
      )
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "pairings",
          filter: `partner_uid=eq.${user.uid}`,
        },
        () => void loadPairings()
      )
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "pairing_invites",
          filter: `owner_uid=eq.${user.uid}`,
        },
        () => void loadInvites()
      )
      .subscribe((status) => {
        if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") {
          setError(APP_ERRORS.realtime)
          setIsLoading(false)
        }
      })
    async function loadPairings() {
      const [owned, joined] = await Promise.all([
        supabase.from("pairings").select("*").eq("owner_uid", user.uid),
        supabase.from("pairings").select("*").eq("partner_uid", user.uid),
      ])
      if (!active) return
      if (owned.error || joined.error) {
        setError(getPairingStatusMessage(owned.error ?? joined.error))
        setIsLoading(false)
        return
      }
      try {
        setOwnedPairings(owned.data.map((row) => parsePairing(row)))
        setJoinedPairings(joined.data.map((row) => parsePairing(row)))
        ownerLoaded = true
        partnerLoaded = true
        finishLoadingIfReady()
      } catch (loadError) {
        setError(getPairingStatusMessage(loadError))
        setIsLoading(false)
      }
    }
    async function loadInvites() {
      const { data, error: inviteError } = await supabase
        .from("pairing_invites")
        .select("*")
        .eq("owner_uid", user.uid)
      if (!active) return
      if (inviteError) {
        setError(getPairingStatusMessage(inviteError))
        setIsLoading(false)
        return
      }
      try {
        setOwnedInvites(data.map((row) => parsePairingInvite(row)))
        invitesLoaded = true
        finishLoadingIfReady()
      } catch (loadError) {
        setError(getPairingStatusMessage(loadError))
        setIsLoading(false)
      }
    }
    void loadPairings()
    void loadInvites()

    return () => {
      active = false
      void supabase.removeChannel(channel)
    }
  }, [supabase, user.uid])

  useEffect(() => {
    const expiredInvites = ownedInvites.filter(
      (invite) =>
        isPairingExpired(invite, now) &&
        now - (deletionAttempts.current.get(invite.id) ?? 0) >= 30_000
    )

    for (const invite of expiredInvites) {
      deletionAttempts.current.set(invite.id, now)
      void cancelPairingCode(supabase, user.uid, invite.id).catch(
        (deleteError) => {
          setError(getPairingStatusMessage(deleteError))
        }
      )
    }
  }, [supabase, now, ownedInvites, user.uid])

  const openPairing = ownedInvites.find(
    (invite) => !isPairingExpired(invite, now)
  )
  async function handleCreateCode() {
    setError(null)
    setFeedback(null)
    setIsCreating(true)

    try {
      const code = await createPairingCode(supabase, user.uid)
      setOwnedInvites((invites) => [
        parsePairingInvite({
          code,
          owner_uid: user.uid,
          created_at: new Date().toISOString(),
        }),
        ...invites.filter((invite) => !isPairingExpired(invite, Date.now())),
      ])
      setFeedback(
        `Your invite code is ${code}. Share it with one person to pair.`
      )
    } catch (createError) {
      setError(getPairingStatusMessage(createError))
    } finally {
      setIsCreating(false)
    }
  }

  async function handleRemoveCode(code: string) {
    setError(null)
    setFeedback(null)
    setIsRemoving(true)

    try {
      await cancelPairingCode(supabase, user.uid, code)
      setOwnedInvites((invites) =>
        invites.filter((invite) => invite.id !== code)
      )
      setFeedback("Invite code removed. It can no longer be used.")
    } catch (removeError) {
      setError(getPairingStatusMessage(removeError))
    } finally {
      setIsRemoving(false)
    }
  }

  async function handleRemovePairing(pairing: Pairing) {
    setError(null)
    setFeedback(null)
    setRemovingPairingId(pairing.id)

    try {
      await removePairing(supabase, pairing.id)
      setFeedback(
        "Pairing removed. You can pair with this person again using a new code."
      )
    } catch (removeError) {
      setError(getPairingStatusMessage(removeError))
    } finally {
      setRemovingPairingId(null)
    }
  }

  async function handleJoin(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault()
    const code = inviteCode.trim().toUpperCase()
    if (!isValidPairingCode(code)) {
      setError("Enter a valid 12-character pairing code.")
      setFeedback(null)
      return
    }

    setError(null)
    setFeedback(null)
    setIsJoining(true)
    try {
      await redeemPairingCode(supabase, code)
      setInviteCode("")
      setFeedback("You're paired! Your new connection is now in your boat.")
    } catch (joinError) {
      setError(getPairingStatusMessage(joinError))
    } finally {
      setIsJoining(false)
    }
  }

  async function handleCopyCode(code: string) {
    setError(null)
    setFeedback(null)
    try {
      await navigator.clipboard.writeText(code)
      setCopiedCode(code)
      window.setTimeout(() => setCopiedCode(null), 2000)
    } catch (copyError) {
      setError(getPairingStatusMessage(copyError))
    }
  }

  return (
    <main className="mx-auto flex w-full max-w-3xl flex-col gap-8 p-6 md:p-10">
      <header className="flex flex-col gap-2">
        <h1 className="text-3xl font-semibold tracking-tight sm:text-4xl">
          Pair up with another sailor!
        </h1>
        <p className="max-w-2xl text-muted-foreground">
          And together witnessing the ship burned.
        </p>
      </header>
      {displayNamesUnavailable && (
        <p role="status" className="text-sm text-muted-foreground">
          Account names are unavailable. Showing user IDs instead.
        </p>
      )}

      <section
        aria-label="Pairing actions"
        className="grid gap-4 md:grid-cols-2"
      >
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <UserRoundPlus aria-hidden="true" />
              Invite someone
            </CardTitle>
            <CardDescription>
              You can have one active invite at a time. It expires after five
              minutes.
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <Button
              className="w-full"
              disabled={isLoading || isCreating || Boolean(openPairing)}
              onClick={handleCreateCode}
            >
              {isCreating ? (
                <LoaderCircle
                  className="animate-spin"
                  data-icon="inline-start"
                  aria-hidden="true"
                />
              ) : (
                <Plus data-icon="inline-start" aria-hidden="true" />
              )}
              {isCreating
                ? "Creating code..."
                : openPairing
                  ? "Created invite code"
                  : "Create invite code"}
            </Button>
            {openPairing && (
              <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border p-3">
                <div className="flex min-w-0 flex-col gap-1">
                  <span className="font-mono text-lg font-semibold tracking-widest">
                    {openPairing.id}
                  </span>
                  <span className="text-xs text-muted-foreground">
                    Expires in{" "}
                    {formatTimeRemaining(
                      getExpireTime(openPairing.createdAt) - now
                    )}
                  </span>
                </div>

                <div className="flex flex-col gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => handleCopyCode(openPairing.id)}
                    aria-label={`Copy invite code ${openPairing.id}`}
                  >
                    {copiedCode === openPairing.id ? (
                      <Check data-icon="inline-start" aria-hidden="true" />
                    ) : (
                      <Copy data-icon="inline-start" aria-hidden="true" />
                    )}
                    {copiedCode === openPairing.id ? "Copied" : "Copy"}
                  </Button>
                  <Button
                    type="button"
                    variant="destructive"
                    size="sm"
                    disabled={isRemoving}
                    onClick={() => handleRemoveCode(openPairing.id)}
                    aria-label={`Remove invite code ${openPairing.id}`}
                  >
                    {isRemoving ? (
                      <LoaderCircle
                        className="animate-spin"
                        data-icon="inline-start"
                        aria-hidden="true"
                      />
                    ) : (
                      <Trash2 data-icon="inline-start" aria-hidden="true" />
                    )}
                    {isRemoving ? "Removing..." : "Remove"}
                  </Button>
                </div>
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <UsersRound aria-hidden="true" />
              Join with a code
            </CardTitle>
            <CardDescription>
              Enter the code they shared with you.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <form onSubmit={handleJoin} className="flex flex-col gap-4">
              <FieldGroup>
                <Field>
                  <FieldLabel htmlFor="pairing-code">Pairing code</FieldLabel>
                  <Input
                    id="pairing-code"
                    autoComplete="off"
                    autoCapitalize="characters"
                    maxLength={PAIRING_CODE_LENGTH}
                    placeholder="e.g. SA1LA80ATN0W"
                    value={inviteCode}
                    onChange={(event) =>
                      setInviteCode(
                        event.target.value
                          .toUpperCase()
                          .replace(/[^A-HJ-NP-Z2-9]/g, "")
                      )
                    }
                    aria-invalid={
                      inviteCode.length > 0 &&
                      inviteCode.length !== PAIRING_CODE_LENGTH
                    }
                  />
                  <FieldDescription>
                    Enter the full code, without spaces.
                  </FieldDescription>
                </Field>
              </FieldGroup>
              <Button
                type="submit"
                variant="outline"
                disabled={
                  isJoining || inviteCode.length !== PAIRING_CODE_LENGTH
                }
              >
                {isJoining && (
                  <LoaderCircle
                    className="animate-spin"
                    data-icon="inline-start"
                    aria-hidden="true"
                  />
                )}
                {isJoining ? "Joining..." : "Join with code"}
              </Button>
            </form>
          </CardContent>
        </Card>
      </section>

      {(error || feedback) && (
        <p
          role={error ? "alert" : "status"}
          className={
            error ? "text-sm text-destructive" : "text-sm text-muted-foreground"
          }
        >
          {error ?? feedback}
        </p>
      )}

      <section aria-labelledby="crew-heading" className="flex flex-col gap-4">
        <div className="flex flex-wrap items-end justify-between gap-2">
          <div>
            <h2 id="crew-heading" className="text-xl font-semibold">
              Your pairings
            </h2>
            <p className="text-sm text-muted-foreground">
              Your active connections.
            </p>
          </div>
          {!isLoading && (
            <p className="text-sm text-muted-foreground">
              {activePairings.length} active
            </p>
          )}
        </div>

        {isLoading ? (
          <p role="status" className="text-sm text-muted-foreground">
            Loading your pairings...
          </p>
        ) : (
          <div className="grid gap-4">
            <Card>
              <CardHeader>
                <CardTitle>Active pairs</CardTitle>
                <CardDescription className="text-sm text-muted-foreground">
                  {activePairings.length === 0 ? (
                    <span>
                      No pairs yet. Create a code or join someone&apos;s invite
                      to get started.
                    </span>
                  ) : (
                    <span>
                      You are not alone in this journey. You guys are on the
                      same boat.
                    </span>
                  )}
                </CardDescription>
              </CardHeader>
              {activePairings.length > 0 ? (
                <CardContent className="flex flex-col gap-3">
                  {activePairings.map((pairing) => (
                    <div
                      key={pairing.id}
                      className="flex items-center justify-between gap-3 rounded-lg border p-3"
                    >
                      <div className="flex min-w-0 flex-col">
                        <span className="truncate font-medium">
                          {getProfileDisplayName(
                            getPairingPartnerUid(pairing, user.uid),
                            displayNames
                          )}
                        </span>
                        <span className="text-xs text-muted-foreground">
                          From {pairing.createdAt.toDate().toDateString()}
                        </span>
                      </div>
                      <div className="flex shrink-0 items-center gap-2">
                        <AlertDialog>
                          <AlertDialogTrigger
                            render={
                              <Button
                                type="button"
                                variant="destructive"
                                size="sm"
                                disabled={removingPairingId !== null}
                                aria-label={`Remove pairing with ${getProfileDisplayName(getPairingPartnerUid(pairing, user.uid), displayNames)}`}
                              >
                                <Trash2
                                  data-icon="inline-start"
                                  aria-hidden="true"
                                />
                                Remove
                              </Button>
                            }
                          />
                          <AlertDialogContent>
                            <AlertDialogHeader>
                              <AlertDialogTitle>
                                Remove this pairing?
                              </AlertDialogTitle>
                              <AlertDialogDescription>
                                This will remove your connection with{" "}
                                {getProfileDisplayName(
                                  getPairingPartnerUid(pairing, user.uid),
                                  displayNames
                                )}{" "}
                                for both accounts. You can pair again with a new
                                invite code.
                              </AlertDialogDescription>
                            </AlertDialogHeader>
                            <AlertDialogFooter>
                              <AlertDialogCancel
                                disabled={removingPairingId === pairing.id}
                              >
                                Keep pairing
                              </AlertDialogCancel>
                              <AlertDialogAction
                                variant="destructive"
                                disabled={removingPairingId === pairing.id}
                                onClick={() =>
                                  void handleRemovePairing(pairing)
                                }
                              >
                                {removingPairingId === pairing.id ? (
                                  <LoaderCircle
                                    className="animate-spin"
                                    data-icon="inline-start"
                                    aria-hidden="true"
                                  />
                                ) : (
                                  <Trash2
                                    data-icon="inline-start"
                                    aria-hidden="true"
                                  />
                                )}
                                {removingPairingId === pairing.id
                                  ? "Removing..."
                                  : "Remove pairing"}
                              </AlertDialogAction>
                            </AlertDialogFooter>
                          </AlertDialogContent>
                        </AlertDialog>
                      </div>
                    </div>
                  ))}
                </CardContent>
              ) : (
                <></>
              )}
            </Card>
          </div>
        )}
      </section>
    </main>
  )
}
