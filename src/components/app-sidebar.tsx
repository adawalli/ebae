"use client";

import type { StatusInfo } from "@/lib/types";
import { duration } from "@/lib/format";
import { ThemeToggle } from "./theme-toggle";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from "@/components/ui/sidebar";

const MONO = "var(--font-mono), ui-monospace, monospace";

type NavItem = { key: "searches" | "alerts" | "status"; label: string; badge: number | null };

export function AppSidebar({
  view,
  setView,
  navItems,
  running,
  status,
}: {
  view: "searches" | "alerts" | "status";
  setView: (v: "searches" | "alerts" | "status") => void;
  navItems: NavItem[];
  running: boolean;
  status: StatusInfo | null;
}) {
  const { setOpenMobile, isMobile } = useSidebar();
  const pick = (k: NavItem["key"]) => {
    setView(k);
    if (isMobile) setOpenMobile(false);
  };
  return (
    <Sidebar>
      <SidebarHeader>
        <div className="flex items-center gap-2.5 px-1 py-1.5">
          <div
            className="flex size-7 items-center justify-center rounded-lg bg-primary text-[15px] font-semibold text-white"
            style={{ fontFamily: MONO }}
          >
            e
          </div>
          <div className="flex flex-col leading-none">
            <span className="text-[17px] font-bold tracking-tight">ebae</span>
            <span className="mt-1 text-[11px] text-muted-foreground">eBay, before anyone else</span>
          </div>
        </div>
      </SidebarHeader>
      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupLabel className="font-mono tracking-[0.14em] uppercase">Monitor</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              {navItems.map((n) => (
                <SidebarMenuItem key={n.key}>
                  <SidebarMenuButton isActive={view === n.key} onClick={() => pick(n.key)}>
                    <span>{n.label}</span>
                  </SidebarMenuButton>
                  {n.badge != null && <SidebarMenuBadge>{n.badge}</SidebarMenuBadge>}
                </SidebarMenuItem>
              ))}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>
      <SidebarFooter className="gap-3">
        <ThemeToggle />
        <div className="flex items-center gap-2 px-1 font-mono text-[10.5px] text-muted-foreground">
          <span
            className="size-1.5 shrink-0 rounded-full"
            style={{
              background: running ? "var(--eb-green)" : "var(--eb-amber)",
              animation: running ? "ebPulse 2.4s ease-in-out infinite" : undefined,
            }}
          />
          {running && status?.poller.bootedAt
            ? `poller up ${duration(status.poller.bootedAt)} · v${status.version}`
            : `poller down${status ? ` · v${status.version}` : ""}`}
        </div>
      </SidebarFooter>
    </Sidebar>
  );
}
