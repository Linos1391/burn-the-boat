import { lazy, Suspense, useEffect, useState, type SubmitEvent } from "react"
import type { SupabaseClient } from "@supabase/supabase-js"
import { useNavigate } from "react-router-dom"
import { meetsPasswordRequirements, type User } from "@/lib/auth"
import {
  Camera,
  ChevronDown,
  KeyRound,
  LoaderCircle,
  Mail,
  Trash2,
  UserRoundPlus,
} from "lucide-react"
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
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
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { PayoutEmailCard } from "@/app/stake-payment"
import { APP_ERRORS, AppError, getErrorMessage } from "@/lib/errors"
import {
  avatarBucket,
  getProfileAvatarUrl,
  profileUpdatedEvent,
} from "@/lib/user-profiles"

const TransactionsCard = lazy(() => import("@/app/transactions"))

const acceptedAvatarTypes = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
}
const pendingGuestPasswordKey = "burn-the-boat:pending-guest-password-user"

type SettingPageProps = {
  supabase: SupabaseClient | null
  user: User
}

type Profile = {
  display_name: string
  avatar_path: string | null
}

type Feedback = {
  kind: "error" | "success"
  message: string
}

function initials(name: string) {
  return (
    name
      .trim()
      .split(/\s+/)
      .slice(0, 2)
      .map((part) => part[0]?.toUpperCase() ?? "")
      .join("") || "U"
  )
}

export default function SettingPage({ supabase, user }: SettingPageProps) {
  const navigate = useNavigate()
  const [profile, setProfile] = useState<Profile | null>(null)
  const [displayName, setDisplayName] = useState("")
  const [profileFeedback, setProfileFeedback] = useState<Feedback | null>(null)
  const [loadedUserId, setLoadedUserId] = useState<string | null>(null)
  const [profileSaving, setProfileSaving] = useState(false)
  const [avatarSaving, setAvatarSaving] = useState(false)
  const [email, setEmail] = useState(user.email ?? "")
  const [emailPassword, setEmailPassword] = useState("")
  const [emailFeedback, setEmailFeedback] = useState<Feedback | null>(null)
  const [emailSaving, setEmailSaving] = useState(false)
  const [currentPassword, setCurrentPassword] = useState("")
  const [newPassword, setNewPassword] = useState("")
  const [confirmPassword, setConfirmPassword] = useState("")
  const [passwordFeedback, setPasswordFeedback] = useState<Feedback | null>(
    null
  )
  const [passwordSaving, setPasswordSaving] = useState(false)
  const [accountDialog, setAccountDialog] = useState<
    "email" | "password" | "create-account" | null
  >(null)
  const [dismissedFinishAccountUserId, setDismissedFinishAccountUserId] =
    useState<string | null>(null)
  const [createAccountEmail, setCreateAccountEmail] = useState("")
  const [createAccountPassword, setCreateAccountPassword] = useState("")
  const [confirmCreateAccountPassword, setConfirmCreateAccountPassword] =
    useState("")
  const [createAccountFeedback, setCreateAccountFeedback] =
    useState<Feedback | null>(null)
  const [finishAccountFeedback, setFinishAccountFeedback] =
    useState<Feedback | null>(null)
  const [createAccountSaving, setCreateAccountSaving] = useState(false)
  const [isDeleteAccountOpen, setIsDeleteAccountOpen] = useState(false)
  const [isDeletingAccount, setIsDeletingAccount] = useState(false)
  const [deleteAccountError, setDeleteAccountError] = useState<string | null>(
    null
  )

  useEffect(() => {
    if (!supabase) return

    let active = true
    void (async () => {
      try {
        const { data, error } = await supabase
          .from("profiles")
          .select("display_name, avatar_path")
          .eq("id", user.uid)
          .single()
        if (!active) return
        if (error) {
          setProfileFeedback({
            kind: "error",
            message: getErrorMessage(error, APP_ERRORS.profile_load),
          })
          setLoadedUserId(user.uid)
          return
        }
        const loadedProfile = data as Profile
        setProfile(loadedProfile)
        setDisplayName(loadedProfile.display_name)
      } catch (error) {
        if (!active) return
        setProfileFeedback({
          kind: "error",
          message: getErrorMessage(error, APP_ERRORS.profile_load),
        })
      } finally {
        if (active) setLoadedUserId(user.uid)
      }
    })()

    return () => {
      active = false
    }
  }, [supabase, user.uid])

  async function verifyCurrentPassword(password: string) {
    if (user.providerId !== "email") return
    if (!supabase || !user.email || !password) {
      throw new Error("Enter your current password to confirm this change.")
    }
    const { data, error } = await supabase.auth.signInWithPassword({
      email: user.email,
      password,
    })
    if (error) throw new Error("Your current password wasn't recognized.")
    if (data.user?.id !== user.uid) {
      throw new Error("Unable to verify your current account.")
    }
  }

  async function saveProfile(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault()
    setProfileFeedback(null)
    if (!supabase || !profile) return

    const nextDisplayName = displayName.trim()
    if (!nextDisplayName || nextDisplayName.length > 254) {
      setProfileFeedback({
        kind: "error",
        message: "Display name must be between 1 and 254 characters.",
      })
      return
    }

    setProfileSaving(true)
    try {
      const { data, error } = await supabase
        .from("profiles")
        .update({
          display_name: nextDisplayName,
          updated_at: new Date().toISOString(),
        })
        .eq("id", user.uid)
        .select("display_name, avatar_path")
        .single()
      if (error) throw error

      const updatedProfile = data as Profile
      setProfile(updatedProfile)
      setDisplayName(updatedProfile.display_name)
      window.dispatchEvent(new Event(profileUpdatedEvent))
      setProfileFeedback({ kind: "success", message: "Profile saved." })
    } catch (error) {
      setProfileFeedback({ kind: "error", message: getErrorMessage(error) })
    } finally {
      setProfileSaving(false)
    }
  }

  async function uploadAvatar(file: File) {
    setProfileFeedback(null)
    if (!supabase || !profile) return
    const extension =
      acceptedAvatarTypes[file.type as keyof typeof acceptedAvatarTypes]
    if (!extension) {
      setProfileFeedback({
        kind: "error",
        message: "Choose a JPG, PNG, or WebP image.",
      })
      return
    }
    if (file.size > 2 * 1024 * 1024) {
      setProfileFeedback({
        kind: "error",
        message: "Avatar images must be 2 MB or smaller.",
      })
      return
    }

    const path = `${user.uid}/${crypto.randomUUID()}.${extension}`
    setAvatarSaving(true)
    try {
      const { error: uploadError } = await supabase.storage
        .from(avatarBucket)
        .upload(path, file, {
          cacheControl: "3600",
          contentType: file.type,
          upsert: false,
        })
      if (uploadError) throw uploadError

      const { error: updateError } = await supabase
        .from("profiles")
        .update({ avatar_path: path, updated_at: new Date().toISOString() })
        .eq("id", user.uid)
      if (updateError) {
        const { error: cleanupError } = await supabase.storage
          .from(avatarBucket)
          .remove([path])
        if (cleanupError) {
          throw new AppError(APP_ERRORS.avatar_save, cleanupError)
        }
        throw updateError
      }

      const oldPath = profile.avatar_path
      setProfile({ ...profile, avatar_path: path })
      window.dispatchEvent(new Event(profileUpdatedEvent))
      if (oldPath) {
        const { error: removeError } = await supabase.storage
          .from(avatarBucket)
          .remove([oldPath])
        if (removeError) {
          throw new AppError(APP_ERRORS.avatar_cleanup, removeError)
        }
      }
      setProfileFeedback({ kind: "success", message: "Avatar updated." })
    } catch (error) {
      setProfileFeedback({ kind: "error", message: getErrorMessage(error) })
    } finally {
      setAvatarSaving(false)
    }
  }

  async function removeAvatar() {
    setProfileFeedback(null)
    if (!supabase || !profile?.avatar_path) return

    setAvatarSaving(true)
    try {
      const oldPath = profile.avatar_path
      const { error } = await supabase
        .from("profiles")
        .update({ avatar_path: null, updated_at: new Date().toISOString() })
        .eq("id", user.uid)
      if (error) throw error
      setProfile({ ...profile, avatar_path: null })
      window.dispatchEvent(new Event(profileUpdatedEvent))
      const { error: removeError } = await supabase.storage
        .from(avatarBucket)
        .remove([oldPath])
      if (removeError) {
        throw new AppError(APP_ERRORS.avatar_cleanup, removeError)
      }
      setProfileFeedback({ kind: "success", message: "Avatar removed." })
    } catch (error) {
      setProfileFeedback({ kind: "error", message: getErrorMessage(error) })
    } finally {
      setAvatarSaving(false)
    }
  }

  async function changeEmail(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault()
    setEmailFeedback(null)
    if (!supabase) return
    if (email.trim().toLowerCase() === user.email?.toLowerCase()) {
      setEmailFeedback({
        kind: "error",
        message: "Enter an email address different from your current one.",
      })
      return
    }

    setEmailSaving(true)
    try {
      await verifyCurrentPassword(emailPassword)
      const { error } = await supabase.auth.updateUser({
        email: email.trim(),
      })
      if (error) throw error
      setEmailPassword("")
      setEmailFeedback({
        kind: "success",
        message:
          "Check your inbox to confirm the email change. Your current email stays active until confirmation.",
      })
    } catch (error) {
      setEmailFeedback({ kind: "error", message: getErrorMessage(error) })
    } finally {
      setEmailSaving(false)
    }
  }

  async function createAccount(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault()
    setCreateAccountFeedback(null)
    if (!supabase || !user.isAnonymous) return

    setCreateAccountSaving(true)
    try {
      window.localStorage.setItem(pendingGuestPasswordKey, user.uid)
      const { error } = await supabase.auth.updateUser({
        email: createAccountEmail.trim(),
      })
      if (error) {
        window.localStorage.removeItem(pendingGuestPasswordKey)
        throw error
      }
      setCreateAccountFeedback({
        kind: "success",
        message:
          "Check your email and confirm the address. Then return to Settings to set your password.",
      })
    } catch (error) {
      setCreateAccountFeedback({
        kind: "error",
        message: getErrorMessage(error),
      })
    } finally {
      setCreateAccountSaving(false)
    }
  }

  async function finishGuestAccount(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault()
    setFinishAccountFeedback(null)
    if (!supabase || !user.emailVerified || !user.email) {
      setFinishAccountFeedback({
        kind: "error",
        message: "Confirm your email before setting a password.",
      })
      return
    }
    if (createAccountPassword !== confirmCreateAccountPassword) {
      setFinishAccountFeedback({
        kind: "error",
        message: "The passwords don't match.",
      })
      return
    }
    if (!meetsPasswordRequirements(createAccountPassword)) {
      setFinishAccountFeedback({
        kind: "error",
        message:
          "Use at least 8 characters with an uppercase letter, a lowercase letter, a number, and a special character.",
      })
      return
    }

    setCreateAccountSaving(true)
    try {
      const { error } = await supabase.auth.updateUser({
        password: createAccountPassword,
      })
      if (error) throw error
      window.localStorage.removeItem(pendingGuestPasswordKey)
      setCreateAccountPassword("")
      setConfirmCreateAccountPassword("")
      setDismissedFinishAccountUserId(user.uid)
      setProfileFeedback({
        kind: "success",
        message:
          "Your account is ready. Your profile and saved data are unchanged.",
      })
    } catch (error) {
      setFinishAccountFeedback({
        kind: "error",
        message: getErrorMessage(error),
      })
    } finally {
      setCreateAccountSaving(false)
    }
  }

  async function changePassword(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault()
    setPasswordFeedback(null)
    if (!supabase) return
    if (newPassword !== confirmPassword) {
      setPasswordFeedback({
        kind: "error",
        message: "The new passwords don't match.",
      })
      return
    }
    if (!meetsPasswordRequirements(newPassword)) {
      setPasswordFeedback({
        kind: "error",
        message:
          "Use at least 8 characters with an uppercase letter, a lowercase letter, a number, and a special character.",
      })
      return
    }

    setPasswordSaving(true)
    try {
      await verifyCurrentPassword(currentPassword)
      const { error } = await supabase.auth.updateUser({
        password: newPassword,
      })
      if (error) throw error
      setCurrentPassword("")
      setNewPassword("")
      setConfirmPassword("")
      setPasswordFeedback({
        kind: "success",
        message: "Password updated.",
      })
    } catch (error) {
      setPasswordFeedback({ kind: "error", message: getErrorMessage(error) })
    } finally {
      setPasswordSaving(false)
    }
  }

  async function deleteAccount() {
    if (!supabase || isDeletingAccount) return

    setDeleteAccountError(null)
    setIsDeletingAccount(true)
    try {
      const { error } = await supabase.functions.invoke("delete-account")
      if (error) {
        if (error.context instanceof Response && error.context.status === 409) {
          throw new Error(
            "Resolve your active boat and pending payments before deleting your account."
          )
        }
        throw error
      }

      const { error: signOutError } = await supabase.auth.signOut({
        scope: "local",
      })
      if (signOutError) throw signOutError

      navigate("/login", { replace: true })
    } catch (error) {
      setDeleteAccountError(
        getErrorMessage(error, APP_ERRORS.delete_account)
      )
    } finally {
      setIsDeletingAccount(false)
    }
  }

  if (!supabase) {
    return (
      <main className="mx-auto flex w-full max-w-3xl flex-col gap-6 p-6">
        <p role="alert">
          Settings are unavailable because Supabase is not configured.
        </p>
      </main>
    )
  }

  const profileLoading = Boolean(supabase) && loadedUserId !== user.uid
  const profileBusy =
    profileLoading || !profile || profileSaving || avatarSaving
  const currentAvatarUrl = getProfileAvatarUrl(
    supabase,
    profile?.avatar_path ?? null
  )
  const isPendingPasswordSetup =
    user.emailVerified &&
    window.localStorage.getItem(pendingGuestPasswordKey) === user.uid
  const isFinishAccountOpen =
    isPendingPasswordSetup && dismissedFinishAccountUserId !== user.uid

  return (
    <main className="mx-auto flex w-full max-w-3xl flex-col gap-5 p-4 sm:p-6">
      <header className="flex flex-wrap items-center justify-between gap-4">
        <div className="flex flex-col gap-1">
          <h1 className="text-2xl font-semibold tracking-tight">Settings</h1>
          <p className="text-sm text-muted-foreground">
            Manage your profile and account access.
          </p>
        </div>
        <DropdownMenu>
          <DropdownMenuTrigger
            render={<Button variant="outline" />}
            aria-label="Account options"
          >
            Account options
            <ChevronDown aria-hidden="true" data-icon="inline-end" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="min-w-48">
            {user.isAnonymous ? (
              <DropdownMenuItem
                onClick={() => {
                  setCreateAccountEmail("")
                  setCreateAccountFeedback(null)
                  setAccountDialog("create-account")
                }}
              >
                <UserRoundPlus aria-hidden="true" />
                Create account
              </DropdownMenuItem>
            ) : (
              <DropdownMenuGroup>
                <DropdownMenuLabel>Sign-in details</DropdownMenuLabel>
                <DropdownMenuItem onClick={() => setAccountDialog("email")}>
                  <Mail aria-hidden="true" />
                  Change email
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => setAccountDialog("password")}>
                  <KeyRound aria-hidden="true" />
                  Change password
                </DropdownMenuItem>
              </DropdownMenuGroup>
            )}
            <DropdownMenuSeparator />
            <DropdownMenuGroup>
              <DropdownMenuItem
                variant="destructive"
                onClick={() => {
                  setDeleteAccountError(null)
                  setIsDeleteAccountOpen(true)
                }}
              >
                <Trash2 aria-hidden="true" />
                Delete account
              </DropdownMenuItem>
            </DropdownMenuGroup>
          </DropdownMenuContent>
        </DropdownMenu>
      </header>

      <Card>
        <CardHeader>
          <CardTitle>Your profile</CardTitle>
          <CardDescription>
            This is how you appear to people you pair with.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-5">
          {profileLoading && (
            <p role="status" className="text-sm text-muted-foreground">
              Loading profile...
            </p>
          )}
          <div className="flex flex-wrap items-center gap-4">
            <Avatar size="lg" className="size-16">
              <AvatarImage
                src={currentAvatarUrl}
                alt={`${displayName} avatar`}
              />
              <AvatarFallback>
                {initials(displayName || user.email || "User")}
              </AvatarFallback>
            </Avatar>
            <div className="flex flex-wrap gap-2">
              <label className="inline-flex">
                <Input
                  type="file"
                  accept="image/jpeg,image/png,image/webp"
                  className="sr-only w-px!"
                  disabled={profileBusy}
                  aria-label="Upload avatar image"
                  onChange={(event) => {
                    const input = event.currentTarget
                    const file = input.files?.[0]
                    input.value = ""
                    if (file) void uploadAvatar(file)
                  }}
                />
                <span
                  aria-disabled={profileBusy}
                  className="inline-flex h-8 cursor-pointer items-center justify-center gap-1.5 rounded-lg border border-border bg-background px-2.5 text-sm font-medium hover:bg-muted aria-disabled:pointer-events-none aria-disabled:opacity-50"
                >
                  {avatarSaving ? (
                    <LoaderCircle aria-hidden="true" className="animate-spin" />
                  ) : (
                    <Camera aria-hidden="true" data-icon="inline-start" />
                  )}
                  Upload avatar
                </span>
              </label>
              {profile?.avatar_path && (
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => void removeAvatar()}
                  disabled={profileBusy}
                >
                  <Trash2 data-icon="inline-start" aria-hidden="true" />
                  Remove
                </Button>
              )}
            </div>
            <p className="basis-full text-xs text-muted-foreground">
              JPG, PNG, or WebP. Maximum file size: 2 MB.
            </p>
          </div>

          <form onSubmit={saveProfile} className="flex flex-col gap-4">
            <FieldGroup>
              <Field>
                <FieldLabel htmlFor="display-name">Display name</FieldLabel>
                <Input
                  id="display-name"
                  autoComplete="name"
                  maxLength={254}
                  value={displayName}
                  onChange={(event) => setDisplayName(event.target.value)}
                  disabled={profileBusy}
                  required
                />
              </Field>
            </FieldGroup>
            {profileFeedback && (
              <p
                role={profileFeedback.kind === "error" ? "alert" : "status"}
                className={
                  profileFeedback.kind === "error"
                    ? "text-sm text-destructive"
                    : "text-sm text-muted-foreground"
                }
              >
                {profileFeedback.message}
              </p>
            )}
            <Button type="submit" disabled={profileBusy} className="self-start">
              {profileSaving ? "Saving..." : "Save profile"}
            </Button>
          </form>
        </CardContent>
      </Card>

      <PayoutEmailCard supabase={supabase} userId={user.uid} />

      {supabase && (
        <Suspense fallback={null}>
          <TransactionsCard supabase={supabase} />
        </Suspense>
      )}

      <Dialog
        open={accountDialog === "create-account"}
        onOpenChange={(open) => {
          if (!createAccountSaving && !open) setAccountDialog(null)
        }}
      >
        <DialogContent className="max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Create an account</DialogTitle>
            <DialogDescription>
              Link a verified email to this guest account to keep your profile,
              plans, and pairings. After confirming the email, return here to
              set a password.
            </DialogDescription>
          </DialogHeader>
          <form onSubmit={createAccount} className="flex flex-col gap-4">
            <FieldGroup>
              <Field>
                <FieldLabel htmlFor="create-account-email">
                  Email address
                </FieldLabel>
                <Input
                  id="create-account-email"
                  type="email"
                  autoComplete="email"
                  value={createAccountEmail}
                  onChange={(event) =>
                    setCreateAccountEmail(event.target.value)
                  }
                  required
                />
              </Field>
            </FieldGroup>
            {createAccountFeedback && (
              <p
                role={
                  createAccountFeedback.kind === "error" ? "alert" : "status"
                }
                className={
                  createAccountFeedback.kind === "error"
                    ? "text-sm text-destructive"
                    : "text-sm text-muted-foreground"
                }
              >
                {createAccountFeedback.message}
              </p>
            )}
            <Button
              type="submit"
              disabled={
                createAccountSaving || createAccountFeedback?.kind === "success"
              }
            >
              {createAccountSaving && (
                <LoaderCircle
                  aria-hidden="true"
                  className="animate-spin"
                  data-icon="inline-start"
                />
              )}
              {createAccountSaving
                ? "Sending confirmation..."
                : createAccountFeedback?.kind === "success"
                  ? "Confirmation sent"
                  : "Continue"}
            </Button>
          </form>
        </DialogContent>
      </Dialog>

      <Dialog
        open={isFinishAccountOpen}
        onOpenChange={(open) => {
          if (!createAccountSaving && !open) {
            setDismissedFinishAccountUserId(user.uid)
          }
        }}
      >
        <DialogContent className="max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Set your password</DialogTitle>
            <DialogDescription>
              Your email is confirmed. Choose a password to finish creating your
              account.
            </DialogDescription>
          </DialogHeader>
          <form onSubmit={finishGuestAccount} className="flex flex-col gap-4">
            <FieldGroup>
              <Field>
                <FieldLabel htmlFor="create-account-password">
                  Password
                </FieldLabel>
                <Input
                  id="create-account-password"
                  type="password"
                  autoComplete="new-password"
                  value={createAccountPassword}
                  onChange={(event) =>
                    setCreateAccountPassword(event.target.value)
                  }
                  required
                />
                <FieldDescription>
                  At least 8 characters, including uppercase and lowercase
                  letters, a number, and a symbol.
                </FieldDescription>
              </Field>
              <Field>
                <FieldLabel htmlFor="confirm-create-account-password">
                  Confirm password
                </FieldLabel>
                <Input
                  id="confirm-create-account-password"
                  type="password"
                  autoComplete="new-password"
                  value={confirmCreateAccountPassword}
                  onChange={(event) =>
                    setConfirmCreateAccountPassword(event.target.value)
                  }
                  required
                />
              </Field>
            </FieldGroup>
            {finishAccountFeedback && (
              <p
                role={
                  finishAccountFeedback.kind === "error" ? "alert" : "status"
                }
                className={
                  finishAccountFeedback.kind === "error"
                    ? "text-sm text-destructive"
                    : "text-sm text-muted-foreground"
                }
              >
                {finishAccountFeedback.message}
              </p>
            )}
            <Button type="submit" disabled={createAccountSaving}>
              {createAccountSaving && (
                <LoaderCircle
                  aria-hidden="true"
                  className="animate-spin"
                  data-icon="inline-start"
                />
              )}
              {createAccountSaving
                ? "Saving password..."
                : "Finish account setup"}
            </Button>
          </form>
        </DialogContent>
      </Dialog>

      <Dialog
        open={accountDialog === "email"}
        onOpenChange={(open) => {
          if (!open) setAccountDialog(null)
        }}
      >
        <DialogContent className="max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Change email</DialogTitle>
            <DialogDescription>
              We’ll send a confirmation link before your email address changes.
            </DialogDescription>
          </DialogHeader>
          <form onSubmit={changeEmail} className="flex flex-col gap-4">
            <FieldGroup>
              <Field>
                <FieldLabel htmlFor="account-email">Email address</FieldLabel>
                <Input
                  id="account-email"
                  type="email"
                  autoComplete="email"
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                  required
                />
              </Field>
              {user.providerId === "email" && (
                <Field>
                  <FieldLabel htmlFor="email-current-password">
                    Current password
                  </FieldLabel>
                  <Input
                    id="email-current-password"
                    type="password"
                    autoComplete="current-password"
                    value={emailPassword}
                    onChange={(event) => setEmailPassword(event.target.value)}
                    required
                  />
                </Field>
              )}
            </FieldGroup>
            {emailFeedback && (
              <p
                role={emailFeedback.kind === "error" ? "alert" : "status"}
                className={
                  emailFeedback.kind === "error"
                    ? "text-sm text-destructive"
                    : "text-sm text-muted-foreground"
                }
              >
                {emailFeedback.message}
              </p>
            )}
            <Button type="submit" disabled={emailSaving}>
              {emailSaving ? "Sending confirmation..." : "Change email"}
            </Button>
          </form>
        </DialogContent>
      </Dialog>

      <Dialog
        open={accountDialog === "password"}
        onOpenChange={(open) => {
          if (!open) setAccountDialog(null)
        }}
      >
        <DialogContent className="max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Change password</DialogTitle>
            <DialogDescription>
              Choose a strong password you haven’t used before.
            </DialogDescription>
          </DialogHeader>
          <form onSubmit={changePassword} className="flex flex-col gap-4">
            <FieldGroup>
              {user.providerId === "email" && (
                <Field>
                  <FieldLabel htmlFor="current-password">
                    Current password
                  </FieldLabel>
                  <Input
                    id="current-password"
                    type="password"
                    autoComplete="current-password"
                    value={currentPassword}
                    onChange={(event) => setCurrentPassword(event.target.value)}
                    required
                  />
                </Field>
              )}
              <Field>
                <FieldLabel htmlFor="new-password">New password</FieldLabel>
                <Input
                  id="new-password"
                  type="password"
                  autoComplete="new-password"
                  minLength={8}
                  value={newPassword}
                  onChange={(event) => setNewPassword(event.target.value)}
                  required
                />
                <FieldDescription>
                  At least 8 characters, including uppercase, lowercase, a
                  number, and a special character.
                </FieldDescription>
              </Field>
              <Field>
                <FieldLabel htmlFor="confirm-new-password">
                  Confirm new password
                </FieldLabel>
                <Input
                  id="confirm-new-password"
                  type="password"
                  autoComplete="new-password"
                  minLength={8}
                  value={confirmPassword}
                  onChange={(event) => setConfirmPassword(event.target.value)}
                  required
                />
              </Field>
            </FieldGroup>
            {passwordFeedback && (
              <p
                role={passwordFeedback.kind === "error" ? "alert" : "status"}
                className={
                  passwordFeedback.kind === "error"
                    ? "text-sm text-destructive"
                    : "text-sm text-muted-foreground"
                }
              >
                {passwordFeedback.message}
              </p>
            )}
            <Button type="submit" disabled={passwordSaving}>
              {passwordSaving ? "Updating..." : "Update password"}
            </Button>
          </form>
        </DialogContent>
      </Dialog>

      <AlertDialog
        open={isDeleteAccountOpen}
        onOpenChange={(open) => {
          if (isDeletingAccount) return
          setIsDeleteAccountOpen(open)
          if (!open) setDeleteAccountError(null)
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete your account?</AlertDialogTitle>
            <AlertDialogDescription>
              Your account, profile, invites, plans, and chat history will be
              permanently deleted. Your pairings will also be removed for your
              partners. This cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          {deleteAccountError && (
            <p role="alert" className="text-sm text-destructive">
              {deleteAccountError}
            </p>
          )}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isDeletingAccount}>
              Cancel
            </AlertDialogCancel>
            <Button
              type="button"
              variant="destructive"
              disabled={isDeletingAccount}
              onClick={() => void deleteAccount()}
            >
              {isDeletingAccount ? "Deleting..." : "Delete account"}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </main>
  )
}
