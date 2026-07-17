import { ReactNode, useState } from "react";
import { Menu } from "lucide-react";
import { Sidebar, SidebarContent } from "./Sidebar";
import { Button } from "@/components/ui/button";
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
        {/* No topbar — page titles sit directly on the soft gray background.
            On mobile, a floating hamburger opens the nav sheet. */}
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
          <div className="mx-auto max-w-7xl px-4 py-6 sm:px-6">
            {children}
          </div>
        </main>
      </div>
    </div>
  );
}
