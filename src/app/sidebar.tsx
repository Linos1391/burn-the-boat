import { useEffect, useState, type ReactNode } from "react"
import { Link, useLocation, useNavigate } from "react-router-dom"
import {
  deleteUser,
  getAuth,
  onAuthStateChanged,
  signOut,
  type User,
} from "firebase/auth"
import type { FirebaseApp } from "firebase/app"
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
  HouseIcon,
  LogOut,
  Settings2,
  UserRound,
  UsersRound,
} from "lucide-react"

type BtbSidebarProps = {
  firebaseApp: FirebaseApp | null
}

type Navigation = {
  icon: ReactNode
  title: string
  href: string
}

const navigations: Navigation[] = [
  { icon: <HouseIcon />, title: "Home", href: "/home" },
  { icon: <UsersRound />, title: "Pairing", href: "/pairing" },
  { icon: <Settings2 />, title: "Setting", href: "/setting" },
]

export default function BtbSidebar({ firebaseApp }: BtbSidebarProps) {
  const { pathname } = useLocation()
  const navigate = useNavigate()
  const auth = firebaseApp ? getAuth(firebaseApp) : null
  const [user, setUser] = useState<User | null>(null)
  const [signOutError, setSignOutError] = useState<string | null>(null)
  const [isSigningOut, setIsSigningOut] = useState(false)

  useEffect(() => {
    if (!auth) return

    return onAuthStateChanged(auth, setUser)
  }, [auth])

  async function handleSignOut() {
    if (!auth) return

    setSignOutError(null)
    setIsSigningOut(true)
    try {
      if (user?.isAnonymous) {
        await deleteUser(user)
      } else {
        await signOut(auth)
      }
      navigate("/login", { replace: true })
    } catch (error) {
      setSignOutError(
        error instanceof Error
          ? error.message
          : "Unable to sign out. Please try again."
      )
    } finally {
      setIsSigningOut(false)
    }
  }

  return (
    <Sidebar collapsible="offcanvas" variant="inset">
      <SidebarHeader className="flex-row items-center gap-3">
        <SidebarMenuButton render={<a href="#"></a>}>
          <span className="text-sm font-semibold">Burn The Boat</span>
        </SidebarMenuButton>
      </SidebarHeader>
      <SidebarContent>
        <SidebarMenu>
          {navigations.map((navigation) => (
            <SidebarMenuItem key={navigation.href}>
              <SidebarMenuButton
                isActive={pathname === navigation.href}
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
                <UserRound aria-hidden="true" className="size-4 shrink-0" />
                <span className="truncate text-sm">
                  {user.email ?? "Guest Account"}
                </span>
              </div>
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
