import {
  Sidebar,
  SidebarContent,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@/components/ui/sidebar"
import { HouseIcon, Settings2 } from "lucide-react"
import { Link, useLocation } from "react-router-dom"
import type { ReactNode } from "react"

type Navigation = {
  icon: ReactNode
  title: string
  href: string
}

const navigations: Navigation[] = [
  { icon: <HouseIcon />, title: "Home", href: "/home" },
  { icon: <Settings2 />, title: "Setting", href: "/setting"}
]

export default function BtbSidebar() {
  const { pathname } = useLocation()

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
    </Sidebar>
  )
}
