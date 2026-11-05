import { useEffect, useState } from "react"
import {
  Navigate,
  Route,
  Routes,
  BrowserRouter,
  useLocation,
} from "react-router-dom"

import {
  SidebarInset,
  SidebarProvider,
  SidebarTrigger,
} from "./components/ui/sidebar"
import { Skeleton } from "./components/ui/skeleton"
import BtbSidebar from "./app/sidebar"
import HomePage from "./app/home"
import PairingPage from "./app/pairing"
import PlannerPage from "./app/planner"
import SettingPage from "./app/setting"
import LoginPage from "./app/login"
import VerifyEmailPage from "./app/verify-email"
import { supabase } from "./lib/supabase"
import { mapAuthUser, type User } from "./lib/auth"

type AuthStatus = "loading" | "authenticated" | "unauthenticated" | "error"

function requiresEmailVerification(user: User) {
  return !user.isAnonymous && user.providerId === "email" && !user.emailVerified
}

function AppLayout() {
  const location = useLocation()
  const [authStatus, setAuthStatus] = useState<AuthStatus>(
    supabase ? "loading" : "unauthenticated"
  )
  const [user, setUser] = useState<User | null>(null)

  useEffect(() => {
    if (!supabase) {
      return
    }

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_event, session) => {
      const currentUser = mapAuthUser(session?.user ?? null)
      setUser(currentUser)
      setAuthStatus(currentUser ? "authenticated" : "unauthenticated")
    })
    return () => subscription.unsubscribe()
  }, [])

  if (authStatus === "loading") {
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

  if (authStatus === "unauthenticated") {
    return <Navigate to="/login" replace />
  }

  if (
    authStatus === "authenticated" &&
    user &&
    requiresEmailVerification(user)
  ) {
    return <Navigate to="/verify-email" replace />
  }

  if (authStatus === "error") {
    return (
      <main className="flex min-h-svh items-center justify-center p-6">
        <p role="alert">
          We couldn&apos;t verify your sign-in status. Refresh the page and try
          again.
        </p>
      </main>
    )
  }

  return (
    <SidebarProvider className="h-svh min-h-0 overflow-hidden">
      <BtbSidebar supabase={supabase} />
      <SidebarInset className="min-h-0 overflow-y-auto">
        <SidebarTrigger />
        {user && supabase && (
          <div hidden={location.pathname !== "/planner"}>
            <PlannerPage key={user.uid} supabase={supabase} user={user} />
          </div>
        )}
        <Routes>
          <Route
            path="/home"
            element={<HomePage supabase={supabase} user={user} />}
          />
          <Route
            path="/pairing"
            element={
              user && supabase ? (
                <PairingPage supabase={supabase} user={user} />
              ) : (
                <Navigate to="/login" replace />
              )
            }
          />
          <Route path="/planner" element={null} />
          <Route
            path="/setting"
            element={
              user && supabase ? (
                <SettingPage supabase={supabase} user={user} />
              ) : (
                <Navigate to="/login" replace />
              )
            }
          />
          <Route path="*" element={<Navigate to="/login" replace />} />
        </Routes>
      </SidebarInset>
    </SidebarProvider>
  )
}

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/login" element={<LoginPage supabase={supabase} />} />
        <Route
          path="/verify-email"
          element={<VerifyEmailPage supabase={supabase} />}
        />
        <Route path="/" element={<Navigate to="/login" replace />} />
        <Route path="/*" element={<AppLayout />} />
      </Routes>
    </BrowserRouter>
  )
}
