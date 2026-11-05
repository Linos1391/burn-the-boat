import { useEffect, useState, type ReactNode } from "react"
import { Link, useLocation, useNavigate } from "react-router-dom"
import type { SupabaseClient } from "@supabase/supabase-js"
import { mapAuthUser, type User } from "@/lib/auth"
import { APP_ERRORS, getErrorMessage } from "@/lib/errors"
import { getProfileAvatarUrl, profileUpdatedEvent } from "@/lib/user-profiles"
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@/components/ui/sidebar"
import {
  ClipboardList,
  HouseIcon,
  LogOut,
  Settings2,
  UsersRound,
} from "lucide-react"
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar"

type BtbSidebarProps = {
  supabase: SupabaseClient | null
}

type Navigation = {
  icon: ReactNode
  title: string
  href: string
}

const navigations: Navigation[] = [
  { icon: <HouseIcon />, title: "Home", href: "/home" },
  { icon: <UsersRound />, title: "Pairing", href: "/pairing" },
  { icon: <ClipboardList />, title: "Planner", href: "/planner" },
  { icon: <Settings2 />, title: "Setting", href: "/setting" },
]

export default function BtbSidebar({ supabase }: BtbSidebarProps) {
  const { pathname } = useLocation()
  const navigate = useNavigate()
  const [user, setUser] = useState<User | null>(null)
  const [profileDisplayName, setProfileDisplayName] = useState<string>()
  const [avatarUrl, setAvatarUrl] = useState<string>()
  const [profileError, setProfileError] = useState<string | null>(null)
  const [signOutError, setSignOutError] = useState<string | null>(null)
  const [isSigningOut, setIsSigningOut] = useState(false)
  const userId = user?.uid

  useEffect(() => {
    if (!supabase) return
    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_event, session) => {
      const currentUser = mapAuthUser(session?.user ?? null)
      setUser(currentUser)
      setProfileDisplayName(undefined)
      setAvatarUrl(undefined)
      setProfileError(null)
    })
    return () => subscription.unsubscribe()
  }, [supabase])

  useEffect(() => {
    if (!supabase || !userId) return

    let active = true
    const loadAvatar = async () => {
      const { data, error } = await supabase
        .from("profiles")
        .select("display_name, avatar_path")
        .eq("id", userId)
        .single()

      if (!active) return
      if (error) {
        setProfileDisplayName(undefined)
        setAvatarUrl(undefined)
        setProfileError(getErrorMessage(error, APP_ERRORS.profile_load))
        return
      }

      setProfileDisplayName(data.display_name)
      setAvatarUrl(getProfileAvatarUrl(supabase, data.avatar_path))
      setProfileError(null)
    }

    const handleProfileUpdate = () => {
      void loadAvatar()
    }
    window.addEventListener(profileUpdatedEvent, handleProfileUpdate)
    void loadAvatar()

    return () => {
      active = false
      window.removeEventListener(profileUpdatedEvent, handleProfileUpdate)
    }
  }, [supabase, userId])

  function getInitials(name: string) {
    return (
      name
        .trim()
        .split(/\s+/)
        .slice(0, 2)
        .map((part) => part[0]?.toUpperCase() ?? "")
        .join("") || "U"
    )
  }

  async function handleSignOut() {
    if (!supabase) return

    setSignOutError(null)
    setIsSigningOut(true)
    try {
      if (user?.isAnonymous) {
        const { error } = await supabase.functions.invoke("delete-account")
        if (error) throw error
      }
      const { error } = await supabase.auth.signOut()
      if (error) throw error
      navigate("/login", { replace: true })
    } catch (error) {
      setSignOutError(getErrorMessage(error, APP_ERRORS.sign_out))
    } finally {
      setIsSigningOut(false)
    }
  }

  const sidebarDisplayName = profileDisplayName ?? "Guest Account"

  return (
    <Sidebar collapsible="offcanvas" variant="inset">
      <SidebarHeader className="flex-row items-center gap-3">
        <SidebarMenuButton
          render={<Link to="/home" />}
          size="lg"
          className="h-14 gap-3 rounded-xl px-2.5 transition-colors hover:bg-sidebar-accent/70"
        >
          <Avatar className="size-10 rounded-xl border border-border/70 bg-background p-1.5 shadow-sm ring-1 ring-border/40 after:rounded-xl">
            <AvatarImage
              src="/icon.svg"
              alt="Burn The Boat"
              className="object-contain"
            />
            <AvatarFallback className="rounded-xl text-xs font-semibold">
              BTB
            </AvatarFallback>
          </Avatar>
          <span className="flex min-w-0 flex-col gap-1">
            <span className="truncate text-[15px] leading-none font-semibold tracking-tight">
              Burn The Boat
            </span>
            <span className="truncate text-xs leading-none text-muted-foreground">
              Seize the island!
            </span>
          </span>
        </SidebarMenuButton>
      </SidebarHeader>
      <SidebarContent>
        <SidebarMenu>
          {navigations.map((navigation) => (
            <SidebarMenuItem key={navigation.href}>
              <SidebarMenuButton
                isActive={
                  pathname === navigation.href ||
                  (navigation.href === "/planner" &&
                    pathname.startsWith("/planner/"))
                }
                render={<Link to={navigation.href} />}
              >
                {navigation.icon}
                <span>{navigation.title}</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
          ))}
        </SidebarMenu>
      </SidebarContent>
      {user && (
        <SidebarFooter>
          <SidebarMenu>
            <SidebarMenuItem>
              <div className="flex min-w-0 items-center gap-2 px-2 py-1">
                <Avatar className="size-8">
                  <AvatarImage
                    src={avatarUrl}
                    alt={`${sidebarDisplayName} avatar`}
                  />
                  <AvatarFallback>
                    {getInitials(sidebarDisplayName)}
                  </AvatarFallback>
                </Avatar>
                <span className="truncate text-sm">{sidebarDisplayName}</span>
              </div>
              {profileError && (
                <p role="alert" className="px-2 text-xs text-destructive">
                  {profileError}
                </p>
              )}
              <SidebarMenuButton
                onClick={handleSignOut}
                disabled={isSigningOut}
              >
                <LogOut aria-hidden="true" />
                <span>
                  {isSigningOut
                    ? user.isAnonymous
                      ? "Deleting guest account..."
                      : "Signing out..."
                    : user.isAnonymous
                      ? "Delete guest account"
                      : "Sign out"}
                </span>
              </SidebarMenuButton>
              {signOutError && (
                <p role="alert" className="px-2 text-xs text-destructive">
                  {signOutError}
                </p>
              )}
            </SidebarMenuItem>
          </SidebarMenu>
        </SidebarFooter>
      )}
    </Sidebar>
  )
}
