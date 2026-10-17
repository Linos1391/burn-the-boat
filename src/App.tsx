import { useEffect, useState } from "react"
import { Navigate, Route, Routes, BrowserRouter } from "react-router-dom"
import { getAuth, onAuthStateChanged, type User } from "firebase/auth"

import {
  SidebarInset,
  SidebarProvider,
  SidebarTrigger,
} from "./components/ui/sidebar"
import { Skeleton } from "./components/ui/skeleton"
import BtbSidebar from "./app/sidebar"
import HomePage from "./app/home"
import SettingPage from "./app/setting"
import LoginPage from "./app/login"
import VerifyEmailPage from "./app/verify-email"
import { firebaseApp } from "./lib/firebase"

type AuthStatus = "loading" | "authenticated" | "unauthenticated" | "error"

function requiresEmailVerification(user: User) {
  return (
    user.providerData.some((provider) => provider.providerId === "password") &&
    !user.emailVerified
  )
}

function AppLayout() {
  const auth = firebaseApp ? getAuth(firebaseApp) : null
  const [authStatus, setAuthStatus] = useState<AuthStatus>("loading")
  const [user, setUser] = useState<User | null>(null)

  useEffect(() => {
    if (!auth) {
      setUser(null)
      setAuthStatus("unauthenticated")
      return
    }

    return onAuthStateChanged(
      auth,
      (currentUser) => {
        setUser(currentUser)
        setAuthStatus(currentUser ? "authenticated" : "unauthenticated")
      },
      (error) => {
        console.error("Failed to determine the current Firebase user.", error)
        setAuthStatus("error")
      }
    )
  }, [auth])

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
    <SidebarProvider>
      <BtbSidebar firebaseApp={firebaseApp} />
      <SidebarInset>
        <SidebarTrigger />
        <Routes>
          <Route path="/home" element={<HomePage />} />
          <Route path="/setting" element={<SettingPage />} />
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
        <Route
          path="/login"
          element={<LoginPage firebaseApp={firebaseApp} />}
        />
        <Route
          path="/verify-email"
          element={<VerifyEmailPage firebaseApp={firebaseApp} />}
        />
        <Route path="/" element={<Navigate to="/login" replace />} />
        <Route path="/*" element={<AppLayout />} />
      </Routes>
    </BrowserRouter>
  )
}
