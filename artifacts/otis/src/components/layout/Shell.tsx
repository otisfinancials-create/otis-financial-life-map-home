import { ReactNode, useState } from "react";
import { Menu, Search, Bell, Settings, PanelLeft } from "lucide-react";
import { useUser } from "@clerk/react";
import { Sidebar, SidebarContent } from "./Sidebar";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";

interface ShellProps {
  children: ReactNode;
}

function greetingForNow(): string {
  const h = new Date().getHours();
  if (h < 12) return "Good morning";
  if (h < 18) return "Good afternoon";
  return "Good evening";
}

function Topbar({ onToggleSidebar }: { onToggleSidebar: () => void }) {
  const { user } = useUser();
  const firstName = user?.firstName || user?.fullName?.split(" ")[0] || "";
  const today = new Date().toLocaleDateString(undefined, {
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
  });

  const iconBtn =
    "flex h-[30px] w-[30px] items-center justify-center rounded-lg border border-[var(--color-card-border)] bg-[var(--color-surface)] text-[var(--color-text-secondary)] hover:bg-[var(--color-card-border)] transition-colors";

  return (
    <div
      className="hidden md:flex items-center justify-between"
      style={{ padding: "6px 0 4px", marginBottom: 10 }}
    >
      <div>
        <h1 className="text-[16px] font-semibold text-[var(--color-text-primary)]">
          {greetingForNow()}
          {firstName ? `, ${firstName}` : ""}
        </h1>
        <p className="text-[12px] text-[var(--color-text-secondary)]" style={{ marginTop: 1 }}>
          {today}
        </p>
      </div>
      <div className="flex items-center gap-2">
        <span
          className="font-medium"
          style={{
            background: "#e8f4fd",
            border: "1px solid #b8d9f0",
            borderRadius: 20,
            padding: "4px 12px",
            fontSize: 11,
            color: "#1a5f8a",
          }}
        >
          Pro plan
        </span>
        <button type="button" title="Search" className={iconBtn}>
          <Search className="h-[15px] w-[15px]" aria-hidden="true" />
        </button>
        <button type="button" title="Alerts" className={iconBtn}>
          <Bell className="h-[15px] w-[15px]" aria-hidden="true" />
        </button>
        <button type="button" title="Settings" className={iconBtn}>
          <Settings className="h-[15px] w-[15px]" aria-hidden="true" />
        </button>
        <button type="button" title="Toggle sidebar" onClick={onToggleSidebar} className={iconBtn}>
          <PanelLeft className="h-[15px] w-[15px]" aria-hidden="true" />
        </button>
      </div>
    </div>
  );
}

export function Shell({ children }: ShellProps) {
  const [mobileOpen, setMobileOpen] = useState(false);
  const [collapsed, setCollapsed] = useState(false);

  return (
    <div className="flex h-screen overflow-hidden bg-[var(--color-page-bg)] text-[var(--color-text-primary)]">
      <Sidebar collapsed={collapsed} />
      <Sheet open={mobileOpen} onOpenChange={setMobileOpen}>
        <SheetContent side="left" className="w-[var(--sidebar-width)] p-0 md:hidden border-0">
          <SheetTitle className="sr-only">Navigation</SheetTitle>
          <SidebarContent onNavigate={() => setMobileOpen(false)} />
        </SheetContent>
      </Sheet>
      <div
        className={`flex flex-1 flex-col overflow-hidden transition-[margin] duration-200 ${
          collapsed ? "md:ml-0" : "md:ml-[calc(var(--sidebar-width)+10px)]"
        }`}
      >
        {/* Mobile hamburger — opens the nav sheet */}
        <Button
          variant="ghost"
          size="icon"
          className="md:hidden fixed top-3 right-3 z-20 rounded-full bg-[var(--color-card-bg)]/80 shadow-sm backdrop-blur text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)]"
          onClick={() => setMobileOpen(true)}
        >
          <span className="sr-only">Open navigation menu</span>
          <Menu className="h-5 w-5" aria-hidden="true" />
        </Button>
        <main className="flex-1 overflow-y-auto overflow-x-hidden bg-[var(--color-page-bg)] focus:outline-none">
          <div className="mx-auto max-w-7xl px-4 py-6 sm:px-6 md:pt-[10px]">
            <Topbar onToggleSidebar={() => setCollapsed((c) => !c)} />
            {children}
          </div>
        </main>
      </div>
    </div>
  );
}
