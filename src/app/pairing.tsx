import { useEffect, useMemo, useRef, useState, type SubmitEvent } from "react"
import type { FirebaseApp } from "firebase/app"
import type { User } from "firebase/auth"
import {
  collection,
  getFirestore,
  onSnapshot,
  query,
  where,
} from "firebase/firestore"
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
  CODE_LENGTH,
  parsePairing,
  parsePairingInvite,
  cancelPairingCode,
  createPairingCode,
  getPairingDisplayName,
  getPairingStatusMessage,
  isValidPairingCode,
  isPairingExpired,
  removePairing,
  redeemPairingCode,
  type Pairing,
  type PairingInvite,
  getExpireTime,
} from "@/lib/pairings"

type PairingPageProps = {
  firebaseApp: FirebaseApp
  user: User
}

function getUserDisplayName(user: User) {
  const name =
    user.email?.trim() ||
    user.displayName?.trim() ||
    "Guest Account"
  return name.slice(0, 80)
}

function formatTimeRemaining(milliseconds: number) {
  const totalSeconds = Math.max(0, Math.ceil(milliseconds / 1000))
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60

  return `${minutes}:${seconds.toString().padStart(2, "0")}`
}

export default function PairingPage({ firebaseApp, user }: PairingPageProps) {
  const db = useMemo(() => getFirestore(firebaseApp), [firebaseApp])
  const [ownedPairings, setOwnedPairings] = useState<Pairing[]>([])
  const [joinedPairings, setJoinedPairings] = useState<Pairing[]>([])
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

  useEffect(() => {
    const intervalId = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(intervalId)
  }, [])

  useEffect(() => {
    let ownerLoaded = false
    let partnerLoaded = false
    let invitesLoaded = false
    const collectionRef = collection(db, "pairing")
    const invitesCollectionRef = collection(db, "pairingInvites")
    const finishLoadingIfReady = () => {
      if (ownerLoaded && partnerLoaded && invitesLoaded) setIsLoading(false)
    }

    setIsLoading(true)
    const ownerUnsubscribe = onSnapshot(
      query(collectionRef, where("ownerUid", "==", user.uid)),
      (snapshot) => {
        try {
          setOwnedPairings(
            snapshot.docs.map((pairingDoc) =>
              parsePairing(pairingDoc.id, pairingDoc.data())
            )
          )
          ownerLoaded = true
          finishLoadingIfReady()
        } catch (snapshotError) {
          setError(getPairingStatusMessage(snapshotError))
          setIsLoading(false)
        }
      },
      (snapshotError) => {
        setError(getPairingStatusMessage(snapshotError))
        setIsLoading(false)
      }
    )
    const partnerUnsubscribe = onSnapshot(
      query(collectionRef, where("partnerUid", "==", user.uid)),
      (snapshot) => {
        try {
          setJoinedPairings(
            snapshot.docs.map((pairingDoc) =>
              parsePairing(pairingDoc.id, pairingDoc.data())
            )
          )
          partnerLoaded = true
          finishLoadingIfReady()
        } catch (snapshotError) {
          setError(getPairingStatusMessage(snapshotError))
          setIsLoading(false)
        }
      },
      (snapshotError) => {
        setError(getPairingStatusMessage(snapshotError))
        setIsLoading(false)
      }
    )
    const invitesUnsubscribe = onSnapshot(
      query(invitesCollectionRef, where("ownerUid", "==", user.uid)),
      (snapshot) => {
        try {
          setOwnedInvites(
            snapshot.docs.map((inviteDoc) =>
              parsePairingInvite(inviteDoc.id, inviteDoc.data())
            )
          )
          invitesLoaded = true
          finishLoadingIfReady()
        } catch (snapshotError) {
          setError(getPairingStatusMessage(snapshotError))
          setIsLoading(false)
        }
      },
      (snapshotError) => {
        setError(getPairingStatusMessage(snapshotError))
        setIsLoading(false)
      }
    )

    return () => {
      ownerUnsubscribe()
      partnerUnsubscribe()
      invitesUnsubscribe()
    }
  }, [db, user.uid])

  useEffect(() => {
    const expiredInvites = ownedInvites.filter(
      (invite) =>
        isPairingExpired(invite, now) &&
        now - (deletionAttempts.current.get(invite.id) ?? 0) >= 30_000
    )

    for (const invite of expiredInvites) {
      deletionAttempts.current.set(invite.id, now)
      void cancelPairingCode(db, user.uid, invite.id).catch((deleteError) => {
        setError(getPairingStatusMessage(deleteError))
      })
    }
  }, [db, now, ownedInvites, user.uid])

  const openPairing = ownedInvites.find(
    (invite) => !isPairingExpired(invite, now)
  )
  const activePairings = [...ownedPairings, ...joinedPairings].sort((a, b) =>
    a.id.localeCompare(b.id)
  )

  async function handleCreateCode() {
    setError(null)
    setFeedback(null)
    setIsCreating(true)

    try {
      const code = await createPairingCode(
        db,
        user.uid,
        getUserDisplayName(user)
      )
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
      await cancelPairingCode(db, user.uid, code)
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
      await removePairing(db, user.uid, pairing.id)
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
      await redeemPairingCode(db, code, user.uid, getUserDisplayName(user))
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
    <main className="mx-auto flex w-full max-w-5xl flex-col gap-8 p-6 md:p-10">
      <header className="flex flex-col gap-2">
        <h1 className="text-3xl font-semibold tracking-tight sm:text-4xl">
          Pair up with another sailor!
        </h1>
        <p className="max-w-2xl text-muted-foreground">
          And together witnessing the ship burned.
        </p>
      </header>

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
                    maxLength={CODE_LENGTH}
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
                      inviteCode.length > 0 && inviteCode.length !== CODE_LENGTH
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
                disabled={isJoining || inviteCode.length !== CODE_LENGTH}
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
                          {getPairingDisplayName(pairing, user.uid) ??
                            "Your pairing"}
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
                                aria-label={`Remove pairing with ${getPairingDisplayName(pairing, user.uid) ?? "this person"}`}
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
                                {getPairingDisplayName(pairing, user.uid) ??
                                  "this person"}{" "}
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
