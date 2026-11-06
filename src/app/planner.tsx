import { useMemo, useRef, useState, useEffect, type SubmitEvent } from "react"
import type { SupabaseClient } from "@supabase/supabase-js"
import type { Part } from "@google/genai"
import { Streamdown } from "streamdown"
import {
  ArrowDown,
  ArrowUp,
  Bot,
  Check,
  ChevronDown,
  ChevronRight,
  FileTextIcon,
  LockKeyhole,
  MessageCircle,
  Plus,
  Pencil,
  Trash2,
  UserRound,
  XIcon,
  LoaderCircle,
  Clock3,
  Flame,
  ListCheck,
} from "lucide-react"
import type { User } from "@/lib/auth"
import { useSearchParams } from "react-router-dom"
import { Avatar, AvatarFallback } from "@/components/ui/avatar"
import {
  Attachment,
  AttachmentAction,
  AttachmentActions,
  AttachmentContent,
  AttachmentMedia,
  AttachmentTitle,
} from "@/components/ui/attachment"
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupTextarea,
} from "@/components/ui/input-group"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader } from "@/components/ui/card"
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
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Checkbox } from "@/components/ui/checkbox"
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSet,
} from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet"
import { Separator } from "@/components/ui/separator"
import { Bubble, BubbleContent } from "@/components/ui/bubble"
import { Message, MessageAvatar, MessageContent } from "@/components/ui/message"
import {
  MessageScroller,
  MessageScrollerButton,
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerProvider,
  MessageScrollerViewport,
} from "@/components/ui/message-scroller"
import { Marker, MarkerContent, MarkerIcon } from "@/components/ui/marker"
import {
  chatWithPlannerAdvisor,
  generatePlannerTask,
  isStringArray,
  revisePlannerTask,
  uploadPromptFile,
  verifyPlannerTaskCompletion,
  type PlannerSubtask,
} from "@/lib/ai"
import { APP_ERRORS, AppError, getErrorMessage } from "@/lib/errors"
import { DbTimestamp, parseTimestamp } from "@/lib/supabase"

type PlannerTaskRow = PlannerSubtask & {
  documentId: string
  completed: boolean
  position: number
}

type ChatMessage = {
  id: string
  role: "user" | "assistant"
  text: string
}

type PromptFile = {
  id: string
  file: File
}

type SavedPlan = {
  id: string
  description: string
  title: string
  totalEstimatedMinutes: number
  createdAt: DbTimestamp
  mode: "casual" | "fire" | "inferno"
  boatReady: boolean
}

type TaskDraft = {
  title: string
  estimatedMinutes: string
  category: string
  dependsOn: string[]
}

const MAX_PLAN_TASKS = 50
const MAX_PLAN_POSITION = 1_000_000
const MAX_PLAN_ESTIMATED_MINUTES = 100000

function parseSavedPlan(
  id: string,
  data: Record<string, unknown>,
  ownerUid: string
): SavedPlan {
  const title = data.title

  if (
    data.owner_uid !== ownerUid ||
    typeof data.description !== "string" ||
    !data.description.trim() ||
    data.description.length > 2000 ||
    typeof title !== "string" ||
    !title.trim() ||
    title.length > 200 ||
    typeof data.total_estimated_minutes !== "number" ||
    !Number.isInteger(data.total_estimated_minutes) ||
    data.total_estimated_minutes < 0 ||
    data.total_estimated_minutes > 100000 ||
    typeof data.created_at !== "string" ||
    typeof data.boat_ready !== "boolean" ||
    (data.mode !== "casual" && data.mode !== "fire" && data.mode !== "inferno")
  ) {
    throw new AppError(APP_ERRORS.invalid_data)
  }

  return {
    id,
    description: data.description,
    title,
    totalEstimatedMinutes: data.total_estimated_minutes,
    createdAt: parseTimestamp(data.created_at),
    mode: data.mode,
    boatReady: data.boat_ready,
  }
}

function parseSavedTask(
  id: string,
  data: Record<string, unknown>
): PlannerTaskRow {
  const position = data.position
  const dependsOn = data.depends_on

  if (
    id !== data.id ||
    typeof data.id !== "string" ||
    !/^[a-zA-Z0-9_-]{1,80}$/.test(data.id) ||
    typeof data.title !== "string" ||
    !data.title.trim() ||
    data.title.length > 500 ||
    typeof data.estimated_minutes !== "number" ||
    !Number.isInteger(data.estimated_minutes) ||
    data.estimated_minutes < 1 ||
    data.estimated_minutes > 10000 ||
    typeof data.category !== "string" ||
    !data.category.trim() ||
    data.category.length > 100 ||
    !isStringArray(dependsOn) ||
    dependsOn.length > 8 ||
    dependsOn.some(
      (dependencyId) => !/^[a-zA-Z0-9_-]{1,80}$/.test(dependencyId)
    ) ||
    new Set(dependsOn).size !== dependsOn.length ||
    typeof position !== "number" ||
    !Number.isInteger(position) ||
    position < 0 ||
    position >= MAX_PLAN_POSITION ||
    typeof data.completed !== "boolean" ||
    typeof data.created_at !== "string" ||
    typeof data.updated_at !== "string"
  ) {
    throw new AppError(APP_ERRORS.invalid_data)
  }

  return {
    id: data.id,
    documentId: id,
    title: data.title,
    estimatedMinutes: data.estimated_minutes,
    category: data.category,
    dependsOn,
    completed: data.completed,
    position,
  }
}

function validateTaskDependencies(tasks: PlannerTaskRow[]) {
  const taskById = new Map(tasks.map((task) => [task.id, task]))

  if (
    tasks.some((task) =>
      task.dependsOn.some((dependencyId) => {
        const dependency = taskById.get(dependencyId)
        return (
          !dependency ||
          dependency.position >= task.position ||
          (task.completed && !dependency.completed)
        )
      })
    )
  ) {
    throw new AppError(APP_ERRORS.invalid_data)
  }
}

function formatDuration(minutes: number) {
  const hours = Math.floor(minutes / 60)
  const remainingMinutes = minutes % 60
  if (hours === 0) return `${minutes} min`
  if (remainingMinutes === 0) return `${hours} hr`
  return `${hours} hr ${remainingMinutes} min`
}

type PlannerPageProps = {
  supabase: SupabaseClient
  user: User
}

export default function PlannerPage({ supabase, user }: PlannerPageProps) {
  const [searchParams] = useSearchParams()
  const requestedPlanId = searchParams.get("plan")
  const [objective, setObjective] = useState("")
  const [promptFiles, setPromptFiles] = useState<PromptFile[]>([])
  const [rows, setRows] = useState<PlannerTaskRow[]>([])
  const [selectedCategory, setSelectedCategory] = useState<string | null>(null)
  const [savedPlans, setSavedPlans] = useState<SavedPlan[]>([])
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([])
  const [selectedPlanId, setSelectedPlanId] = useState<string | null>(null)
  const [expandedPlanId, setExpandedPlanId] = useState<string | null>(null)
  const [isChatOpen, setIsChatOpen] = useState(false)
  const [isLoadingPlans, setIsLoadingPlans] = useState(true)
  const [isLoadingTasks, setIsLoadingTasks] = useState(false)
  const [isGenerating, setIsGenerating] = useState(false)
  const [generationStatus, setGenerationStatus] = useState<string | null>(null)
  const [generationError, setGenerationError] = useState<string | null>(null)
  const [plansError, setPlansError] = useState<string | null>(null)
  const [tasksError, setTasksError] = useState<string | null>(null)
  const [taskUpdateError, setTaskUpdateError] = useState<string | null>(null)
  const [isPlanEditorOpen, setIsPlanEditorOpen] = useState(false)
  const [isCreatePlanOpen, setIsCreatePlanOpen] = useState(false)
  const [isCreatingPlan, setIsCreatingPlan] = useState(false)
  const [isFireConfirmOpen, setIsFireConfirmOpen] = useState(false)
  const [isMakingFire, setIsMakingFire] = useState(false)
  const [fireModeError, setFireModeError] = useState<string | null>(null)
  const [isInfernoConfirmOpen, setIsInfernoConfirmOpen] = useState(false)
  const [isMakingInferno, setIsMakingInferno] = useState(false)
  const [infernoModeError, setInfernoModeError] = useState<string | null>(null)
  const [createPlanError, setCreatePlanError] = useState<string | null>(null)
  const [newPlanTitle, setNewPlanTitle] = useState("")
  const [newPlanDescription, setNewPlanDescription] = useState("")
  const [isDeletePlanOpen, setIsDeletePlanOpen] = useState(false)
  const [isDeletingPlan, setIsDeletingPlan] = useState(false)
  const [planDeleteError, setPlanDeleteError] = useState<string | null>(null)
  const [planTitleDraft, setPlanTitleDraft] = useState("")
  const [planDescriptionDraft, setPlanDescriptionDraft] = useState("")
  const [planEditorError, setPlanEditorError] = useState<string | null>(null)
  const [isSavingPlan, setIsSavingPlan] = useState(false)
  const [isTaskEditorOpen, setIsTaskEditorOpen] = useState(false)
  const [taskToVerify, setTaskToVerify] = useState<PlannerTaskRow | null>(null)
  const [taskEvidenceFiles, setTaskEvidenceFiles] = useState<PromptFile[]>([])
  const [isVerifyingTask, setIsVerifyingTask] = useState(false)
  const [taskVerificationError, setTaskVerificationError] = useState<
    string | null
  >(null)
  const [taskVerificationMessage, setTaskVerificationMessage] = useState<
    string | null
  >(null)
  const [taskToDelete, setTaskToDelete] = useState<PlannerTaskRow | null>(null)
  const [taskDeleteError, setTaskDeleteError] = useState<string | null>(null)
  const [isDeletingTask, setIsDeletingTask] = useState(false)
  const [editingTaskId, setEditingTaskId] = useState<string | null>(null)
  const [taskDraft, setTaskDraft] = useState<TaskDraft>({
    title: "",
    estimatedMinutes: "15",
    category: "Personal",
    dependsOn: [],
  })
  const [taskEditorError, setTaskEditorError] = useState<string | null>(null)
  const [isSavingTask, setIsSavingTask] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const verificationFileInputRef = useRef<HTMLInputElement>(null)
  const selectedPlan = savedPlans.find((plan) => plan.id === selectedPlanId)
  const canSubmit =
    !isGenerating &&
    objective.trim().length > 0 &&
    (selectedPlanId === "new" || !!selectedPlan)
  const taskById = useMemo(
    () => new Map(rows.map((row) => [row.id, row])),
    [rows]
  )
  const categories = useMemo(
    () => [...new Set(rows.map((row) => row.category))],
    [rows]
  )
  const visibleRows =
    selectedCategory === null
      ? rows
      : rows.filter((row) => row.category === selectedCategory)

  useEffect(() => {
    let active = true
    async function loadPlans() {
      const { data, error } = await supabase
        .from("planner_plans")
        .select("*")
        .eq("owner_uid", user.uid)
      if (!active) return
      if (error) {
        setIsLoadingPlans(false)
        setPlansError(getErrorMessage(error))
        return
      }
      try {
        const plans = data
          .map((row) => parseSavedPlan(row.id, row, user.uid))
          .sort((a, b) => b.createdAt.toMillis() - a.createdAt.toMillis())
        setSavedPlans(plans)
        setIsLoadingPlans(false)
        setPlansError(null)
        if (
          selectedPlanId === null ||
          (selectedPlanId !== "new" &&
            !plans.some((plan) => plan.id === selectedPlanId))
        ) {
          const nextPlanId =
            plans.find((plan) => plan.id === requestedPlanId)?.id ??
            plans[0]?.id ??
            "new"
          setSelectedPlanId(nextPlanId)
          setRows([])
          setIsLoadingTasks(nextPlanId !== "new")
        }
      } catch (loadError) {
        setIsLoadingPlans(false)
        setPlansError(getErrorMessage(loadError))
      }
    }
    const channel = supabase
      .channel(`planner-plans:${user.uid}`)
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "planner_plans",
          filter: `owner_uid=eq.${user.uid}`,
        },
        () => void loadPlans()
      )
      .subscribe((status) => {
        if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") {
          setPlansError("Unable to subscribe to Supabase updates.")
          setIsLoadingPlans(false)
        }
      })
    void loadPlans()
    return () => {
      active = false
      void supabase.removeChannel(channel)
    }
  }, [supabase, requestedPlanId, selectedPlanId, user.uid])

  useEffect(() => {
    if (!selectedPlanId || selectedPlanId === "new") return
    let active = true
    async function loadTasks() {
      const { data, error } = await supabase
        .from("planner_tasks")
        .select("*")
        .eq("plan_id", selectedPlanId)
        .order("position")
      if (!active) return
      if (error) {
        setIsLoadingTasks(false)
        setTasksError(getErrorMessage(error))
        return
      }
      try {
        const tasks = data.map((row) => parseSavedTask(row.id, row))
        validateTaskDependencies(tasks)
        setRows(tasks)
        setIsLoadingTasks(false)
        setTasksError(null)
      } catch (loadError) {
        setIsLoadingTasks(false)
        setTasksError(getErrorMessage(loadError))
      }
    }
    const channel = supabase
      .channel(`planner-tasks:${selectedPlanId}`)
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "planner_tasks",
          filter: `plan_id=eq.${selectedPlanId}`,
        },
        () => void loadTasks()
      )
      .subscribe((status) => {
        if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") {
          setTasksError("Unable to subscribe to Supabase updates.")
          setIsLoadingTasks(false)
        }
      })
    void loadTasks()
    return () => {
      active = false
      void supabase.removeChannel(channel)
    }
  }, [supabase, selectedPlanId])

  async function submitPlannerMessage(message: string) {
    const taskDescription = message.trim()
    if (!taskDescription || isGenerating) return
    const submittedMessageId = crypto.randomUUID()
    setChatMessages((messages) => [
      ...messages,
      { id: submittedMessageId, role: "user", text: taskDescription },
    ])
    setIsGenerating(true)
    setGenerationStatus(
      promptFiles.length > 0
        ? "Uploading and processing attachments…"
        : "Thinking it through…"
    )
    setGenerationError(null)
    try {
      const parts: Part[] = [{ text: taskDescription }]
      const uploadedFiles = await Promise.all(
        promptFiles.map(async ({ file }) => {
          try {
            return await uploadPromptFile(file)
          } catch (error) {
            throw new Error(
              `Unable to attach "${file.name}": ${getErrorMessage(error)}`,
              { cause: error }
            )
          }
        })
      )
      if (uploadedFiles.length > 0) {
        setGenerationStatus("Thinking it through…")
      }
      uploadedFiles.forEach((file) => {
        if (!file.uri || !file.mimeType) {
          throw new Error("A selected file could not be prepared for Gemini.")
        }
        parts.push({
          fileData: { fileUri: file.uri, mimeType: file.mimeType },
        })
      })

      const advisorResponse = await chatWithPlannerAdvisor(
        [
          ...chatMessages.map(({ role, text }) => ({ role, text })),
          { role: "user", text: taskDescription },
        ],
        selectedPlan
          ? {
              title: selectedPlan.title,
              description: selectedPlan.description,
              mode: selectedPlan.mode,
              boatReady: selectedPlan.boatReady,
              tasks: rows.map((row) => ({
                id: row.id,
                title: row.title,
                estimatedMinutes: row.estimatedMinutes,
                category: row.category,
                dependsOn: row.dependsOn,
                position: row.position,
                completed: row.completed,
              })),
            }
          : null,
        parts.slice(1)
      )
      if (advisorResponse.type === "message") {
        setChatMessages((messages) => [
          ...messages,
          {
            id: crypto.randomUUID(),
            role: "assistant",
            text: advisorResponse.text,
          },
        ])
      } else if (advisorResponse.type === "boat_readiness") {
        if (!selectedPlan) {
          throw new Error(
            "Select a saved plan before asking for boat readiness."
          )
        }
        if (isLoadingTasks || tasksError) {
          throw new Error(
            tasksError ??
              "Wait for this goal's steps to finish loading before reviewing it."
          )
        }
        const snapshot = {
          title: selectedPlan.title,
          description: selectedPlan.description,
          mode: selectedPlan.mode,
          totalEstimatedMinutes: selectedPlan.totalEstimatedMinutes,
          tasks: rows.map((row) => ({
            id: row.id,
            title: row.title,
            estimatedMinutes: row.estimatedMinutes,
            category: row.category,
            dependsOn: row.dependsOn,
            position: row.position,
          })),
        }
        const { error } = await supabase.rpc("set_plan_boat_readiness", {
          p_plan_id: selectedPlan.id,
          p_snapshot: snapshot,
          p_ready: advisorResponse.ready,
        })
        if (error) throw error
        setSavedPlans((plans) =>
          plans.map((plan) =>
            plan.id === selectedPlan.id
              ? { ...plan, boatReady: advisorResponse.ready }
              : plan
          )
        )
        setChatMessages((messages) => [
          ...messages,
          {
            id: crypto.randomUUID(),
            role: "assistant",
            text: `${advisorResponse.ready ? "Boat-ready approved" : "Not approved for a boat"}: ${advisorResponse.feedback}`,
          },
        ])
      } else if (selectedPlan) {
        if (selectedPlan.mode === "inferno") {
          throw new Error("Inferno plans are permanent and cannot be changed.")
        }
        if (isLoadingTasks || tasksError) {
          throw new Error(
            tasksError ??
              "Wait for this goal's steps to finish loading before updating it."
          )
        }
        setGenerationStatus("Updating your goal…")
        const revisedPlan = await revisePlannerTask(
          advisorResponse.instruction,
          {
            title: selectedPlan.title,
            description: selectedPlan.description,
            tasks: rows.map((row) => ({
              id: row.id,
              title: row.title,
              estimatedMinutes: row.estimatedMinutes,
              category: row.category,
              dependsOn: row.dependsOn,
              position: row.position,
              completed: row.completed,
            })),
          },
          parts.slice(1)
        )
        const mergedRows: PlannerTaskRow[] = revisedPlan.subtasks.map(
          (task, position) => {
            const existing = rows.find((row) => row.id === task.id)
            return {
              ...task,
              documentId: existing?.documentId ?? task.id,
              completed: existing?.completed ?? false,
              position,
            }
          }
        )
        if (mergedRows.length > MAX_PLAN_TASKS) {
          throw new Error(`A goal can have at most ${MAX_PLAN_TASKS} steps.`)
        }
        validateTaskDependencies(mergedRows)
        const totalEstimatedMinutes = mergedRows.reduce(
          (total, task) => total + task.estimatedMinutes,
          0
        )
        if (totalEstimatedMinutes > MAX_PLAN_ESTIMATED_MINUTES) {
          throw new Error(
            `The revised estimate must be at most ${MAX_PLAN_ESTIMATED_MINUTES} minutes.`
          )
        }

        const { error: saveError } = await supabase.rpc("save_plan_and_tasks", {
          p_plan_id: selectedPlan.id,
          p_plan: {
            title: revisedPlan.title,
            description: revisedPlan.description ?? selectedPlan.description,
            totalEstimatedMinutes,
            mode: selectedPlan.mode,
          },
          p_tasks: mergedRows.map((task) => ({
            id: task.id,
            title: task.title,
            estimated_minutes: task.estimatedMinutes,
            category: task.category,
            depends_on: task.dependsOn,
            position: task.position,
            completed: task.completed,
          })),
        })
        if (saveError) throw saveError
        setSavedPlans((plans) =>
          plans.map((plan) =>
            plan.id === selectedPlan.id ? { ...plan, boatReady: false } : plan
          )
        )
        setExpandedPlanId(selectedPlan.id)
        if (
          selectedCategory &&
          !mergedRows.some((task) => task.category === selectedCategory)
        ) {
          setSelectedCategory(null)
        }
        setChatMessages((messages) => [
          ...messages,
          {
            id: crypto.randomUUID(),
            role: "assistant",
            text: `I updated “${revisedPlan.title}” to match your request.`,
          },
        ])
      } else {
        setGenerationStatus("Creating your plan…")
        const plan = await generatePlannerTask([
          {
            role: "user",
            parts: [{ text: advisorResponse.instruction }, ...parts.slice(1)],
          },
        ])
        const { data: planId, error: saveError } = await supabase.rpc(
          "save_plan_and_tasks",
          {
            p_plan_id: null,
            p_plan: {
              title: plan.title,
              description: advisorResponse.instruction,
              totalEstimatedMinutes: plan.subtasks.reduce(
                (total, subtask) => total + subtask.estimatedMinutes,
                0
              ),
              mode: "casual",
            },
            p_tasks: plan.subtasks.map((subtask, position) => ({
              id: subtask.id,
              title: subtask.title,
              estimated_minutes: subtask.estimatedMinutes,
              category: subtask.category,
              depends_on: subtask.dependsOn,
              position,
              completed: false,
            })),
          }
        )
        if (saveError) throw saveError
        setSelectedPlanId(planId)
        setExpandedPlanId(planId)
        setIsLoadingTasks(true)
        setChatMessages((messages) => [
          ...messages,
          {
            id: crypto.randomUUID(),
            role: "assistant",
            text: `I created “${plan.title}” with ${plan.subtasks.length} steps. Open the goal card to work through them in order.`,
          },
        ])
      }
      setObjective("")
      setPromptFiles([])
    } catch (submitError) {
      setChatMessages((messages) =>
        messages.filter((message) => message.id !== submittedMessageId)
      )
      setGenerationError(getErrorMessage(submitError))
    } finally {
      setIsGenerating(false)
      setGenerationStatus(null)
    }
  }

  function onSubmit(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault()
    void submitPlannerMessage(objective)
  }

  function askForBoatReadinessReview() {
    if (
      !selectedPlan ||
      selectedPlan.mode === "inferno" ||
      isLoadingTasks ||
      tasksError ||
      rows.length === 0 ||
      isGenerating
    ) {
      return
    }
    setIsChatOpen(true)
    void submitPlannerMessage(
      "Please review this plan for boat readiness. Decide whether it is ready and explain your decision."
    )
  }

  function onAttach(event: React.ChangeEvent<HTMLInputElement>) {
    const selected = event.target.files
    if (!selected) return

    setPromptFiles((current) => [
      ...current,
      ...Array.from(selected, (file) => ({
        id: crypto.randomUUID(),
        file,
      })),
    ])
    event.target.value = ""
  }

  function onAttachTaskEvidence(event: React.ChangeEvent<HTMLInputElement>) {
    const selected = event.target.files
    if (!selected) return

    setTaskEvidenceFiles((current) => [
      ...current,
      ...Array.from(selected, (file) => ({
        id: crypto.randomUUID(),
        file,
      })),
    ])
    setTaskVerificationMessage(null)
    setTaskVerificationError(null)
    event.target.value = ""
  }

  const completedCount = rows.filter((row) => row.completed).length
  const canDeleteSelectedPlan =
    selectedPlan?.mode === "casual" ||
    (!!selectedPlan &&
      !isLoadingTasks &&
      !tasksError &&
      (rows.length === 0 || completedCount === rows.length))
  const onSelectPlan = (planId: string) => {
    setSelectedPlanId(planId)
    setChatMessages([])
    setRows([])
    setSelectedCategory(null)
    setIsLoadingTasks(planId !== "new")
    setExpandedPlanId(null)
    setTasksError(null)
    setGenerationError(null)
    setIsPlanEditorOpen(false)
    setIsTaskEditorOpen(false)
    setTaskToDelete(null)
    setTaskDeleteError(null)
    setTaskToVerify(null)
    setTaskEvidenceFiles([])
    setTaskUpdateError(null)
    setIsFireConfirmOpen(false)
    setIsInfernoConfirmOpen(false)
  }

  async function onCreatePlan(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault()
    if (isCreatingPlan) return

    const title = newPlanTitle.trim()
    const description = newPlanDescription.trim()
    if (!title || title.length > 200) {
      setCreatePlanError("Enter a goal title between 1 and 200 characters.")
      return
    }
    if (!description || description.length > 2000) {
      setCreatePlanError(
        "Enter a goal description between 1 and 2,000 characters."
      )
      return
    }

    setIsCreatingPlan(true)
    setCreatePlanError(null)
    try {
      const { data: plan, error } = await supabase
        .from("planner_plans")
        .insert({
          owner_uid: user.uid,
          description,
          title,
          total_estimated_minutes: 0,
          mode: "casual",
        })
        .select("id")
        .single()
      if (error) throw error
      setIsCreatePlanOpen(false)
      setNewPlanTitle("")
      setNewPlanDescription("")
      setSelectedPlanId(plan.id)
      setExpandedPlanId(plan.id)
      setRows([])
      setIsLoadingTasks(true)
      setSelectedCategory(null)
      setChatMessages([])
    } catch (error) {
      setCreatePlanError(getErrorMessage(error))
    } finally {
      setIsCreatingPlan(false)
    }
  }

  async function onToggleTask(row: PlannerTaskRow) {
    if (!selectedPlan || !selectedPlanId || selectedPlanId === "new") return
    if (isVerifyingTask) return
    if (
      !row.completed &&
      row.dependsOn.some((id) => !taskById.get(id)?.completed)
    ) {
      return
    }

    if (selectedPlan.mode !== "inferno") {
      setTaskUpdateError(null)
      try {
        const affectedIds = new Set([row.id])
        if (row.completed) {
          let foundDependent = true
          while (foundDependent) {
            foundDependent = false
            rows.forEach((task) => {
              if (
                task.completed &&
                !affectedIds.has(task.id) &&
                task.dependsOn.some((dependencyId) =>
                  affectedIds.has(dependencyId)
                )
              ) {
                affectedIds.add(task.id)
                foundDependent = true
              }
            })
          }
        }

        const { error } = await supabase.rpc("save_plan_and_tasks", {
          p_plan_id: selectedPlanId,
          p_plan: {
            title: selectedPlan.title,
            description: selectedPlan.description,
            totalEstimatedMinutes: selectedPlan.totalEstimatedMinutes,
            mode: selectedPlan.mode,
          },
          p_tasks: rows.map((task) => ({
            id: task.id,
            title: task.title,
            estimated_minutes: task.estimatedMinutes,
            category: task.category,
            depends_on: task.dependsOn,
            position: task.position,
            completed: affectedIds.has(task.id)
              ? !row.completed
              : task.completed,
          })),
        })
        if (error) throw error
      } catch (error) {
        setTaskUpdateError(getErrorMessage(error))
      }
      return
    }
    if (row.completed) return

    setTaskToVerify(row)
    setTaskEvidenceFiles([])
    setTaskVerificationError(null)
    setTaskVerificationMessage(null)
  }

  async function onVerifyTask(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault()
    if (
      !selectedPlan ||
      selectedPlan.mode !== "inferno" ||
      !selectedPlanId ||
      selectedPlanId === "new" ||
      !taskToVerify
    )
      return
    if (taskEvidenceFiles.length === 0) {
      setTaskVerificationError("Attach at least one file as evidence.")
      return
    }

    setIsVerifyingTask(true)
    setTaskVerificationError(null)
    setTaskVerificationMessage(null)
    try {
      const uploadedFiles = await Promise.all(
        taskEvidenceFiles.map(async ({ file }) => {
          try {
            return await uploadPromptFile(file)
          } catch (error) {
            throw new Error(
              `Unable to attach "${file.name}": ${getErrorMessage(error)}`,
              { cause: error }
            )
          }
        })
      )
      const attachmentParts: Part[] = uploadedFiles.map((file) => {
        if (!file.uri || !file.mimeType) {
          throw new Error("An evidence file could not be prepared for Gemini.")
        }
        return { fileData: { fileUri: file.uri, mimeType: file.mimeType } }
      })
      const review = await verifyPlannerTaskCompletion(
        taskToVerify.title,
        attachmentParts
      )
      if (!review.verified) {
        setTaskVerificationMessage(review.reason)
        setTaskEvidenceFiles([])
        if (verificationFileInputRef.current) {
          verificationFileInputRef.current.value = ""
        }
        return
      }
      const { error } = await supabase
        .from("planner_tasks")
        .update({ completed: true })
        .eq("plan_id", selectedPlanId)
        .eq("id", taskToVerify.id)
      if (error) throw error
      setTaskToVerify(null)
      setTaskEvidenceFiles([])
    } catch (error) {
      setTaskVerificationError(getErrorMessage(error))
    } finally {
      setIsVerifyingTask(false)
    }
  }

  async function onMakeFire() {
    if (!selectedPlan || selectedPlan.mode !== "casual" || isMakingFire) return
    setIsMakingFire(true)
    setFireModeError(null)
    try {
      const { error } = await supabase
        .from("planner_plans")
        .update({
          mode: "fire",
        })
        .eq("id", selectedPlan.id)
      if (error) throw error
      setSavedPlans((plans) =>
        plans.map((plan) =>
          plan.id === selectedPlan.id
            ? { ...plan, mode: "fire", boatReady: false }
            : plan
        )
      )
      setIsFireConfirmOpen(false)
    } catch (error) {
      setFireModeError(getErrorMessage(error))
    } finally {
      setIsMakingFire(false)
    }
  }

  async function onMakeInferno() {
    if (
      !selectedPlan ||
      selectedPlan.mode === "inferno" ||
      !selectedPlan.boatReady ||
      isMakingInferno
    )
      return
    setIsMakingInferno(true)
    setInfernoModeError(null)
    try {
      const { error } = await supabase
        .from("planner_plans")
        .update({
          mode: "inferno",
        })
        .eq("id", selectedPlan.id)
      if (error) throw error
      setSavedPlans((plans) =>
        plans.map((plan) =>
          plan.id === selectedPlan.id ? { ...plan, mode: "inferno" } : plan
        )
      )
      setIsInfernoConfirmOpen(false)
    } catch (error) {
      setInfernoModeError(getErrorMessage(error))
    } finally {
      setIsMakingInferno(false)
    }
  }

  function openPlanEditor() {
    if (!selectedPlan || selectedPlan.mode !== "casual") return
    setPlanTitleDraft(selectedPlan.title)
    setPlanDescriptionDraft(selectedPlan.description)
    setPlanEditorError(null)
    setIsPlanEditorOpen(true)
  }

  async function onSavePlan(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!selectedPlan || selectedPlan.mode !== "casual" || isSavingPlan) return

    const title = planTitleDraft.trim()
    const description = planDescriptionDraft.trim()
    if (!title || title.length > 200) {
      setPlanEditorError("Enter a goal title between 1 and 200 characters.")
      return
    }
    if (!description || description.length > 2000) {
      setPlanEditorError(
        "Enter a goal description between 1 and 2,000 characters."
      )
      return
    }

    setIsSavingPlan(true)
    setPlanEditorError(null)
    try {
      const { error } = await supabase
        .from("planner_plans")
        .update({
          title,
          description,
        })
        .eq("id", selectedPlan.id)
      if (error) throw error
      setSavedPlans((plans) =>
        plans.map((plan) =>
          plan.id === selectedPlan.id ? { ...plan, boatReady: false } : plan
        )
      )
      setIsPlanEditorOpen(false)
    } catch (error) {
      setPlanEditorError(getErrorMessage(error))
    } finally {
      setIsSavingPlan(false)
    }
  }

  async function onDeletePlan() {
    if (!selectedPlan || isDeletingPlan) return

    setIsDeletingPlan(true)
    setPlanDeleteError(null)
    try {
      const { data: tasks, error: taskError } = await supabase
        .from("planner_tasks")
        .select("completed")
        .eq("plan_id", selectedPlan.id)
      if (taskError) throw taskError
      if (
        selectedPlan.mode !== "casual" &&
        tasks.some((task) => task.completed !== true)
      ) {
        throw new Error(
          "A permanent plan can only be deleted when it has no steps or all steps are complete."
        )
      }
      const { error } = await supabase
        .from("planner_plans")
        .delete()
        .eq("id", selectedPlan.id)
      if (error) throw error
      setIsDeletePlanOpen(false)
      onSelectPlan("new")
    } catch (error) {
      setPlanDeleteError(getErrorMessage(error))
    } finally {
      setIsDeletingPlan(false)
    }
  }

  async function onDeleteTask() {
    if (
      !selectedPlan ||
      selectedPlan.mode !== "casual" ||
      !taskToDelete ||
      isDeletingTask
    )
      return

    setIsDeletingTask(true)
    setTaskDeleteError(null)
    try {
      if (!rows.some((row) => row.id === taskToDelete.id)) {
        throw new Error("This step no longer exists. Refresh and try again.")
      }
      const { error } = await supabase.rpc("delete_planner_task", {
        p_plan_id: selectedPlan.id,
        p_task_id: taskToDelete.id,
        p_owner_uid: user.uid,
      })
      if (error) throw error

      if (
        selectedCategory === taskToDelete.category &&
        !rows.some(
          (task) =>
            task.documentId !== taskToDelete.documentId &&
            task.category === selectedCategory
        )
      ) {
        setSelectedCategory(null)
      }
      setTaskToDelete(null)
    } catch (error) {
      setTaskDeleteError(getErrorMessage(error))
    } finally {
      setIsDeletingTask(false)
    }
  }

  function openTaskEditor(row?: PlannerTaskRow) {
    if (
      !selectedPlan ||
      selectedPlan.mode !== "casual" ||
      selectedPlanId === "new"
    )
      return
    if (!row && rows.length >= MAX_PLAN_TASKS) {
      setTaskEditorError(`A goal can have at most ${MAX_PLAN_TASKS} steps.`)
      return
    }
    setEditingTaskId(row?.id ?? null)
    setTaskDraft(
      row
        ? {
            title: row.title,
            estimatedMinutes: String(row.estimatedMinutes),
            category: row.category,
            dependsOn: row.dependsOn,
          }
        : {
            title: "",
            estimatedMinutes: "15",
            category: "Personal",
            dependsOn: [],
          }
    )
    setTaskEditorError(null)
    setIsTaskEditorOpen(true)
  }

  async function onSaveTask(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault()
    if (
      !selectedPlan ||
      selectedPlan.mode !== "casual" ||
      selectedPlanId === "new" ||
      isSavingTask
    )
      return

    const title = taskDraft.title.trim()
    const category = taskDraft.category.trim()
    const estimatedMinutes = Number(taskDraft.estimatedMinutes)
    const existingTask = editingTaskId
      ? rows.find((row) => row.id === editingTaskId)
      : undefined
    const position =
      existingTask?.position ??
      Math.max(-1, ...rows.map((row) => row.position)) + 1
    const dependencies = taskDraft.dependsOn

    if (!title || title.length > 500) {
      setTaskEditorError("Enter a step title between 1 and 500 characters.")
      return
    }
    if (!category || category.length > 100) {
      setTaskEditorError("Enter a category between 1 and 100 characters.")
      return
    }
    if (
      !Number.isInteger(estimatedMinutes) ||
      estimatedMinutes < 1 ||
      estimatedMinutes > 10000
    ) {
      setTaskEditorError("Enter an estimate between 1 and 10,000 minutes.")
      return
    }
    if (
      dependencies.length > 8 ||
      new Set(dependencies).size !== dependencies.length ||
      dependencies.some((id) => {
        const dependency = taskById.get(id)
        return (
          !dependency || dependency.position >= position || id === editingTaskId
        )
      })
    ) {
      setTaskEditorError("Choose up to 8 earlier steps as prerequisites.")
      return
    }
    if (
      !existingTask &&
      (rows.length >= MAX_PLAN_TASKS || position >= MAX_PLAN_POSITION)
    ) {
      setTaskEditorError(`A goal can have at most ${MAX_PLAN_TASKS} steps.`)
      return
    }

    const totalEstimatedMinutes =
      selectedPlan.totalEstimatedMinutes +
      estimatedMinutes -
      (existingTask?.estimatedMinutes ?? 0)
    if (
      totalEstimatedMinutes < 1 ||
      totalEstimatedMinutes > MAX_PLAN_ESTIMATED_MINUTES
    ) {
      setTaskEditorError(
        `The goal estimate must be between 1 and ${MAX_PLAN_ESTIMATED_MINUTES} minutes.`
      )
      return
    }

    setIsSavingTask(true)
    setTaskEditorError(null)
    try {
      const taskId = existingTask?.id ?? crypto.randomUUID().replaceAll("-", "")
      const taskRows = rows.map((row) => ({
        id: row.id,
        title: row.id === taskId ? title : row.title,
        estimated_minutes:
          row.id === taskId ? estimatedMinutes : row.estimatedMinutes,
        category: row.id === taskId ? category : row.category,
        depends_on: row.id === taskId ? dependencies : row.dependsOn,
        position: row.id === taskId ? position : row.position,
        completed:
          row.id === taskId
            ? (existingTask?.completed ?? false)
            : row.completed,
      }))
      if (!existingTask) {
        taskRows.push({
          id: taskId,
          title,
          estimated_minutes: estimatedMinutes,
          category,
          depends_on: dependencies,
          position,
          completed: false,
        })
      }
      const { error } = await supabase.rpc("save_plan_and_tasks", {
        p_plan_id: selectedPlan.id,
        p_plan: {
          title: selectedPlan.title,
          description: selectedPlan.description,
          totalEstimatedMinutes,
          mode: selectedPlan.mode,
        },
        p_tasks: taskRows,
      })
      if (error) throw error
      setSavedPlans((plans) =>
        plans.map((plan) =>
          plan.id === selectedPlan.id ? { ...plan, boatReady: false } : plan
        )
      )
      if (
        selectedCategory &&
        category !== selectedCategory &&
        !rows.some(
          (row) =>
            row.id !== existingTask?.id && row.category === selectedCategory
        )
      ) {
        setSelectedCategory(null)
      }
      setIsTaskEditorOpen(false)
    } catch (error) {
      setTaskEditorError(getErrorMessage(error))
    } finally {
      setIsSavingTask(false)
    }
  }

  const taskDeleteDependents = taskToDelete
    ? rows.filter((task) => task.dependsOn.includes(taskToDelete.id))
    : []

  return (
    <>
      <Sheet open={isChatOpen} onOpenChange={setIsChatOpen}>
        <main className="mx-auto flex min-h-0 w-full max-w-3xl flex-1 flex-col gap-8 overflow-y-auto p-6 pb-24 md:p-10 md:pb-28">
          <header className="flex flex-col gap-2">
            <h1 className="text-3xl font-semibold tracking-tight sm:text-4xl">
              Planning for the trip.
            </h1>
            <p className="max-w-2xl text-muted-foreground">
              To burn, first we must build.
            </p>
          </header>

          <section className="flex flex-col gap-3">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <h2 className="text-lg font-semibold">Your goals</h2>
              </div>
              <div className="flex items-center gap-2">
                {savedPlans.length > 0 && (
                  <>
                    <label
                      htmlFor="saved-objectives"
                      className="text-sm font-medium"
                    >
                      Saved goals
                    </label>
                    <select
                      id="saved-objectives"
                      value={selectedPlanId ?? "new"}
                      onChange={(event) => onSelectPlan(event.target.value)}
                      className="max-w-full rounded-md border bg-background px-3 py-2 text-sm"
                    >
                      <option value="new">New goal</option>
                      {savedPlans.map((plan) => (
                        <option key={plan.id} value={plan.id}>
                          {plan.title}
                        </option>
                      ))}
                    </select>
                  </>
                )}
              </div>
            </div>

            {selectedPlan ? (
              <Card className="overflow-hidden">
                <CardHeader className="flex-row items-start gap-2 p-0">
                  <Button
                    type="button"
                    variant="ghost"
                    className="h-auto min-w-0 flex-1 justify-start rounded-none bg-transparent! p-5 text-left hover:bg-transparent! hover:text-card-foreground! active:translate-y-0 aria-expanded:bg-transparent! aria-expanded:text-card-foreground!"
                    aria-expanded={expandedPlanId === selectedPlan.id}
                    onClick={() =>
                      setExpandedPlanId((current) =>
                        current === selectedPlan.id ? null : selectedPlan.id
                      )
                    }
                  >
                    <div className="flex w-full min-w-0 items-start gap-4">
                      <span className="mt-0.5 flex size-10 shrink-0 items-center justify-center rounded-xl bg-primary text-primary-foreground">
                        {expandedPlanId === selectedPlan.id ? (
                          <ChevronDown />
                        ) : (
                          <ChevronRight />
                        )}
                      </span>
                      <span className="flex min-w-0 flex-1 flex-col gap-2">
                        <span className="truncate text-base font-semibold">
                          {selectedPlan.title}
                        </span>
                        <span
                          className={
                            selectedPlan.mode === "fire"
                              ? "w-fit rounded-full bg-orange-500/10 px-2 py-0.5 text-xs font-semibold text-orange-700 dark:text-orange-300"
                              : selectedPlan.mode === "inferno"
                                ? "w-fit rounded-full bg-destructive/10 px-2 py-0.5 text-xs font-semibold text-destructive"
                                : "w-fit rounded-full bg-muted px-2 py-0.5 text-xs font-semibold text-muted-foreground"
                          }
                        >
                          {selectedPlan.mode.toUpperCase()}
                        </span>
                        <span
                          className={
                            selectedPlan.boatReady
                              ? "w-fit rounded-full bg-green-500/10 px-2 py-0.5 text-xs font-semibold text-green-700 dark:text-green-300"
                              : "w-fit rounded-full bg-muted px-2 py-0.5 text-xs font-semibold text-muted-foreground"
                          }
                        >
                          {selectedPlan.boatReady
                            ? "BOAT-READY"
                            : "NOT BOAT-READY"}
                        </span>
                        <span className="line-clamp-2 text-sm font-normal text-muted-foreground">
                          {selectedPlan.description}
                        </span>
                        <span className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs font-normal text-muted-foreground">
                          <span>
                            {completedCount} of {rows.length} steps complete
                          </span>
                          <span className="inline-flex items-center gap-1">
                            <Clock3 />
                            {formatDuration(selectedPlan.totalEstimatedMinutes)}
                          </span>
                        </span>
                      </span>
                    </div>
                  </Button>
                  <div className="flex shrink-0 items-center justify-end-safe gap-1 p-1.5">
                    {selectedPlan.mode === "casual" ? (
                      <>
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          aria-label="Convert to Fire plan"
                          disabled={isGenerating}
                          onClick={() => {
                            setFireModeError(null)
                            setIsFireConfirmOpen(true)
                          }}
                        >
                          <Flame data-icon="inline-start" />
                          <span className="hidden sm:inline">Ignite</span>
                        </Button>

                        <Button
                          type="button"
                          size="sm"
                          aria-label="Edit goal"
                          disabled={isGenerating}
                          onClick={openPlanEditor}
                        >
                          <Pencil data-icon="inline-start" />
                          <span className="hidden sm:inline">Edit</span>
                        </Button>
                        <Button
                          type="button"
                          variant="destructive"
                          size="sm"
                          aria-label="Delete goal"
                          disabled={isGenerating}
                          onClick={() => {
                            setPlanDeleteError(null)
                            setIsDeletePlanOpen(true)
                          }}
                        >
                          <Trash2 data-icon="inline-start" />
                          <span className="hidden sm:inline">Delete</span>
                        </Button>
                      </>
                    ) : (
                      <>
                        <span className="px-3 text-xs text-muted-foreground">
                          {selectedPlan.mode === "fire"
                            ? selectedPlan.boatReady
                              ? "Ask AI to change this plan"
                              : "Get boat-ready approval before Inferno"
                            : "Advice only · tasks are permanent"}
                        </span>
                        {selectedPlan.mode === "fire" && (
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            aria-label="Convert to Inferno plan"
                            disabled={isGenerating || !selectedPlan.boatReady}
                            onClick={() => {
                              setInfernoModeError(null)
                              setIsInfernoConfirmOpen(true)
                            }}
                          >
                            <Flame data-icon="inline-start" />
                            <span className="hidden sm:inline">Ignite</span>
                          </Button>
                        )}
                        <Button
                          type="button"
                          variant="destructive"
                          size="sm"
                          aria-label="Delete goal"
                          disabled={
                            isGenerating ||
                            isLoadingTasks ||
                            !canDeleteSelectedPlan
                          }
                          title={
                            canDeleteSelectedPlan
                              ? undefined
                              : "Complete all steps before deleting this permanent plan."
                          }
                          onClick={() => {
                            setPlanDeleteError(null)
                            setIsDeletePlanOpen(true)
                          }}
                        >
                          <Trash2 data-icon="inline-start" />
                          <span className="hidden sm:inline">Delete</span>
                        </Button>
                      </>
                    )}
                  </div>
                </CardHeader>

                {expandedPlanId === selectedPlan.id && (
                  <CardContent className="flex flex-col gap-4 px-5 pt-0 pb-5">
                    <Separator />
                    {selectedPlan.mode !== "inferno" && (
                      <div className="flex flex-wrap items-center justify-between gap-3">
                        <p className="text-sm text-muted-foreground">
                          Ask the AI to evaluate the plan before making it
                          boat-ready.
                        </p>
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          disabled={
                            isGenerating ||
                            isLoadingTasks ||
                            Boolean(tasksError) ||
                            rows.length === 0 ||
                            selectedPlan.boatReady
                          }
                          onClick={askForBoatReadinessReview}
                        >
                          <ListCheck data-icon="inline-start" />
                          Review boat readiness
                        </Button>
                      </div>
                    )}
                    {isLoadingTasks ? (
                      <p
                        role="status"
                        className="text-sm text-muted-foreground"
                      >
                        Loading your steps…
                      </p>
                    ) : rows.length > 0 ? (
                      <>
                        <div
                          className="flex flex-wrap items-center gap-2"
                          role="group"
                          aria-label="Filter steps by category"
                        >
                          <Button
                            type="button"
                            size="sm"
                            variant={
                              selectedCategory === null
                                ? "secondary"
                                : "outline"
                            }
                            aria-pressed={selectedCategory === null}
                            onClick={() => setSelectedCategory(null)}
                          >
                            All steps
                          </Button>
                          {categories.map((category) => (
                            <Button
                              key={category}
                              type="button"
                              size="sm"
                              variant={
                                selectedCategory === category
                                  ? "secondary"
                                  : "outline"
                              }
                              aria-pressed={selectedCategory === category}
                              onClick={() =>
                                setSelectedCategory((current) =>
                                  current === category ? null : category
                                )
                              }
                            >
                              {category}
                            </Button>
                          ))}
                          <span className="ml-auto text-xs text-muted-foreground">
                            {visibleRows.length} of {rows.length} steps
                          </span>
                        </div>
                        {visibleRows.length > 0 ? (
                          <ol className="flex flex-col">
                            {visibleRows.map((row, visibleIndex) => {
                              const index = rows.findIndex(
                                (task) => task.id === row.id
                              )
                              const unmetDependencies = row.dependsOn
                                .map((id) => taskById.get(id))
                                .filter(
                                  (dependency): dependency is PlannerTaskRow =>
                                    !!dependency && !dependency.completed
                                )
                              const isBlocked =
                                !row.completed &&
                                (unmetDependencies.length > 0 ||
                                  !selectedPlanId)
                              const toggleLabel = row.completed
                                ? selectedPlan.mode === "casual"
                                  ? `Mark ${row.title} incomplete`
                                  : selectedPlan.mode === "fire"
                                    ? `Mark ${row.title} incomplete`
                                    : `${row.title} is complete`
                                : selectedPlan.mode === "inferno"
                                  ? `Submit evidence to verify ${row.title}`
                                  : `Mark ${row.title} complete`

                              return (
                                <li key={row.id}>
                                  <div className="flex items-start gap-3 py-4">
                                    <Button
                                      type="button"
                                      variant={
                                        row.completed ? "secondary" : "outline"
                                      }
                                      size="icon"
                                      className="mt-0.5 size-8 shrink-0 rounded-full"
                                      aria-label={toggleLabel}
                                      disabled={
                                        isBlocked ||
                                        (row.completed &&
                                          selectedPlan.mode === "inferno") ||
                                        isGenerating
                                      }
                                      title={
                                        unmetDependencies.length > 0
                                          ? `Complete ${unmetDependencies
                                              .map((task) => task.title)
                                              .join(", ")} first.`
                                          : undefined
                                      }
                                      onClick={() => void onToggleTask(row)}
                                    >
                                      {row.completed ? (
                                        <Check />
                                      ) : isBlocked ? (
                                        <LockKeyhole />
                                      ) : null}
                                    </Button>
                                    <div className="flex min-w-0 flex-1 flex-col gap-1">
                                      <div className="flex flex-wrap items-center gap-2">
                                        <span
                                          className={
                                            row.completed
                                              ? "text-sm font-medium text-muted-foreground line-through"
                                              : "text-sm font-medium"
                                          }
                                        >
                                          {row.title}
                                        </span>
                                        {row.completed && (
                                          <span className="text-xs text-muted-foreground">
                                            Done
                                          </span>
                                        )}
                                      </div>
                                      <p className="text-xs text-muted-foreground">
                                        Step {index + 1} · {row.category} ·{" "}
                                        {formatDuration(row.estimatedMinutes)}
                                      </p>
                                      {unmetDependencies.length > 0 && (
                                        <p className="text-xs text-muted-foreground">
                                          <LockKeyhole className="mr-1 inline size-3" />
                                          Waiting for{" "}
                                          {unmetDependencies
                                            .map((task) => task.title)
                                            .join(" and ")}
                                        </p>
                                      )}
                                    </div>
                                    {selectedPlan.mode === "casual" && (
                                      <>
                                        <Button
                                          type="button"
                                          variant="ghost"
                                          size="icon"
                                          className="size-8 shrink-0"
                                          aria-label={`Edit ${row.title}`}
                                          disabled={isGenerating}
                                          onClick={() => openTaskEditor(row)}
                                        >
                                          <Pencil />
                                        </Button>
                                        <Button
                                          type="button"
                                          variant="ghost"
                                          size="icon"
                                          className="size-8 shrink-0 text-destructive hover:text-destructive"
                                          aria-label={`Delete ${row.title}`}
                                          disabled={isGenerating}
                                          onClick={() => {
                                            setTaskDeleteError(null)
                                            setTaskToDelete(row)
                                          }}
                                        >
                                          <Trash2 />
                                        </Button>
                                      </>
                                    )}
                                  </div>
                                  {visibleIndex < visibleRows.length - 1 && (
                                    <Separator />
                                  )}
                                </li>
                              )
                            })}
                          </ol>
                        ) : (
                          <p className="py-4 text-sm text-muted-foreground">
                            No steps in this category.
                          </p>
                        )}
                      </>
                    ) : (
                      <p className="text-sm text-muted-foreground">
                        {isLoadingPlans
                          ? "Loading your goals…"
                          : "This goal has no steps yet."}
                      </p>
                    )}
                    {!isLoadingTasks && selectedPlan.mode === "casual" && (
                      <Button
                        type="button"
                        variant="outline"
                        className="w-full justify-start"
                        disabled={rows.length >= MAX_PLAN_TASKS || isGenerating}
                        onClick={() => openTaskEditor()}
                      >
                        <Plus data-icon="inline-start" />
                        {rows.length >= MAX_PLAN_TASKS
                          ? `Maximum of ${MAX_PLAN_TASKS} steps reached`
                          : "Add a step"}
                      </Button>
                    )}
                    {taskUpdateError && (
                      <p role="alert" className="text-sm text-destructive">
                        {taskUpdateError}
                      </p>
                    )}
                  </CardContent>
                )}
              </Card>
            ) : (
              <>
                <Button
                  type="button"
                  variant="ghost"
                  className="h-auto min-h-64 w-full flex-col gap-3 rounded-xl bg-card p-8 text-center whitespace-normal text-card-foreground ring-1 ring-foreground/10 hover:bg-muted/50"
                  onClick={() => {
                    setCreatePlanError(null)
                    setIsCreatePlanOpen(true)
                  }}
                  disabled={isLoadingPlans}
                >
                  <span className="flex size-12 items-center justify-center rounded-full bg-muted">
                    <ListCheck />
                  </span>
                  <span className="font-semibold">
                    {isLoadingPlans
                      ? "Loading your goals…"
                      : "Start with one goal"}
                  </span>
                  <span className="max-w-sm text-sm text-muted-foreground">
                    Describe how beautiful the island is
                  </span>
                </Button>
                {plansError && (
                  <p role="alert" className="text-sm text-destructive">
                    {plansError}
                  </p>
                )}
              </>
            )}

            {tasksError && (
              <p role="alert" className="text-sm text-destructive">
                {tasksError}
              </p>
            )}
          </section>
        </main>

        <SheetTrigger
          render={
            <Button className="fixed right-5 bottom-5 z-10 rounded-full px-4 shadow-lg md:right-8 md:bottom-8" />
          }
        >
          <MessageCircle data-icon="inline-start" />
          Talk to planner
        </SheetTrigger>
        <SheetContent className="w-full gap-0 p-0 sm:max-w-md">
          <SheetHeader className="border-b px-5 py-4">
            <SheetTitle className="flex items-center gap-2">
              <span className="flex size-8 items-center justify-center rounded-full bg-primary text-primary-foreground">
                <Bot />
              </span>
              Plan advisor
            </SheetTitle>
            <SheetDescription>
              {selectedPlan
                ? selectedPlan.mode === "fire"
                  ? `This is a Fire plan. Ask me to make changes or review it for boat readiness; tasks require evidence before completion.`
                  : selectedPlan.mode === "inferno"
                    ? `This is an Inferno plan. I can offer advice, but I cannot change its permanent tasks.`
                    : `Ask for advice, request plan edits, or ask me to review “${selectedPlan.title}” for boat readiness. Editing the plan revokes boat readiness.`
                : "Talk through an idea, or ask me to turn a goal into manageable steps."}
            </SheetDescription>
          </SheetHeader>

          <div className="flex min-h-0 flex-1 flex-col px-4">
            <MessageScrollerProvider>
              <MessageScroller className="flex-1">
                <MessageScrollerViewport>
                  <MessageScrollerContent className="gap-4 py-4">
                    {chatMessages.length === 0 && (
                      <MessageScrollerItem>
                        <Message>
                          <MessageAvatar>
                            <Avatar>
                              <AvatarFallback>
                                <Bot />
                              </AvatarFallback>
                            </Avatar>
                          </MessageAvatar>
                          <MessageContent>
                            <Bubble variant="secondary">
                              <BubbleContent>
                                {selectedPlan
                                  ? selectedPlan.mode === "fire"
                                    ? `“${selectedPlan.title}” is a Fire plan. Tell me what you want to change; you can't edit it directly. You can also ask me to review it for boat readiness.`
                                    : selectedPlan.mode === "inferno"
                                      ? `“${selectedPlan.title}” is an Inferno plan. I can only offer advice; its tasks cannot be changed.`
                                      : `I'm here to help with “${selectedPlan.title}”. Ask for advice, request an update, or ask if it's ready for a boat.`
                                  : "I can help you explore an idea or create a plan. Tell me what you have in mind."}
                              </BubbleContent>
                            </Bubble>
                          </MessageContent>
                        </Message>
                      </MessageScrollerItem>
                    )}
                    {chatMessages.map((message) => (
                      <MessageScrollerItem
                        key={message.id}
                        messageId={message.id}
                        scrollAnchor={message.role === "user"}
                      >
                        <Message
                          align={message.role === "user" ? "end" : "start"}
                        >
                          <MessageAvatar>
                            <Avatar>
                              <AvatarFallback>
                                {message.role === "user" ? (
                                  <UserRound />
                                ) : (
                                  <Bot />
                                )}
                              </AvatarFallback>
                            </Avatar>
                          </MessageAvatar>
                          {message.role === "user" ? (
                            <MessageContent>
                              <Bubble variant="default">
                                <BubbleContent>{message.text}</BubbleContent>
                              </Bubble>
                            </MessageContent>
                          ) : (
                            <MessageContent className="gap-2">
                              <Streamdown
                                mode="static"
                                className="max-w-full min-w-0 text-sm leading-relaxed [&_a]:text-primary [&_a]:underline [&_code]:rounded [&_code]:bg-muted [&_code]:px-1 [&_code]:py-0.5 [&_code]:font-mono [&_code]:text-xs [&_ol]:my-2 [&_ol]:list-decimal [&_ol]:pl-5 [&_p]:my-2 [&_p:first-child]:mt-0 [&_p:last-child]:mb-0 [&_pre]:max-w-full [&_pre]:overflow-x-auto [&_pre]:rounded-md [&_pre]:bg-muted [&_pre]:p-3 [&_pre_code]:bg-transparent [&_pre_code]:p-0 [&_ul]:my-2 [&_ul]:list-disc [&_ul]:pl-5"
                              >
                                {message.text}
                              </Streamdown>
                            </MessageContent>
                          )}
                        </Message>
                      </MessageScrollerItem>
                    ))}
                    {isGenerating && (
                      <MessageScrollerItem>
                        <Message>
                          <Marker role="status">
                            <MarkerIcon>
                              <LoaderCircle className="animate-spin" />
                            </MarkerIcon>
                            <MarkerContent>
                              {generationStatus ?? "Creating your plan…"}
                            </MarkerContent>
                          </Marker>
                        </Message>
                      </MessageScrollerItem>
                    )}
                  </MessageScrollerContent>
                </MessageScrollerViewport>
                <MessageScrollerButton>
                  <ArrowDown />
                </MessageScrollerButton>
              </MessageScroller>
            </MessageScrollerProvider>

            {generationError && (
              <p role="alert" className="pb-3 text-sm text-destructive">
                {generationError}
              </p>
            )}
            {plansError && (
              <p role="alert" className="pb-3 text-sm text-destructive">
                {plansError}
              </p>
            )}
          </div>

          <SheetFooter className="mt-0 border-t p-4">
            <form onSubmit={onSubmit} className="w-full">
              <InputGroup className="rounded-xl">
                {promptFiles.length > 0 && (
                  <InputGroupAddon align="block-start" className="flex-wrap">
                    {promptFiles.map(({ id, file }) => (
                      <Attachment key={id} size="sm">
                        <AttachmentMedia>
                          <FileTextIcon />
                        </AttachmentMedia>
                        <AttachmentContent>
                          <AttachmentTitle>{file.name}</AttachmentTitle>
                        </AttachmentContent>
                        <AttachmentActions>
                          <AttachmentAction
                            type="button"
                            aria-label={`Remove ${file.name}`}
                            disabled={isGenerating}
                            onClick={() =>
                              setPromptFiles((current) =>
                                current.filter((item) => item.id !== id)
                              )
                            }
                          >
                            <XIcon />
                          </AttachmentAction>
                        </AttachmentActions>
                      </Attachment>
                    ))}
                  </InputGroupAddon>
                )}
                <InputGroupTextarea
                  value={objective}
                  onKeyDown={(event) => {
                    if (
                      event.key !== "Enter" ||
                      event.shiftKey ||
                      event.nativeEvent.isComposing
                    ) {
                      return
                    }

                    event.preventDefault()
                    if (canSubmit) event.currentTarget.form?.requestSubmit()
                  }}
                  onChange={(event) => {
                    setObjective(event.target.value)
                    setGenerationError(null)
                  }}
                  placeholder="Ask for advice, create a goal, or update your plan…"
                  aria-label="Message the planner advisor"
                  aria-description="Press Enter to submit, or Shift+Enter for a new line."
                  maxLength={2000}
                  disabled={isGenerating}
                />
                <InputGroupAddon align="block-end">
                  <input
                    ref={fileInputRef}
                    type="file"
                    multiple
                    className="sr-only"
                    onChange={onAttach}
                    tabIndex={-1}
                    aria-hidden="true"
                  />
                  <InputGroupButton
                    size="icon-sm"
                    variant="outline"
                    className="rounded-full"
                    aria-label="Attach context files"
                    disabled={isGenerating}
                    onClick={() => fileInputRef.current?.click()}
                  >
                    <Plus />
                  </InputGroupButton>
                  <InputGroupButton
                    type="submit"
                    size="icon-sm"
                    variant="default"
                    className="ml-auto rounded-full"
                    disabled={!canSubmit}
                    aria-label="Send message to planner advisor"
                  >
                    {isGenerating ? (
                      <LoaderCircle className="animate-spin" />
                    ) : (
                      <ArrowUp />
                    )}
                  </InputGroupButton>
                </InputGroupAddon>
              </InputGroup>
            </form>
          </SheetFooter>
        </SheetContent>
      </Sheet>

      <Dialog
        open={isCreatePlanOpen}
        onOpenChange={(open) => {
          if (isCreatingPlan) return
          setIsCreatePlanOpen(open)
          if (!open) setCreatePlanError(null)
        }}
      >
        <DialogContent className="sm:max-w-lg">
          <form onSubmit={onCreatePlan} className="flex flex-col gap-5">
            <DialogHeader>
              <DialogTitle>Create a goal manually</DialogTitle>
              <DialogDescription>
                Set the goal details, then add your steps one at a time.
              </DialogDescription>
            </DialogHeader>
            <FieldGroup>
              <Field>
                <FieldLabel htmlFor="new-plan-title">Title</FieldLabel>
                <Input
                  id="new-plan-title"
                  value={newPlanTitle}
                  onChange={(event) => setNewPlanTitle(event.target.value)}
                  maxLength={200}
                  required
                />
              </Field>
              <Field>
                <FieldLabel htmlFor="new-plan-description">
                  Description
                </FieldLabel>
                <Textarea
                  id="new-plan-description"
                  value={newPlanDescription}
                  onChange={(event) =>
                    setNewPlanDescription(event.target.value)
                  }
                  maxLength={2000}
                  rows={5}
                  required
                />
              </Field>
            </FieldGroup>
            {createPlanError && (
              <p role="alert" className="text-sm text-destructive">
                {createPlanError}
              </p>
            )}
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={() => setIsCreatePlanOpen(false)}
                disabled={isCreatingPlan}
              >
                Cancel
              </Button>
              <Button type="submit" disabled={isCreatingPlan}>
                {isCreatingPlan ? "Creating…" : "Create goal"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <AlertDialog
        open={isFireConfirmOpen}
        onOpenChange={(open) => {
          if (isMakingFire) return
          setIsFireConfirmOpen(open)
          if (!open) setFireModeError(null)
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Make this a Fire plan?</AlertDialogTitle>
            <AlertDialogDescription>
              This change is permanent. You won't be able to edit the plan
              yourself or switch it back to Casual. You will have to ask the AI
              to make changes.
            </AlertDialogDescription>
          </AlertDialogHeader>
          {fireModeError && (
            <p role="alert" className="text-sm text-destructive">
              {fireModeError}
            </p>
          )}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isMakingFire}>
              Cancel
            </AlertDialogCancel>
            <Button
              type="button"
              disabled={isMakingFire}
              onClick={() => void onMakeFire()}
            >
              {isMakingFire ? "Changing…" : "Ignite"}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog
        open={isInfernoConfirmOpen}
        onOpenChange={(open) => {
          if (isMakingInferno) return
          setIsInfernoConfirmOpen(open)
          if (!open) setInfernoModeError(null)
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Make this an Inferno plan?</AlertDialogTitle>
            <AlertDialogDescription>
              This is permanent. Neither you nor the AI can edit its tasks. The
              AI can still give advice, and the plan can only be deleted after
              every task is complete.
            </AlertDialogDescription>
          </AlertDialogHeader>
          {infernoModeError && (
            <p role="alert" className="text-sm text-destructive">
              {infernoModeError}
            </p>
          )}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isMakingInferno}>
              Cancel
            </AlertDialogCancel>
            <Button
              type="button"
              disabled={isMakingInferno}
              onClick={() => void onMakeInferno()}
            >
              {isMakingInferno ? "Changing…" : "Ignite"}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <Dialog
        open={isPlanEditorOpen}
        onOpenChange={(open) => {
          setIsPlanEditorOpen(open)
          if (!open) setPlanEditorError(null)
        }}
      >
        <DialogContent className="sm:max-w-lg">
          <form onSubmit={onSavePlan} className="flex flex-col gap-5">
            <DialogHeader>
              <DialogTitle>Edit goal</DialogTitle>
              <DialogDescription>
                Update the title and description shown on this goal.
              </DialogDescription>
            </DialogHeader>
            <FieldGroup>
              <Field>
                <FieldLabel htmlFor="plan-title">Title</FieldLabel>
                <Input
                  id="plan-title"
                  value={planTitleDraft}
                  onChange={(event) => setPlanTitleDraft(event.target.value)}
                  maxLength={200}
                  required
                />
              </Field>
              <Field>
                <FieldLabel htmlFor="plan-description">Description</FieldLabel>
                <Textarea
                  id="plan-description"
                  value={planDescriptionDraft}
                  onChange={(event) =>
                    setPlanDescriptionDraft(event.target.value)
                  }
                  maxLength={2000}
                  rows={5}
                  required
                />
              </Field>
            </FieldGroup>
            {planEditorError && (
              <p role="alert" className="text-sm text-destructive">
                {planEditorError}
              </p>
            )}
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={() => setIsPlanEditorOpen(false)}
                disabled={isSavingPlan}
              >
                Cancel
              </Button>
              <Button type="submit" disabled={isSavingPlan}>
                {isSavingPlan ? "Saving…" : "Save goal"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <AlertDialog
        open={isDeletePlanOpen}
        onOpenChange={(open) => {
          if (isDeletingPlan) return
          setIsDeletePlanOpen(open)
          if (!open) setPlanDeleteError(null)
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this goal?</AlertDialogTitle>
            <AlertDialogDescription>
              “{selectedPlan?.title}” and all of its steps will be permanently
              deleted. This cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          {planDeleteError && (
            <p role="alert" className="text-sm text-destructive">
              {planDeleteError}
            </p>
          )}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isDeletingPlan}>
              Cancel
            </AlertDialogCancel>
            <Button
              type="button"
              variant="destructive"
              disabled={isDeletingPlan}
              onClick={() => void onDeletePlan()}
            >
              {isDeletingPlan ? "Deleting…" : "Delete goal"}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog
        open={taskToDelete !== null}
        onOpenChange={(open) => {
          if (isDeletingTask) return
          if (!open) {
            setTaskToDelete(null)
            setTaskDeleteError(null)
          }
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this step?</AlertDialogTitle>
            <AlertDialogDescription>
              “{taskToDelete?.title}” will be permanently deleted.
              {taskDeleteDependents.length > 0 &&
                ` It will also be removed as a prerequisite from ${taskDeleteDependents
                  .map((task) => `“${task.title}”`)
                  .join(", ")}.`}
            </AlertDialogDescription>
          </AlertDialogHeader>
          {taskDeleteError && (
            <p role="alert" className="text-sm text-destructive">
              {taskDeleteError}
            </p>
          )}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isDeletingTask}>
              Cancel
            </AlertDialogCancel>
            <Button
              type="button"
              variant="destructive"
              disabled={isDeletingTask}
              onClick={() => void onDeleteTask()}
            >
              {isDeletingTask ? "Deleting…" : "Delete step"}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <Dialog
        open={taskToVerify !== null}
        onOpenChange={(open) => {
          if (isVerifyingTask) return
          if (!open) {
            setTaskToVerify(null)
            setTaskEvidenceFiles([])
            setTaskVerificationError(null)
            setTaskVerificationMessage(null)
          }
        }}
      >
        <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
          <form onSubmit={onVerifyTask} className="flex flex-col gap-5">
            <DialogHeader>
              <DialogTitle>Verify Inferno step completion</DialogTitle>
              <DialogDescription>
                Attach evidence that shows “{taskToVerify?.title}” is complete.
                AI must approve it before marking the step done. Inferno steps
                cannot be unchecked afterward.
              </DialogDescription>
            </DialogHeader>
            <input
              ref={verificationFileInputRef}
              type="file"
              multiple
              className="sr-only"
              onChange={onAttachTaskEvidence}
              tabIndex={-1}
              aria-hidden="true"
            />
            <Button
              type="button"
              variant="outline"
              className="justify-start"
              disabled={isVerifyingTask}
              onClick={() => verificationFileInputRef.current?.click()}
            >
              <Plus data-icon="inline-start" />
              Attach evidence
            </Button>
            {taskEvidenceFiles.length > 0 && (
              <div className="flex flex-col gap-2">
                {taskEvidenceFiles.map(({ id, file }) => (
                  <Attachment key={id} size="sm">
                    <AttachmentMedia>
                      <FileTextIcon />
                    </AttachmentMedia>
                    <AttachmentContent>
                      <AttachmentTitle>{file.name}</AttachmentTitle>
                    </AttachmentContent>
                    <AttachmentActions>
                      <AttachmentAction
                        type="button"
                        aria-label={`Remove ${file.name}`}
                        disabled={isVerifyingTask}
                        onClick={() => {
                          setTaskEvidenceFiles((current) =>
                            current.filter((item) => item.id !== id)
                          )
                          setTaskVerificationMessage(null)
                        }}
                      >
                        <XIcon />
                      </AttachmentAction>
                    </AttachmentActions>
                  </Attachment>
                ))}
              </div>
            )}
            {taskVerificationMessage && (
              <p role="status" className="text-sm text-muted-foreground">
                Evidence not verified: {taskVerificationMessage}
              </p>
            )}
            {taskVerificationError && (
              <p role="alert" className="text-sm text-destructive">
                {taskVerificationError}
              </p>
            )}
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={() => setTaskToVerify(null)}
                disabled={isVerifyingTask}
              >
                Cancel
              </Button>
              <Button
                type="submit"
                disabled={isVerifyingTask || taskEvidenceFiles.length === 0}
              >
                {isVerifyingTask ? (
                  <>
                    <LoaderCircle className="animate-spin" />
                    Reviewing…
                  </>
                ) : (
                  "Send to AI for review"
                )}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <Dialog
        open={isTaskEditorOpen}
        onOpenChange={(open) => {
          setIsTaskEditorOpen(open)
          if (!open) setTaskEditorError(null)
        }}
      >
        <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
          <form onSubmit={onSaveTask} className="flex flex-col gap-5">
            <DialogHeader>
              <DialogTitle>
                {editingTaskId ? "Edit step" : "Add a step"}
              </DialogTitle>
              <DialogDescription>
                Add a clear action and choose any earlier steps it depends on.
              </DialogDescription>
            </DialogHeader>
            <FieldGroup>
              <Field>
                <FieldLabel htmlFor="task-title">Step</FieldLabel>
                <Input
                  id="task-title"
                  value={taskDraft.title}
                  onChange={(event) =>
                    setTaskDraft((draft) => ({
                      ...draft,
                      title: event.target.value,
                    }))
                  }
                  maxLength={500}
                  required
                />
              </Field>
              <div className="grid grid-cols-2 gap-4">
                <Field>
                  <FieldLabel htmlFor="task-estimate">
                    Estimated minutes
                  </FieldLabel>
                  <Input
                    id="task-estimate"
                    type="number"
                    min={1}
                    max={10000}
                    step={1}
                    value={taskDraft.estimatedMinutes}
                    onChange={(event) =>
                      setTaskDraft((draft) => ({
                        ...draft,
                        estimatedMinutes: event.target.value,
                      }))
                    }
                    required
                  />
                </Field>
                <Field>
                  <FieldLabel htmlFor="task-category">
                    Category / phase
                  </FieldLabel>
                  <Input
                    id="task-category"
                    value={taskDraft.category}
                    onChange={(event) =>
                      setTaskDraft((draft) => ({
                        ...draft,
                        category: event.target.value,
                      }))
                    }
                    maxLength={100}
                    required
                  />
                  <FieldDescription>
                    Used to group and filter the step list.
                  </FieldDescription>
                </Field>
              </div>
              {rows && (
                <FieldSet>
                  <FieldLegend>Prerequisites</FieldLegend>
                  <FieldDescription>
                    These earlier steps must be completed first.
                  </FieldDescription>
                  <div className="flex max-h-40 flex-col gap-2 overflow-y-auto rounded-md border p-3">
                    {rows
                      .filter((row) => {
                        const currentPosition = editingTaskId
                          ? (taskById.get(editingTaskId)?.position ?? -1)
                          : Math.max(-1, ...rows.map((task) => task.position)) +
                            1
                        return row.position < currentPosition
                      })
                      .map((row) => (
                        <FieldLabel
                          key={row.id}
                          className="items-center rounded-md px-2 py-1.5 hover:bg-muted/50"
                        >
                          <Checkbox
                            checked={taskDraft.dependsOn.includes(row.id)}
                            onCheckedChange={(checked) =>
                              setTaskDraft((draft) => ({
                                ...draft,
                                dependsOn: checked
                                  ? [...draft.dependsOn, row.id]
                                  : draft.dependsOn.filter(
                                      (id) => id !== row.id
                                    ),
                              }))
                            }
                          />
                          <span className="min-w-0 flex-1 text-sm">
                            {row.title}
                            {row.completed && (
                              <span className="ml-2 text-xs text-muted-foreground">
                                Done
                              </span>
                            )}
                          </span>
                        </FieldLabel>
                      ))}
                    {rows.length === 0 && (
                      <p className="text-sm text-muted-foreground">
                        There are no earlier steps to select.
                      </p>
                    )}
                  </div>
                </FieldSet>
              )}
            </FieldGroup>
            {taskEditorError && (
              <p role="alert" className="text-sm text-destructive">
                {taskEditorError}
              </p>
            )}
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={() => setIsTaskEditorOpen(false)}
                disabled={isSavingTask}
              >
                Cancel
              </Button>
              <Button type="submit" disabled={isSavingTask}>
                {isSavingTask
                  ? "Saving…"
                  : editingTaskId
                    ? "Save step"
                    : "Add step"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  )
}
