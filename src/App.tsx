import { Navigate, Route, Routes } from "react-router-dom"

import {
  SidebarInset,
  SidebarProvider,
  SidebarTrigger,
} from "./components/ui/sidebar"
import BtbSidebar from "./app/sidebar"
import HomePage from "./app/home"
import SettingPage from "./app/setting"
import LoginPage from "./app/login"

function AppLayout() {
  return (
    <SidebarProvider>
      <BtbSidebar />
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
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route path="/" element={<Navigate to="/login" replace />} />
      <Route path="/*" element={<AppLayout />} />
    </Routes>
  )
}
