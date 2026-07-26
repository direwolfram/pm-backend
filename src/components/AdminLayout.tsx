import { useState } from "react";
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
  PanelLeftClose,
  PanelLeftOpen,
} from "lucide-react";
import { Toaster } from "@/components/ui/sonner";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

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

const NAV_ITEMS = NAV.flatMap((section) => section.items);

const SIDEBAR_LINK_BASE =
  "group relative flex w-full items-center rounded-md text-[13px] text-sidebar-foreground transition-colors hover:bg-[#F5F5F4] hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";

const SIDEBAR_LINK_ACTIVE =
  "bg-[#EFF6FF] font-medium text-primary ring-1 ring-inset ring-[#BFDBFE] hover:bg-[#EFF6FF] hover:text-primary";

const SIDEBAR_ICON_LINK_BASE =
  "flex h-10 w-10 items-center justify-center rounded-md text-[#73737A] transition-colors hover:bg-[#F5F5F4] hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";

const SIDEBAR_ICON_LINK_ACTIVE =
  "bg-[#EFF6FF] text-primary ring-1 ring-inset ring-[#BFDBFE] hover:bg-[#EFF6FF] hover:text-primary";

export default function AdminLayout() {
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);

  return (
    <TooltipProvider delayDuration={150}>
      <div
        className={cn(
          "min-h-screen w-full bg-background text-foreground md:grid",
          sidebarCollapsed
            ? "md:grid-cols-[56px_minmax(0,1fr)]"
            : "md:grid-cols-[244px_minmax(0,1fr)]",
        )}
      >
        <aside className="sticky top-0 hidden h-screen border-r bg-sidebar text-sidebar-foreground md:flex md:flex-col">
          <div
            className={cn(
              "flex h-14 items-center border-b",
              sidebarCollapsed ? "justify-center px-2" : "justify-between gap-3 px-4",
            )}
          >
            <div
              className={cn(
                "min-w-0",
                sidebarCollapsed && "sr-only",
              )}
            >
              <p className="truncate text-sm font-semibold leading-tight text-foreground">PocketMart</p>
              <p className="truncate text-xs text-muted-foreground">Operations backoffice</p>
            </div>
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  aria-label={sidebarCollapsed ? "Expand sidebar" : "Collapse sidebar"}
                  aria-pressed={sidebarCollapsed}
                  onClick={() => setSidebarCollapsed((collapsed) => !collapsed)}
                  className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md text-[#73737A] transition-colors hover:bg-[#F5F5F4] hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  {sidebarCollapsed ? (
                    <PanelLeftOpen className="h-4 w-4" />
                  ) : (
                    <PanelLeftClose className="h-4 w-4" />
                  )}
                </button>
              </TooltipTrigger>
              <TooltipContent side="right">
                {sidebarCollapsed ? "Expand sidebar" : "Collapse sidebar"}
              </TooltipContent>
            </Tooltip>
          </div>
          <nav className={cn("flex-1 overflow-y-auto", sidebarCollapsed ? "px-2 py-3" : "px-3 py-4")}>
            {sidebarCollapsed ? (
              <div className="flex flex-col items-center gap-2">
                {NAV_ITEMS.map((item) => (
                  <Tooltip key={item.to}>
                    <TooltipTrigger asChild>
                      <NavLink
                        to={item.to}
                        end={item.to === "/"}
                        aria-label={item.label}
                        className={({ isActive }) =>
                          cn(
                            SIDEBAR_ICON_LINK_BASE,
                            isActive && SIDEBAR_ICON_LINK_ACTIVE,
                          )
                        }
                      >
                        <item.icon className="h-5 w-5 shrink-0" />
                      </NavLink>
                    </TooltipTrigger>
                    <TooltipContent side="right">{item.label}</TooltipContent>
                  </Tooltip>
                ))}
              </div>
            ) : (
              NAV.map((section) => (
                <div key={section.group} className="mb-5">
                  <p className="mb-1.5 px-2 text-xs font-medium text-muted-foreground">
                    {section.group}
                  </p>
                  <div className="space-y-1">
                    {section.items.map((item) => (
                      <NavLink
                        key={item.to}
                        to={item.to}
                        end={item.to === "/"}
                        className={({ isActive }) =>
                          cn(
                            SIDEBAR_LINK_BASE,
                            "h-8 gap-2 px-2",
                            isActive && ["active", SIDEBAR_LINK_ACTIVE],
                          )
                        }
                      >
                        <span className="absolute left-0 top-1/2 h-5 w-0.5 -translate-y-1/2 rounded-full bg-primary opacity-0 transition-opacity group-[.active]:opacity-100" />
                        <item.icon className="h-4 w-4 shrink-0" />
                        <span className="truncate">{item.label}</span>
                      </NavLink>
                    ))}
                  </div>
                </div>
              ))
            )}
          </nav>
        </aside>

        <main className="min-w-0 overflow-x-hidden">
          <div className="sticky top-0 z-20 border-b bg-card/95 backdrop-blur md:hidden">
            <div className="flex h-14 items-center gap-2 px-4">
              <div className="flex h-8 w-8 items-center justify-center rounded-md bg-primary text-primary-foreground">
                <ShoppingCart className="h-4 w-4" />
              </div>
              <div>
                <p className="text-sm font-semibold leading-tight">PocketMart</p>
                <p className="text-xs text-muted-foreground">Operations</p>
              </div>
            </div>
            <nav className="flex gap-1 overflow-x-auto border-t px-3 py-2">
              {NAV.flatMap((section) => section.items).map((item) => (
                <NavLink
                  key={item.to}
                  to={item.to}
                  end={item.to === "/"}
                  className={({ isActive }) =>
                    cn(
                      "flex h-8 shrink-0 items-center gap-1.5 rounded-md px-2.5 text-[13px] text-muted-foreground",
                      isActive && "bg-[#EFF6FF] font-medium text-primary",
                    )
                  }
                >
                  <item.icon className="h-4 w-4" />
                  {item.label}
                </NavLink>
              ))}
            </nav>
          </div>
          <div className="w-full p-4 md:p-6 xl:p-8">
            <Outlet />
          </div>
        </main>
      </div>
      <Toaster richColors position="top-right" />
    </TooltipProvider>
  );
}
