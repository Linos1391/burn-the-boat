import { useEffect, useMemo, useState } from "react"
import { Link } from "react-router-dom"
import type { FirebaseApp } from "firebase/app"
import type { User } from "firebase/auth"
import {
  collection,
  getFirestore,
  onSnapshot,
  query,
  where,
} from "firebase/firestore"
import { Button } from "@/components/ui/button"
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@/components/ui/empty"
import { Skeleton } from "@/components/ui/skeleton"
import { ArrowRight } from "lucide-react"
import {
  getPairingDisplayName,
  getPairingStatusMessage,
  parsePairing,
  type Pairing,
} from "@/lib/pairings"

type HomePageProps = {
  firebaseApp: FirebaseApp | null
  user: User | null
}

export default function HomePage({ firebaseApp, user }: HomePageProps) {
  const userId = user?.uid
  const [ownedPairings, setOwnedPairings] = useState<Pairing[]>([])
  const [joinedPairings, setJoinedPairings] = useState<Pairing[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const activePairings = useMemo(
    () =>
      [...ownedPairings, ...joinedPairings].sort((a, b) =>
        a.id.localeCompare(b.id)
      ),
    [ownedPairings, joinedPairings]
  )

  useEffect(() => {
    if (!firebaseApp || !userId) return

    const collectionRef = collection(getFirestore(firebaseApp), "pairing")
    let ownerLoaded = false
    let partnerLoaded = false

    const finishLoadingIfReady = () => {
      if (ownerLoaded && partnerLoaded) setIsLoading(false)
    }
    const handleSnapshotError = (snapshotError: unknown) => {
      setError(getPairingStatusMessage(snapshotError))
      setIsLoading(false)
    }
    const ownerUnsubscribe = onSnapshot(
      query(collectionRef, where("ownerUid", "==", userId)),
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
          handleSnapshotError(snapshotError)
        }
      },
      handleSnapshotError
    )
    const partnerUnsubscribe = onSnapshot(
      query(collectionRef, where("partnerUid", "==", userId)),
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
          handleSnapshotError(snapshotError)
        }
      },
      handleSnapshotError
    )

    return () => {
      ownerUnsubscribe()
      partnerUnsubscribe()
    }
  }, [firebaseApp, userId])

  if (!firebaseApp || !user) {
    return (
      <main className="mx-auto flex w-full max-w-5xl flex-col gap-4 p-6 md:p-10">
        <h1 className="text-3xl font-semibold tracking-tight">Home</h1>
        <p role="alert" className="text-sm text-destructive">
          Unable to load your pairings. Please sign in and try again.
        </p>
      </main>
    )
  }

  if (isLoading) {
    return (
      <main
        className="mx-auto flex w-full max-w-5xl flex-col gap-4 p-6 md:p-10"
        role="status"
        aria-label="Loading your pairings"
      >
        <Skeleton className="h-10 w-64" />
        <Skeleton className="h-40 w-full" />
      </main>
    )
  }

  if (error) {
    return (
      <main className="mx-auto flex w-full max-w-5xl flex-col gap-4 p-6 md:p-10">
        <h1 className="text-3xl font-semibold tracking-tight">Home</h1>
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      </main>
    )
  }

  if (activePairings.length > 0 && user) {
    return (
      <p>Something here lol</p>
    )
  }

  return (
    <Empty className="flex">
      <EmptyHeader className="gap-4">
        <div className="flex flex-col gap-2">
          <EmptyTitle className="text-2xl font-semibold sm:text-3xl">
            No sailor found
          </EmptyTitle>
          <EmptyDescription className="text-base">
            Invite a friend to join your crew and set sail together.
          </EmptyDescription>
        </div>
      </EmptyHeader>
      <EmptyContent className="mt-2 max-w-xs gap-3">
        <Button
          className="h-11 w-full rounded-xl"
          render={<Link to="/pairing" />}
        >
          Get Started
          <ArrowRight data-icon="inline-end" aria-hidden="true" />
        </Button>
      </EmptyContent>
    </Empty>
  )
}
