import { useEffect, useMemo, useRef, useState, type SubmitEvent } from "react"
import { Link } from "react-router-dom"
import type { SupabaseClient } from "@supabase/supabase-js"
import type { User } from "@/lib/auth"
import { cn } from "cn"
import { addDays, format, startOfDay } from "date-fns"
import {
  CalendarIcon,
  Check,
  Clock2Icon,
  HandshakeIcon,
  Info,
  LoaderCircle,
  MessageCircle,
  Send,
  X,
} from "lucide-react"
import { Button, buttonVariants } from "@/components/ui/button"
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  Field,
  FieldError,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
} from "@/components/ui/input-group"
import { StakePayment } from "@/app/stake-payment"
import {
  isPayoutReady,
  isStakeAuthorized,
  useBoatStakes,
} from "@/lib/boat-stakes"
import { Skeleton } from "@/components/ui/skeleton"
import { Textarea } from "@/components/ui/textarea"
import { Calendar } from "@/components/ui/calendar"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover"
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Bubble, BubbleContent } from "@/components/ui/bubble"
import {
  Message,
  MessageContent,
  MessageFooter,
  MessageGroup,
  MessageHeader,
} from "@/components/ui/message"
import {
  MessageScroller,
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerProvider,
  MessageScrollerViewport,
} from "@/components/ui/message-scroller"
import {
  cancelBoatRequest,
  createBoatRequest,
  decideBoatRequest,
  forfeitBoatRequest,
  formatBet,
  parseBetInput,
  setPartnerBet,
  type BoatStakeMode,
  parseBoatChatMessage,
  parseBoatRequest,
  sendBoatChatMessage,
  submitPartnerPlan,
  type BoatChatMessage,
  type BoatPlan,
  type BoatRequest,
} from "@/lib/boat-requests"
import { recommendBoatPlanMatch } from "@/lib/ai"
import { APP_ERRORS, AppError, getErrorMessage } from "@/lib/errors"
import {
  getPairingPartnerUid,
  getPairingStatusMessage,
  parsePairing,
  type Pairing,
} from "@/lib/pairings"
import {
  fetchProfileDisplayNames,
  getProfileDisplayName,
} from "@/lib/user-profiles"
import { DbTimestamp, parseTimestamp } from "@/lib/supabase"

type HomePageProps = {
  supabase: SupabaseClient | null
  user: User | null
}

type PlannerPlanSummary = {
  id: string
  title: string
  description: string
  mode: "casual" | "fire" | "inferno"
  boatReady: boolean
  totalEstimatedMinutes: number
  remainingEstimatedMinutes: number
  createdAt: DbTimestamp
  stepCount: number
}

type BusyAction =
  "message" | "request" | "response" | "accept" | "deny" | "cancel" | "forfeit"

function getPlanDifficulty(plan: Pick<BoatPlan, "totalEstimatedMinutes">) {
  const hours = plan.totalEstimatedMinutes / 60
  if (hours <= 1) return "Light"
  if (hours <= 4) return "Moderate"
  if (hours <= 12) return "Challenging"
  return "Intensive"
}

function hasSameDifficulty(
  firstPlan: Pick<BoatPlan, "totalEstimatedMinutes">,
  secondPlan: Pick<BoatPlan, "totalEstimatedMinutes">
) {
  return getPlanDifficulty(firstPlan) === getPlanDifficulty(secondPlan)
}

async function loadBoatPlan(
  supabase: SupabaseClient,
  plan: PlannerPlanSummary
) {
  const { data: tasks, error } = await supabase
    .from("planner_tasks")
    .select("*")
    .eq("plan_id", plan.id)
    .order("position")
  if (error) throw error
  if (tasks.length > 50) {
    throw new Error("Plans shared for a boat can have at most 50 tasks.")
  }
  const parsedTasks = tasks.map((data) => {
    if (
      typeof data.id !== "string" ||
      typeof data.title !== "string" ||
      typeof data.estimated_minutes !== "number" ||
      typeof data.completed !== "boolean" ||
      typeof data.category !== "string" ||
      !Array.isArray(data.depends_on) ||
      !data.depends_on.every((id: unknown) => typeof id === "string")
    ) {
      throw new AppError(APP_ERRORS.invalid_data)
    }
    return {
      id: data.id,
      title: data.title,
      estimatedMinutes: data.estimated_minutes,
      category: data.category,
      dependsOn: data.depends_on,
    }
  })
  if (parsedTasks.length === 0) {
    throw new Error("A plan needs at least one step to be on a boat.")
  }
  return {
    id: plan.id,
    title: plan.title,
    description: plan.description,
    mode: plan.mode,
    boatReady: plan.boatReady,
    totalEstimatedMinutes: tasks.reduce(
      (total, task) =>
        total + (task.completed ? 0 : task.estimated_minutes),
      0
    ),
    tasks: parsedTasks,
  } satisfies BoatPlan
}

export default function HomePage({ supabase, user }: HomePageProps) {
  const userId = user?.uid
  const [ownedPairings, setOwnedPairings] = useState<Pairing[]>([])
  const [joinedPairings, setJoinedPairings] = useState<Pairing[]>([])
  const [displayNameLookup, setDisplayNameLookup] = useState<{
    key: string
    names: Record<string, string>
    unavailable: boolean
  }>({ key: "", names: {}, unavailable: false })
  const [plannerPlans, setPlannerPlans] = useState<PlannerPlanSummary[]>([])
  const [boatRequests, setBoatRequests] = useState<Record<string, BoatRequest>>(
    {}
  )
  const [chatMessages, setChatMessages] = useState<
    Record<string, BoatChatMessage[]>
  >({})
  const [selectedPartnerId, setSelectedPartnerId] = useState("")
  const [selectedPlanId, setSelectedPlanId] = useState("")
  const [selectedResponsePlans, setSelectedResponsePlans] = useState<
    Record<string, string>
  >({})
  const [recommendations, setRecommendations] = useState<
    Record<string, { planId: string; reason: string }>
  >({})
  const [chatDraft, setChatDraft] = useState("")
  const [stakeMode, setStakeMode] = useState<BoatStakeMode>("collaborate")
  const [deadlineDate, setDeadlineDate] = useState<Date | undefined>()
  const [deadlineTime, setDeadlineTime] = useState("23:59:00")
  const [isDeadlineCalendarOpen, setIsDeadlineCalendarOpen] = useState(false)
  const [betInput, setBetInput] = useState("")
  const [partnerBetInput, setPartnerBetInput] = useState("")
  const sendingMessage = useRef(false)
  const [isChatOpen, setIsChatOpen] = useState(false)
  const [isForfeitOpen, setIsForfeitOpen] = useState(false)
  const [isRequestComposerOpen, setIsRequestComposerOpen] = useState(false)
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [busyAction, setBusyAction] = useState<BusyAction | null>(null)
  const [recommendationBusy, setRecommendationBusy] = useState(false)

  const activePairings = useMemo(
    () =>
      [...ownedPairings, ...joinedPairings].sort((a, b) =>
        a.id.localeCompare(b.id)
      ),
    [ownedPairings, joinedPairings]
  )
  const displayNameLookupKey = `${userId ?? ""}:${activePairings
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
    if (!supabase || !user || !userId) {
      return
    }
    const client = supabase

    const partnerUids = [
      userId,
      ...activePairings.map((pairing) => getPairingPartnerUid(pairing, userId)),
    ]
    void fetchProfileDisplayNames(client, partnerUids)
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
  }, [activePairings, displayNameLookupKey, supabase, user, userId])

  const selectedPairing =
    activePairings.find((pairing) => pairing.id === selectedPartnerId) ??
    activePairings[0]
  const boatPlans = plannerPlans.filter(
    (plan) => plan.stepCount > 0 && plan.boatReady
  )
  const planSelectItems = boatPlans.map((plan) => ({
    label: plan.title,
    value: plan.id,
  }))
  const selectedRequest = selectedPairing
    ? boatRequests[selectedPairing.id]
    : undefined
  const selectedPlan = boatPlans.find((plan) => plan.id === selectedPlanId)
  const selectedMessages = selectedPairing
    ? (chatMessages[selectedPairing.id] ?? [])
    : []
  const isRequester = selectedRequest?.requesterUid === userId
  const isPartner = selectedRequest?.partnerUid === userId
  const {
    stakes,
    payoutEmailUids,
    loaded: stakesLoaded,
    error: stakesError,
    refresh: refreshStakes,
  } = useBoatStakes(supabase, selectedRequest)
  const stakesReady =
    selectedRequest !== undefined &&
    stakesLoaded &&
    isStakeAuthorized(
      stakes,
      selectedRequest.requesterUid,
      selectedRequest.requesterBetCents
    ) &&
    isStakeAuthorized(
      stakes,
      selectedRequest.partnerUid,
      selectedRequest.partnerBetCents
    ) &&
    isPayoutReady(
      selectedRequest,
      selectedRequest.requesterUid,
      payoutEmailUids
    ) &&
    isPayoutReady(selectedRequest, selectedRequest.partnerUid, payoutEmailUids)
  const requestIsLive =
    selectedRequest !== undefined &&
    ["pending", "review", "active"].includes(selectedRequest.status)
  const storedResponsePlanId = selectedPairing
    ? selectedResponsePlans[selectedPairing.id]
    : undefined
  const responsePlanId = selectedPairing
    ? boatPlans.some((plan) => plan.id === storedResponsePlanId)
      ? (storedResponsePlanId ?? "")
      : selectedRequest?.status === "review" &&
          isRequester &&
          boatPlans.some((plan) => plan.id === selectedRequest.requesterPlan.id)
        ? selectedRequest.requesterPlan.id
        : (boatPlans[0]?.id ?? "")
    : ""
  useEffect(() => {
    if (!supabase || !userId) return
    const client = supabase
    let ownerLoaded = false
    let partnerLoaded = false
    let plansLoaded = false
    let active = true
    const finishLoading = () => {
      if (ownerLoaded && partnerLoaded && plansLoaded) setIsLoading(false)
    }
    const handleError = (snapshotError: unknown) => {
      setError(getPairingStatusMessage(snapshotError))
      setIsLoading(false)
    }
    async function loadUserData() {
      const [owned, joined, plansResult] = await Promise.all([
        client.from("pairings").select("*").eq("owner_uid", userId),
        client.from("pairings").select("*").eq("partner_uid", userId),
        client.from("planner_plans").select("*").eq("owner_uid", userId),
      ])
      if (!active) return
      if (owned.error || joined.error || plansResult.error) {
        handleError(owned.error ?? joined.error ?? plansResult.error)
        return
      }
      try {
        setOwnedPairings(owned.data.map((item) => parsePairing(item)))
        setJoinedPairings(joined.data.map((item) => parsePairing(item)))
        const plans = plansResult.data.map((planDoc) => {
          const data = planDoc
          if (
            data.owner_uid !== userId ||
            typeof data.title !== "string" ||
            !data.title.trim() ||
            data.title.length > 200 ||
            typeof data.description !== "string" ||
            !data.description.trim() ||
            data.description.length > 2000 ||
            (data.mode !== "casual" &&
              data.mode !== "fire" &&
              data.mode !== "inferno") ||
            typeof data.boat_ready !== "boolean" ||
            typeof data.total_estimated_minutes !== "number" ||
            !Number.isInteger(data.total_estimated_minutes)
          ) {
            throw new AppError(APP_ERRORS.invalid_data)
          }
          return {
            id: planDoc.id,
            title: data.title,
            description: data.description,
            mode: data.mode,
            boatReady: data.boat_ready,
            totalEstimatedMinutes: data.total_estimated_minutes,
            createdAt: parseTimestamp(data.created_at),
          }
        })
        const stepCounts = new Map<string, number>()
        const remainingEstimates = new Map<string, number>()
        if (plans.length > 0) {
          const planIds = plans.map((plan) => plan.id)
          const pageSize = 1000
          for (let offset = 0; ; offset += pageSize) {
            const { data: taskRows, error: taskError } = await client
              .from("planner_tasks")
              .select("plan_id, estimated_minutes, completed")
              .in("plan_id", planIds)
              .range(offset, offset + pageSize - 1)
            if (!active) return
            if (taskError) {
              handleError(taskError)
              return
            }
            taskRows.forEach(({ plan_id, estimated_minutes, completed }) => {
              stepCounts.set(plan_id, (stepCounts.get(plan_id) ?? 0) + 1)
              if (!completed) {
                remainingEstimates.set(
                  plan_id,
                  (remainingEstimates.get(plan_id) ?? 0) + estimated_minutes
                )
              }
            })
            if (taskRows.length < pageSize) break
          }
        }
        const plansWithCounts = plans
          .map((plan) => ({
            ...plan,
            stepCount: stepCounts.get(plan.id) ?? 0,
            remainingEstimatedMinutes: remainingEstimates.get(plan.id) ?? 0,
          }))
          .sort((a, b) => b.createdAt.toMillis() - a.createdAt.toMillis())
        setPlannerPlans(plansWithCounts)
        setSelectedPlanId((current) =>
          plansWithCounts.some(
            (plan) =>
              plan.id === current && plan.stepCount > 0 && plan.boatReady
          )
            ? current
            : (plansWithCounts.find(
                (plan) => plan.stepCount > 0 && plan.boatReady
              )?.id ?? "")
        )
        plansLoaded = true
        ownerLoaded = true
        partnerLoaded = true
        finishLoading()
      } catch (loadError) {
        handleError(loadError)
      }
    }
    const channel = client
      .channel(`home:${userId}`)
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "pairings" },
        () => void loadUserData()
      )
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "planner_plans",
          filter: `owner_uid=eq.${userId}`,
        },
        () => void loadUserData()
      )
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "planner_tasks" },
        () => void loadUserData()
      )
      .subscribe((status) => {
        if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") {
          handleError(new AppError(APP_ERRORS.realtime))
        }
      })
    void loadUserData()
    return () => {
      active = false
      void client.removeChannel(channel)
    }
  }, [supabase, userId])

  useEffect(() => {
    if (!supabase || activePairings.length === 0) return
    const client = supabase
    const requests = new Map<string, BoatRequest>()
    const messages = new Map<string, BoatChatMessage[]>()
    let active = true
    async function loadPairingData() {
      const ids = activePairings.map((pairing) => pairing.id)
      const [requestResult, messageResult] = await Promise.all([
        client.from("boat_requests").select("*").in("id", ids),
        client
          .from("pair_chat_messages")
          .select("*")
          .in("pairing_id", ids)
          .order("created_at"),
      ])
      if (!active) return
      if (requestResult.error || messageResult.error) {
        setActionError(
          getPairingStatusMessage(requestResult.error ?? messageResult.error)
        )
        return
      }
      try {
        requestResult.data.forEach((row) =>
          requests.set(row.id, parseBoatRequest(row))
        )
        const seenMessageIds = new Set<string>()
        messageResult.data.forEach((row) => {
          const item = parseBoatChatMessage(row)
          if (seenMessageIds.has(item.id)) return
          seenMessageIds.add(item.id)
          messages.set(item.cycleId, [
            ...(messages.get(item.cycleId) ?? []),
            item,
          ])
        })
        setBoatRequests(Object.fromEntries(requests))
        setChatMessages(Object.fromEntries(messages))
      } catch (loadError) {
        setActionError(getPairingStatusMessage(loadError))
      }
    }
    const channel = client
      .channel(
        `boat-data:${activePairings.map((pairing) => pairing.id).join(":")}`
      )
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "boat_requests" },
        () => void loadPairingData()
      )
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "pair_chat_messages" },
        () => void loadPairingData()
      )
      .subscribe((status) => {
        if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") {
          setActionError("Unable to subscribe to Supabase updates.")
        }
      })
    void loadPairingData()
    return () => {
      active = false
      void client.removeChannel(channel)
    }
  }, [activePairings, supabase])

  async function onSendMessage(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault()
    if (sendingMessage.current || !supabase || !user || !selectedPairing) {
      return
    }
    const text = chatDraft.trim()
    if (!text || text.length > 2000) return
    sendingMessage.current = true
    setBusyAction("message")
    setActionError(null)
    try {
      await sendBoatChatMessage(supabase, selectedPairing, user.uid, text)
      setChatDraft("")
    } catch (sendError) {
      setActionError(getErrorMessage(sendError, APP_ERRORS.chat_send))
    } finally {
      sendingMessage.current = false
      setBusyAction(null)
    }
  }

  async function onCreateRequest(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault()
    if (
      !supabase ||
      !user ||
      !selectedPairing ||
      !selectedPlan ||
      !selectedPlan.boatReady
    ) {
      setActionError(
        "Ask the planner AI to approve a plan before requesting a boat."
      )
      return
    }
    setBusyAction("request")
    setActionError(null)
    try {
      const betCents = parseBetInput(betInput)
      if (!deadlineDate || !deadlineTime) {
        throw new Error("Pick a deadline at least one hour from now.")
      }
      const deadline = new Date(deadlineDate)
      const [hours, minutes] = deadlineTime.split(":").map(Number)
      deadline.setHours(hours, minutes, 0, 0)
      if (betCents === null) throw new Error("Enter a bet from $0 to $500.")
      if (
        Number.isNaN(deadline.getTime()) ||
        deadline.getTime() < new Date().getTime() + 60 * 60 * 1000
      ) {
        throw new Error("Pick a deadline at least one hour from now.")
      }
      if (
        deadline.getTime() >
        new Date().getTime() + 29 * 24 * 60 * 60 * 1000
      ) {
        throw new Error("The deadline can be at most 29 days away.")
      }
      if (
        betCents > 5000 &&
        deadline.getTime() > new Date().getTime() + 3 * 24 * 60 * 60 * 1000
      ) {
        throw new Error("Boats longer than 3 days allow bets up to $50.")
      }
      const plan = await loadBoatPlan(supabase, selectedPlan)
      await createBoatRequest(supabase, selectedPairing, user.uid, plan, {
        mode: stakeMode,
        deadline,
        betCents,
      })
      setIsRequestComposerOpen(false)
    } catch (requestError) {
      setActionError(getErrorMessage(requestError, APP_ERRORS.request_send))
    } finally {
      setBusyAction(null)
    }
  }

  async function onRecommendPlan() {
    if (!supabase || !selectedRequest || boatPlans.length === 0) return
    const referencePlan =
      selectedRequest.status === "pending"
        ? selectedRequest.requesterPlan
        : selectedRequest.partnerPlan
    if (!referencePlan) {
      setActionError("The partner's plan has not been submitted yet.")
      return
    }
    setRecommendationBusy(true)
    setActionError(null)
    try {
      const candidates = await Promise.all(
        boatPlans.map((plan) => loadBoatPlan(supabase, plan))
      )
      const matchingPlans = candidates.filter((plan) =>
        hasSameDifficulty(plan, referencePlan)
      )
      if (matchingPlans.length === 0) {
        throw new Error("You have no plan in the same workload range.")
      }
      const recommendation = await recommendBoatPlanMatch(
        referencePlan,
        matchingPlans
      )
      setRecommendations((current) => ({
        ...current,
        [selectedRequest.id]: recommendation,
      }))
      setSelectedResponsePlans((current) => ({
        ...current,
        [selectedRequest.id]: recommendation.planId,
      }))
    } catch (recommendError) {
      setActionError(
        getErrorMessage(recommendError, APP_ERRORS.ai_match)
      )
    } finally {
      setRecommendationBusy(false)
    }
  }

  async function onSubmitPartnerPlan() {
    if (!supabase || !user || !selectedRequest || !selectedPairing) return
    const plan = boatPlans.find((item) => item.id === responsePlanId)
    if (!plan) {
      setActionError(
        "Choose a plan with at least one step before responding to this request."
      )
      return
    }
    if (!plan.boatReady || !selectedRequest.requesterPlan.boatReady) {
      setActionError(
        "Both plans must be approved as boat-ready by the planner AI."
      )
      return
    }
    const partnerBetCents = parseBetInput(partnerBetInput)
    if (partnerBetCents === null) {
      setActionError("Enter a bet from $0 to $500.")
      return
    }
    if (
      partnerBetCents > 5000 &&
      selectedRequest.deadlineAt &&
      selectedRequest.deadlineAt.toMillis() -
        selectedRequest.createdAt.toMillis() >
        3 * 24 * 60 * 60 * 1000
    ) {
      setActionError("Boats longer than 3 days allow bets up to $50.")
      return
    }
    setBusyAction("response")
    setActionError(null)
    try {
      const partnerPlanSnapshot = await loadBoatPlan(supabase, plan)
      if (!hasSameDifficulty(partnerPlanSnapshot, selectedRequest.requesterPlan)) {
        throw new Error("Choose a plan in the same workload range.")
      }
      await setPartnerBet(supabase, selectedRequest, partnerBetCents)
      await submitPartnerPlan(
        supabase,
        selectedRequest,
        user.uid,
        partnerPlanSnapshot
      )
    } catch (responseError) {
      setActionError(getErrorMessage(responseError, APP_ERRORS.plan_submit))
    } finally {
      setBusyAction(null)
    }
  }

  async function onDecideRequest(decision: "accept" | "deny") {
    if (!supabase || !user || !selectedRequest) return
    setBusyAction(decision)
    setActionError(null)
    try {
      const plan = boatPlans.find((item) => item.id === responsePlanId)
      let planSnapshot: BoatPlan | undefined
      if (decision === "accept") {
        if (!plan?.boatReady || !selectedRequest.partnerPlan?.boatReady) {
          throw new Error(
            "Both plans must be approved as boat-ready by the planner AI."
          )
        }
        planSnapshot = await loadBoatPlan(supabase, plan)
      }
      const acceptedPlan = planSnapshot ?? selectedRequest.requesterPlan
      if (
        decision === "accept" &&
        selectedRequest.partnerPlan &&
        !hasSameDifficulty(acceptedPlan, selectedRequest.partnerPlan)
      ) {
        throw new Error("Choose a plan in the same workload range.")
      }
      await decideBoatRequest(supabase, selectedRequest, decision, planSnapshot)
    } catch (decisionError) {
      setActionError(getErrorMessage(decisionError, APP_ERRORS.request_update))
    } finally {
      setBusyAction(null)
    }
  }

  async function onCancelRequest() {
    if (!supabase || !user || !selectedRequest) return
    setBusyAction("cancel")
    setActionError(null)
    try {
      await cancelBoatRequest(supabase, selectedRequest)
    } catch (cancelError) {
      setActionError(getErrorMessage(cancelError, APP_ERRORS.request_cancel))
    } finally {
      setBusyAction(null)
    }
  }

  async function onForfeitRequest() {
    if (!supabase || !user || !selectedRequest) return
    setBusyAction("forfeit")
    setActionError(null)
    try {
      await forfeitBoatRequest(supabase, selectedRequest)
      setBoatRequests((current) => {
        const request = current[selectedRequest.id]
        if (!request || request.cycleId !== selectedRequest.cycleId) return current
        return {
          ...current,
          [request.id]: {
            ...request,
            ...(request.requesterUid === user.uid
              ? { requesterForfeited: true }
              : { partnerForfeited: true }),
          },
        }
      })
      setIsForfeitOpen(false)
    } catch (forfeitError) {
      setIsForfeitOpen(false)
      setActionError(getErrorMessage(forfeitError, APP_ERRORS.request_update))
    } finally {
      setBusyAction(null)
    }
  }

  if (!supabase || !user) {
    return (
      <main className="mx-auto flex w-full max-w-3xl flex-col gap-4 p-6">
        <h1 className="text-3xl font-semibold">Home</h1>
        <p role="alert" className="text-sm text-destructive">
          Unable to load your account. Please sign in and try again.
        </p>
      </main>
    )
  }

  if (isLoading) {
    return (
      <main
        className="mx-auto flex w-full max-w-3xl flex-col gap-4 p-6"
        role="status"
        aria-label="Loading home"
      >
        <Skeleton className="h-10 w-64" />
        <Skeleton className="h-36 w-full" />
      </main>
    )
  }

  if (error) {
    return (
      <main className="mx-auto flex w-full max-w-3xl flex-col gap-4 p-6">
        <h1 className="text-3xl font-semibold">Home</h1>
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      </main>
    )
  }

  return (
    <main className="mx-auto flex w-full max-w-3xl flex-col gap-6 p-6 md:p-10">
      <header className="flex items-center justify-between gap-4">
        <h1 className="text-3xl font-semibold tracking-tight">Home</h1>
      </header>
      {displayNamesUnavailable && (
        <p role="status" className="text-sm text-muted-foreground">
          Account names are unavailable. Showing user IDs instead.
        </p>
      )}

      <section className="flex flex-col gap-4">
        <header className="flex flex-col gap-1">
          <h2 className="text-xl font-semibold">Chat with a partner</h2>
          <p className="text-sm text-muted-foreground">
            Choose a partner to open your conversation.
          </p>
        </header>
        {activePairings.length > 0 ? (
          <div className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,16rem),1fr))] gap-4">
            {activePairings.map((pairing) => {
              const partnerName = getProfileDisplayName(
                getPairingPartnerUid(pairing, user.uid),
                displayNames
              )
              const request = boatRequests[pairing.id]
              const requestStatus = request
                ? {
                    pending: "Boat request pending",
                    review: "Plan ready for review",
                    active: "Boat plan active",
                    completed: "Boat finished",
                    denied: "Request declined",
                    cancelled: "Request cancelled",
                  }[request.status]
                : "Open your conversation"

              return (
                <button
                  key={pairing.id}
                  type="button"
                  className="rounded-xl text-left outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
                  aria-label={`Open chat with ${partnerName}`}
                  onClick={() => {
                    setSelectedPartnerId(pairing.id)
                    setActionError(null)
                    setIsChatOpen(true)
                  }}
                >
                  <Card className="h-full transition-colors hover:bg-muted/40">
                    <CardHeader className="grid-cols-[1fr_auto] items-center gap-3">
                      <div className="flex min-w-0 flex-col gap-1">
                        <CardTitle className="truncate">
                          {partnerName}
                        </CardTitle>
                        <CardDescription>{requestStatus}</CardDescription>
                      </div>
                      <MessageCircle
                        aria-hidden="true"
                        className="shrink-0 text-muted-foreground"
                      />
                    </CardHeader>
                  </Card>
                </button>
              )
            })}
          </div>
        ) : (
          <Card>
            <CardContent className="flex flex-col items-center gap-3 py-8 text-center">
              <HandshakeIcon className="text-muted-foreground" />
              <p className="font-medium">No partners yet</p>
              <p className="text-sm text-muted-foreground">
                Pair with someone to start chatting and plan together.
              </p>
              <Link to="/pairing" className={buttonVariants()}>
                Manage partners
              </Link>
            </CardContent>
          </Card>
        )}
      </section>

      <Dialog
        open={isChatOpen}
        onOpenChange={(open) => {
          setIsChatOpen(open)
          if (!open) {
            setIsForfeitOpen(false)
            setIsRequestComposerOpen(false)
            setActionError(null)
          }
        }}
      >
        <DialogContent className="flex max-h-[85vh] flex-col overflow-y-auto sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>
              {selectedPairing
                ? getProfileDisplayName(
                    getPairingPartnerUid(selectedPairing, user.uid),
                    displayNames
                  )
                : "Partner chat"}
            </DialogTitle>
            <DialogDescription>
              Chat freely, or start a boat request when you are ready.
            </DialogDescription>
          </DialogHeader>
          {actionError && (
            <FieldError className="rounded-lg border border-destructive/40 bg-destructive/10 p-3 font-medium">
              {actionError}
            </FieldError>
          )}

          {selectedPairing && (
            <div className="flex min-h-0 flex-col gap-3">
              {selectedRequest && (
                <section className="flex flex-col gap-2 rounded-lg border bg-muted/30 p-3">
                  <div className="flex items-center justify-between gap-3">
                    <div className="text-sm">
                      <p className="font-medium">
                        {selectedRequest.status === "pending" &&
                          (isRequester
                            ? "Boat request sent"
                            : "Incoming boat request")}
                        {selectedRequest.status === "review" &&
                          (isRequester
                            ? "Plan proposal to review"
                            : "Plan submitted")}
                        {selectedRequest.status === "active" && "Boat active"}
                        {selectedRequest.status === "completed" &&
                          "Boat finished"}
                        {selectedRequest.status === "denied" &&
                          "Request declined"}
                        {selectedRequest.status === "cancelled" &&
                          "Request cancelled"}
                      </p>
                      <p className="text-muted-foreground">
                        {selectedRequest.requesterPlan.title}
                        {selectedRequest.partnerPlan &&
                          ` · ${selectedRequest.partnerPlan.title}`}
                      </p>
                    </div>
                    {isRequester &&
                      ["pending", "review"].includes(
                        selectedRequest.status
                      ) && (
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          disabled={busyAction === "cancel"}
                          onClick={() => void onCancelRequest()}
                        >
                          {busyAction === "cancel" ? (
                            <LoaderCircle
                              className="animate-spin"
                              data-icon="inline-start"
                            />
                          ) : (
                            <X data-icon="inline-start" aria-hidden="true" />
                          )}
                          Cancel
                        </Button>
                      )}
                  </div>
                  {selectedRequest.partnerPlan && (
                    <p className="text-xs text-muted-foreground">
                      Compare: {selectedRequest.requesterPlan.tasks.length} vs{" "}
                      {selectedRequest.partnerPlan.tasks.length} steps ·{" "}
                      {selectedRequest.requesterPlan.totalEstimatedMinutes} vs{" "}
                      {selectedRequest.partnerPlan.totalEstimatedMinutes} min
                    </p>
                  )}
                  {selectedRequest.status === "pending" &&
                    isPartner &&
                    boatPlans.length === 0 && (
                      <div
                        role="alert"
                        className="flex flex-col gap-3 rounded-lg border border-primary/30 bg-primary/5 p-4 sm:flex-row sm:items-center sm:justify-between"
                      >
                        <div className="flex items-start gap-3">
                          <Info
                            aria-hidden="true"
                            className="mt-0.5 size-5 shrink-0 text-primary"
                          />
                          <div className="flex flex-col gap-1">
                            <p className="font-medium">
                              {plannerPlans.length === 0
                                ? "You need a plan to respond"
                                : "You need a boat-ready plan"}
                            </p>
                            <p className="text-sm text-muted-foreground">
                              Create a plan with steps, then ask the planner AI
                              to approve it for a boat.
                            </p>
                          </div>
                        </div>
                        <Link
                          to="/planner"
                          className={buttonVariants({
                            variant: "outline",
                            size: "sm",
                          })}
                        >
                          Open Planner
                        </Link>
                      </div>
                    )}
                  {selectedRequest.deadlineAt && (
                    <div className="flex flex-col gap-1 rounded-lg border bg-muted/40 p-3 text-sm">
                      <p className="font-medium">
                        {selectedRequest.stakeMode === "racing"
                          ? "Racing"
                          : "Collaborate"}{" "}
                        · due{" "}
                        {selectedRequest.deadlineAt
                          .toDate()
                          .toLocaleString([], {
                            dateStyle: "medium",
                            timeStyle: "short",
                          })}
                      </p>
                      <p className="text-muted-foreground">
                        {isRequester ? "You" : "They"} bet{" "}
                        {formatBet(selectedRequest.requesterBetCents)} ·{" "}
                        {isRequester ? "they" : "you"} bet{" "}
                        {selectedRequest.status === "pending"
                          ? "PENDING"
                          : formatBet(selectedRequest.partnerBetCents)}
                      </p>
                    </div>
                  )}
                  {selectedRequest.status === "active" && (
                    <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
                      <div className="text-muted-foreground">
                        {(isRequester
                          ? selectedRequest.requesterForfeited
                          : selectedRequest.partnerForfeited) && <p>You forfeited.</p>}
                        {(isRequester
                          ? selectedRequest.partnerForfeited
                          : selectedRequest.requesterForfeited) && <p>Your partner forfeited.</p>}
                        {(selectedRequest.requesterForfeited ||
                          selectedRequest.partnerForfeited) && (
                          <p>
                            A new boat request will be available once this boat&apos;s
                            outcome is decided and settlement completes.
                            {selectedRequest.requesterForfeited &&
                              selectedRequest.partnerForfeited &&
                              " Both forfeits decide the outcome; settlement normally runs every five minutes."}
                            {!(selectedRequest.requesterForfeited &&
                              selectedRequest.partnerForfeited) &&
                              " The remaining participant can finish their plan, or wait until the deadline."}
                          </p>
                        )}
                      </div>
                      {(isRequester || isPartner) &&
                        !(isRequester
                          ? selectedRequest.requesterForfeited
                          : selectedRequest.partnerForfeited) && (
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            disabled={busyAction !== null}
                            onClick={() => setIsForfeitOpen(true)}
                          >
                            Forfeit
                          </Button>
                        )}
                      <AlertDialog open={isForfeitOpen} onOpenChange={setIsForfeitOpen}>
                        <AlertDialogContent>
                          <AlertDialogHeader>
                            <AlertDialogTitle>Forfeit this boat?</AlertDialogTitle>
                            <AlertDialogDescription>
                              This cannot be undone. Your partner can still finish their plan.
                              Your bet may be charged and paid to them. If both of you lose,
                              each bet may be charged and paid to the other participant.
                              You can request another boat with this partner after the
                              outcome is decided and settlement completes.
                            </AlertDialogDescription>
                          </AlertDialogHeader>
                          <AlertDialogFooter>
                            <AlertDialogCancel disabled={busyAction === "forfeit"}>
                              Keep going
                            </AlertDialogCancel>
                            <Button
                              type="button"
                              variant="destructive"
                              disabled={busyAction === "forfeit"}
                              onClick={() => void onForfeitRequest()}
                            >
                              {busyAction === "forfeit" && (
                                <LoaderCircle className="animate-spin" data-icon="inline-start" />
                              )}
                              Forfeit
                            </Button>
                          </AlertDialogFooter>
                        </AlertDialogContent>
                      </AlertDialog>
                    </div>
                  )}
                  {supabase && userId && selectedRequest.deadlineAt && (
                    stakesError ? (
                      <div className="flex flex-col items-start gap-2">
                        <p role="alert" className="text-sm text-destructive">{stakesError}</p>
                        <Button type="button" variant="outline" onClick={() => void refreshStakes()}>
                          Retry payment details
                        </Button>
                      </div>
                    ) : stakesLoaded ? (
                      <StakePayment
                        key={`${selectedRequest.id}:${selectedRequest.cycleId}`}
                        supabase={supabase}
                        request={selectedRequest}
                        userId={userId}
                        stakes={stakes}
                        payoutEmailUids={payoutEmailUids}
                        onChanged={() => void refreshStakes()}
                      />
                    ) : (
                      <p role="status" className="text-sm text-muted-foreground">
                        Loading payment details…
                      </p>
                    )
                  )}
                  <div className="grid gap-2 text-xs sm:grid-cols-2">
                    {[
                      selectedRequest.requesterPlan,
                      selectedRequest.partnerPlan,
                    ]
                      .filter((plan): plan is BoatPlan => plan !== null)
                      .map((plan) => (
                        <div key={plan.id}>
                          <details>
                            <summary className="cursor-pointer font-medium">
                              {plan.title} · {plan.tasks.length} steps
                            </summary>
                            <ol className="mt-1 flex list-inside list-decimal flex-col gap-1 text-muted-foreground">
                              {plan.tasks.map((task) => (
                                <li key={task.id}>
                                  {task.title} · {task.estimatedMinutes} min
                                </li>
                              ))}
                            </ol>
                          </details>
                        </div>
                      ))}
                  </div>

                  {selectedRequest.status === "pending" &&
                    isPartner &&
                    boatPlans.length > 0 && (
                      <>
                        <p className="text-xs text-muted-foreground">
                          Submitting a boat-ready plan accepts the pairing from
                          your side. The requester must accept too before both
                          plans become permanent Inferno plans.
                        </p>
                        <Field>
                          <FieldLabel htmlFor="partner-bet">
                            Your bet in USD (optional, $0 to $500)
                          </FieldLabel>
                          <Input
                            id="partner-bet"
                            type="number"
                            min="0"
                            max="500"
                            step="0.01"
                            inputMode="decimal"
                            placeholder="0"
                            value={partnerBetInput}
                            onChange={(event) =>
                              setPartnerBetInput(event.target.value)
                            }
                          />
                        </Field>
                        <FieldGroup className="flex flex-col gap-2">
                          <Field>
                            <FieldLabel htmlFor="partner-plan">
                              Your matching plan
                            </FieldLabel>
                            <div className="flex flex-row gap-2">
                              <Select
                                items={planSelectItems}
                                value={responsePlanId}
                                onValueChange={(value) =>
                                  setSelectedResponsePlans((current) => ({
                                    ...current,
                                    [selectedPairing.id]: value ?? "",
                                  }))
                                }
                              >
                                <SelectTrigger
                                  id="partner-plan"
                                  className="w-full"
                                >
                                  <SelectValue placeholder="Choose a plan" />
                                </SelectTrigger>
                                <SelectContent>
                                  <SelectGroup>
                                    {boatPlans.map((plan) => (
                                      <SelectItem key={plan.id} value={plan.id}>
                                        {plan.title} ·{" "}
                                        {plan.remainingEstimatedMinutes} min remaining
                                      </SelectItem>
                                    ))}
                                  </SelectGroup>
                                </SelectContent>
                              </Select>
                              <Button
                                type="button"
                                variant="secondary"
                                disabled={
                                  recommendationBusy || busyAction !== null
                                }
                                onClick={() => void onRecommendPlan()}
                              >
                                {recommendationBusy ? (
                                  <LoaderCircle
                                    className="animate-spin"
                                    data-icon="inline-start"
                                  />
                                ) : null}
                                AI pick
                              </Button>
                            </div>
                          </Field>

                          <div className="flex flex-wrap justify-end gap-2">
                            <Button
                              type="button"
                              variant="outline"
                              disabled={
                                busyAction !== null ||
                                selectedRequest.status !== "pending" ||
                                !isPartner
                              }
                              onClick={() => void onDecideRequest("deny")}
                            >
                              {busyAction === "deny" ? (
                                <LoaderCircle
                                  className="animate-spin"
                                  data-icon="inline-start"
                                />
                              ) : null}
                              Deny boat
                            </Button>
                            <Button
                              type="button"
                              disabled={!responsePlanId || busyAction !== null}
                              onClick={() => void onSubmitPartnerPlan()}
                            >
                              {busyAction === "response" ? (
                                <LoaderCircle
                                  className="animate-spin"
                                  data-icon="inline-start"
                                />
                              ) : null}
                              Accept boat
                            </Button>
                          </div>
                        </FieldGroup>
                      </>
                    )}

                  {selectedRequest.status === "review" &&
                    isRequester &&
                    selectedRequest.partnerPlan && (
                      <>
                        <p className="text-xs text-muted-foreground">
                          Accepting makes both boat-ready plans permanent
                          Inferno plans. Denying rejects the boat request.
                        </p>
                        <FieldGroup className="flex flex-col gap-2">
                          <Field>
                            <FieldLabel htmlFor="requester-plan">
                              Your plan
                            </FieldLabel>
                            <Select
                              items={planSelectItems}
                              value={responsePlanId}
                              onValueChange={(value) =>
                                setSelectedResponsePlans((current) => ({
                                  ...current,
                                  [selectedPairing.id]: value ?? "",
                                }))
                              }
                            >
                              <SelectTrigger
                                id="requester-plan"
                                className="w-full"
                              >
                                <SelectValue placeholder="Choose plan" />
                              </SelectTrigger>
                              <SelectContent>
                                <SelectGroup>
                                  {boatPlans.map((plan) => (
                                    <SelectItem key={plan.id} value={plan.id}>
                                      {plan.title} ·{" "}
                                      {plan.remainingEstimatedMinutes} min remaining
                                    </SelectItem>
                                  ))}
                                </SelectGroup>
                              </SelectContent>
                            </Select>
                          </Field>
                          <div className="flex flex-wrap justify-end gap-2">
                            <Button
                              type="button"
                              variant="outline"
                              disabled={
                                recommendationBusy ||
                                boatPlans.length === 0 ||
                                busyAction !== null
                              }
                              onClick={() => void onRecommendPlan()}
                            >
                              AI pick
                            </Button>
                            <Button
                              type="button"
                              variant="outline"
                              disabled={busyAction !== null}
                              onClick={() => void onDecideRequest("deny")}
                            >
                              Deny
                            </Button>
                            <Button
                              type="button"
                              disabled={
                                busyAction !== null ||
                                !boatPlans.some(
                                  (plan) => plan.id === responsePlanId
                                ) ||
                                !selectedRequest.partnerPlan.boatReady ||
                                !stakesReady
                              }
                              onClick={() => void onDecideRequest("accept")}
                            >
                              {busyAction === "accept" ? (
                                <LoaderCircle
                                  className="animate-spin"
                                  data-icon="inline-start"
                                />
                              ) : (
                                <Check data-icon="inline-start" aria-hidden />
                              )}
                              Accept
                            </Button>
                          </div>
                        </FieldGroup>
                      </>
                    )}

                  {recommendations[selectedRequest.id] && (
                    <p className="text-xs text-muted-foreground">
                      AI pick:{" "}
                      {
                        boatPlans.find(
                          (plan) =>
                            plan.id ===
                            recommendations[selectedRequest.id].planId
                        )?.title
                      }{" "}
                      — {recommendations[selectedRequest.id].reason}
                    </p>
                  )}
                  {selectedRequest.status === "review" && isPartner && (
                    <p className="text-xs text-muted-foreground">
                      Waiting for the requester to accept or deny your plan.
                    </p>
                  )}
                </section>
              )}

              {selectedRequest?.status === "active" && (
                <p className="text-xs text-muted-foreground">
                  {selectedRequest.requesterPlan.title} with{" "}
                  {selectedRequest.partnerPlan?.title}. Keep coordinating here.
                </p>
              )}

              {!requestIsLive && boatPlans.length === 0 && (
                <div
                  role="status"
                  className="flex flex-col gap-3 rounded-lg border border-primary/30 bg-primary/5 p-4 sm:flex-row sm:items-center sm:justify-between"
                >
                  <div className="flex items-start gap-3">
                    <Info
                      aria-hidden="true"
                      className="mt-0.5 size-5 shrink-0 text-primary"
                    />
                    <div className="flex flex-col gap-1">
                      <p className="font-medium">
                        {plannerPlans.length === 0
                          ? "No plans yet"
                          : "No boat-ready plans yet"}
                      </p>
                      <p className="text-sm text-muted-foreground">
                        {plannerPlans.length === 0
                          ? "Create a plan with steps, then ask the planner AI to approve it for a boat."
                          : "Ask the planner AI in chat to review a plan before it can be used for a boat request."}
                      </p>
                    </div>
                  </div>
                  <Link
                    to="/planner"
                    className={buttonVariants({
                      variant: "outline",
                      size: "sm",
                    })}
                  >
                    {plannerPlans.length === 0
                      ? "Create a plan"
                      : "Open Planner"}
                  </Link>
                </div>
              )}

              {isRequestComposerOpen && !requestIsLive && (
                <form
                  id="boat-request-form"
                  className="flex flex-col gap-2 rounded-lg border p-3"
                  onSubmit={(event) => void onCreateRequest(event)}
                >
                  <Field className="flex-1">
                    <FieldLabel htmlFor="request-plan">Your plan</FieldLabel>
                    <Select
                      items={planSelectItems}
                      value={selectedPlanId}
                      onValueChange={(value) => setSelectedPlanId(value ?? "")}
                    >
                      <SelectTrigger id="request-plan" className="w-full">
                        <SelectValue placeholder="Choose a plan" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectGroup>
                          {boatPlans.map((plan) => (
                            <SelectItem key={plan.id} value={plan.id}>
                              {plan.title} · {plan.remainingEstimatedMinutes} min remaining ·{" "}
                              {getPlanDifficulty(plan)}
                            </SelectItem>
                          ))}
                        </SelectGroup>
                      </SelectContent>
                    </Select>
                  </Field>
                  <div className="grid gap-2 sm:grid-cols-2">
                    <Field>
                      <FieldLabel>Mode</FieldLabel>
                      <div className="grid grid-cols-2 gap-2">
                        {(["collaborate", "racing"] as const).map((mode) => (
                          <Button
                            key={mode}
                            type="button"
                            variant={stakeMode === mode ? "default" : "outline"}
                            aria-pressed={stakeMode === mode}
                            onClick={() => setStakeMode(mode)}
                          >
                            {mode === "racing" ? "Racing" : "Collaborate"}
                          </Button>
                        ))}
                      </div>
                    </Field>
                    <FieldGroup className="grid gap-2 sm:grid-cols-2">
                      <Field>
                        <FieldLabel htmlFor="request-deadline-date">
                          Deadline date
                        </FieldLabel>
                        <Popover
                          open={isDeadlineCalendarOpen}
                          onOpenChange={setIsDeadlineCalendarOpen}
                        >
                          <PopoverTrigger
                            render={
                              <Button
                                id="request-deadline-date"
                                type="button"
                                variant="outline"
                                className="w-full justify-start overflow-hidden text-left font-normal"
                                aria-required="true"
                                aria-label={
                                  deadlineDate
                                    ? `Deadline date: ${format(deadlineDate, "PPP")}`
                                    : "Choose deadline date"
                                }
                              />
                            }
                          >
                            <CalendarIcon data-icon="inline-start" />
                            {deadlineDate
                              ? format(deadlineDate, "PPP")
                              : "Pick a date"}
                          </PopoverTrigger>
                          <PopoverContent align="start" className="w-auto p-0">
                            <Calendar
                              mode="single"
                              selected={deadlineDate}
                              onSelect={(date) => {
                                setDeadlineDate(date)
                                setIsDeadlineCalendarOpen(false)
                              }}
                              disabled={{
                                before: startOfDay(new Date()),
                                after: addDays(startOfDay(new Date()), 29),
                              }}
                            />
                          </PopoverContent>
                        </Popover>
                      </Field>
                      <Field>
                        <FieldLabel htmlFor="request-deadline-time">
                          Deadline time
                        </FieldLabel>
                        <InputGroup>
                          <InputGroupInput
                            id="request-deadline-time"
                            type="time"
                            step="1"
                            aria-required="true"
                            className="appearance-none overflow-hidden [&::-webkit-calendar-picker-indicator]:hidden [&::-webkit-calendar-picker-indicator]:appearance-none"
                            value={deadlineTime}
                            onChange={(event) =>
                              setDeadlineTime(event.target.value)
                            }
                          />
                          <InputGroupAddon>
                            <Clock2Icon className="text-muted-foreground" />
                          </InputGroupAddon>
                        </InputGroup>
                      </Field>
                    </FieldGroup>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    {stakeMode === "racing"
                      ? "First to finish wins. The slower one loses their bet. If nobody finishes, each bet goes to the other person."
                      : "Finish by the deadline to keep your bet. If only one finishes, the other pays their bet. If nobody finishes, each bet goes to the other person."}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    PayPal only guarantees a hold for about 3 days. Deadlines
                    longer than that cap bets at $50 and carry a risk that the
                    payment cannot be collected when you lose.
                  </p>
                  <Field>
                    <FieldLabel htmlFor="request-bet">
                      Your bet in USD (optional, $0 to $500)
                    </FieldLabel>
                    <Input
                      id="request-bet"
                      type="number"
                      min="0"
                      max="500"
                      step="0.01"
                      inputMode="decimal"
                      placeholder="0"
                      value={betInput}
                      onChange={(event) => setBetInput(event.target.value)}
                    />
                  </Field>
                  <div className="flex flex-wrap justify-end gap-2">
                    <Button
                      type="submit"
                      disabled={
                        !selectedPlan ||
                        !selectedPlan.boatReady ||
                        busyAction !== null
                      }
                    >
                      {busyAction === "request" ? (
                        <LoaderCircle
                          className="animate-spin"
                          data-icon="inline-start"
                        />
                      ) : (
                        <Send data-icon="inline-start" aria-hidden="true" />
                      )}
                      Send request
                    </Button>
                  </div>
                </form>
              )}

              <MessageScrollerProvider>
                <MessageScroller className="h-64 min-h-48 shrink-0 rounded-lg border">
                  <MessageScrollerViewport>
                    <MessageScrollerContent className="gap-3 p-3">
                      {selectedMessages.length === 0 ? (
                        <MessageScrollerItem>
                          <p className="py-12 text-center text-sm text-muted-foreground">
                            No messages yet. Say hello, or send a boat request
                            from this chat.
                          </p>
                        </MessageScrollerItem>
                      ) : (
                        selectedMessages.map((message, index) => {
                          const mine = message.senderUid === user.uid
                          return (
                            <MessageScrollerItem
                              key={message.id}
                              scrollAnchor={
                                index === selectedMessages.length - 1
                              }
                            >
                              <Message align={mine ? "end" : "start"}>
                                <MessageGroup>
                                  <MessageContent>
                                    <MessageHeader>
                                      {getProfileDisplayName(
                                        message.senderUid,
                                        displayNames
                                      )}
                                    </MessageHeader>
                                    <Bubble
                                      align={mine ? "end" : "start"}
                                      variant={mine ? "default" : "secondary"}
                                    >
                                      <BubbleContent>
                                        {message.text}
                                      </BubbleContent>
                                    </Bubble>
                                    <MessageFooter>
                                      {message.createdAt
                                        .toDate()
                                        .toLocaleString()}
                                    </MessageFooter>
                                  </MessageContent>
                                </MessageGroup>
                              </Message>
                            </MessageScrollerItem>
                          )
                        })
                      )}
                    </MessageScrollerContent>
                  </MessageScrollerViewport>
                </MessageScroller>
              </MessageScrollerProvider>

              <form
                className="flex flex-col gap-1"
                onSubmit={(event) => void onSendMessage(event)}
              >
                <Field>
                  <div className="relative">
                    <Textarea
                      id="chat-message"
                      aria-label="Message"
                      className={cn(
                        !requestIsLive && boatPlans.length > 0 && "pl-11"
                      )}
                      value={chatDraft}
                      maxLength={2000}
                      rows={2}
                      placeholder="Write a message..."
                      onChange={(event) => setChatDraft(event.target.value)}
                      onKeyDown={(event) => {
                        if (
                          event.key !== "Enter" ||
                          event.shiftKey ||
                          event.nativeEvent.isComposing
                        ) {
                          return
                        }
                        event.preventDefault()
                        if (busyAction !== "message" && chatDraft.trim()) {
                          event.currentTarget.form?.requestSubmit()
                        }
                      }}
                      disabled={busyAction === "message"}
                      aria-describedby="chat-message-hint"
                    />
                    {!requestIsLive && boatPlans.length > 0 && (
                      <Button
                        type="button"
                        size="icon-sm"
                        variant="ghost"
                        aria-label={
                          isRequestComposerOpen
                            ? "Close boat request form"
                            : "Open boat request form"
                        }
                        aria-expanded={isRequestComposerOpen}
                        aria-controls="boat-request-form"
                        title={
                          isRequestComposerOpen
                            ? "Close boat request form"
                            : "Request a boat"
                        }
                        className="absolute top-2 left-2"
                        onClick={() =>
                          setIsRequestComposerOpen((isOpen) => !isOpen)
                        }
                      >
                        {isRequestComposerOpen ? (
                          <X aria-hidden="true" />
                        ) : (
                          <HandshakeIcon aria-hidden="true" />
                        )}
                      </Button>
                    )}
                  </div>
                </Field>
              </form>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </main>
  )
}
