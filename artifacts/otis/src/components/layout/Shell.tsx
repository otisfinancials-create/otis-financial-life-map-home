import { ReactNode, useState } from "react";
import { Sidebar, SidebarContent } from "./Sidebar";
import { Topbar } from "./Topbar";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";

interface ShellProps {
  children: ReactNode;
}

export function Shell({ children }: ShellProps) {
  const [mobileOpen, setMobileOpen] = useState(false);

  return (
    <div className="flex h-screen overflow-hidden bg-[var(--color-page-bg)] text-[var(--color-text-primary)]">
      <Sidebar />
      <Sheet open={mobileOpen} onOpenChange={setMobileOpen}>
        <SheetContent side="left" className="w-[var(--sidebar-width)] p-0 md:hidden border-0">
          <SheetTitle className="sr-only">Navigation</SheetTitle>
          <SidebarContent onNavigate={() => setMobileOpen(false)} />
        </SheetContent>
      </Sheet>
      <div className="flex flex-1 flex-col overflow-hidden">
        <Topbar onMenuClick={() => setMobileOpen(true)} />
        <main className="flex-1 overflow-y-auto overflow-x-hidden bg-[var(--color-page-bg)] focus:outline-none">
          <div className="mx-auto max-w-7xl px-4 py-5 sm:px-6">
            {children}
          </div>
        </main>
      </div>
    </div>
  );
}
