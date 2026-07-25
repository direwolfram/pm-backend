import { NavLink, Outlet } from "react-router";
import {
  LayoutDashboard,
  Package,
  FolderTree,
  Tag,
  Boxes,
  TicketPercent,
  LayoutGrid,
  Store,
  ShoppingCart,
  Users,
} from "lucide-react";
import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarTrigger,
} from "@/components/ui/sidebar";
import { Toaster } from "@/components/ui/sonner";

const NAV = [
  {
    group: "Overview",
    items: [{ to: "/", label: "Dashboard", icon: LayoutDashboard }],
  },
  {
    group: "Catalog",
    items: [
      { to: "/products", label: "Products", icon: Package },
      { to: "/categories", label: "Categories", icon: FolderTree },
      { to: "/brands", label: "Brands", icon: Tag },
    ],
  },
  {
    group: "Operations",
    items: [
      { to: "/inventory", label: "Inventory", icon: Boxes },
      { to: "/orders", label: "Orders", icon: ShoppingCart },
      { to: "/stores", label: "Stores & Zones", icon: Store },
    ],
  },
  {
    group: "Marketing",
    items: [
      { to: "/promotions", label: "Promotions", icon: TicketPercent },
      { to: "/home-sections", label: "Home Sections", icon: LayoutGrid },
    ],
  },
  {
    group: "People",
    items: [{ to: "/customers", label: "Customers", icon: Users }],
  },
];

export default function AdminLayout() {
  return (
    <SidebarProvider>
      <div className="flex min-h-screen w-full">
        <Sidebar>
          <SidebarHeader className="border-b px-4 py-4">
            <div className="flex items-center gap-2">
              <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-emerald-600 text-white">
                <ShoppingCart className="h-4 w-4" />
              </div>
              <div>
                <p className="text-sm font-semibold leading-tight">PocketMart</p>
                <p className="text-xs text-muted-foreground">Admin Backoffice</p>
              </div>
            </div>
          </SidebarHeader>
          <SidebarContent>
            {NAV.map((section) => (
              <SidebarGroup key={section.group}>
                <SidebarGroupLabel>{section.group}</SidebarGroupLabel>
                <SidebarGroupContent>
                  <SidebarMenu>
                    {section.items.map((item) => (
                      <SidebarMenuItem key={item.to}>
                        <SidebarMenuButton asChild>
                          <NavLink
                            to={item.to}
                            end={item.to === "/"}
                            className={({ isActive }) =>
                              isActive ? "bg-accent font-medium" : ""
                            }
                          >
                            <item.icon className="h-4 w-4" />
                            <span>{item.label}</span>
                          </NavLink>
                        </SidebarMenuButton>
                      </SidebarMenuItem>
                    ))}
                  </SidebarMenu>
                </SidebarGroupContent>
              </SidebarGroup>
            ))}
          </SidebarContent>
        </Sidebar>
        <main className="flex-1 overflow-x-hidden">
          <div className="border-b px-4 py-2 md:hidden">
            <SidebarTrigger />
          </div>
          <div className="mx-auto max-w-6xl p-4 md:p-6">
            <Outlet />
          </div>
        </main>
      </div>
      <Toaster richColors position="top-right" />
    </SidebarProvider>
  );
}
