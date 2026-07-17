import { Bell, Menu } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useUser } from "@clerk/react";

interface TopbarProps {
  onMenuClick?: () => void;
}

export function Topbar({ onMenuClick }: TopbarProps) {
  const { user } = useUser();
  const firstName = user?.firstName || user?.fullName?.split(" ")[0];

  return (
    <header className="sticky top-0 z-10 flex shrink-0 items-center justify-between gap-x-4 border-b border-[var(--color-card-border)] bg-[var(--color-card-bg)] px-4 py-3.5 sm:px-6">
      <div className="flex items-center gap-x-3 min-w-0">
        <Button
          variant="ghost"
          size="icon"
          className="md:hidden -ml-2 text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)]"
          onClick={onMenuClick}
        >
          <span className="sr-only">Open navigation menu</span>
          <Menu className="h-5 w-5" aria-hidden="true" />
        </Button>
        <div className="min-w-0">
          <h1 className="truncate text-lg font-semibold text-[var(--color-text-primary)]">
            {firstName ? `Welcome back, ${firstName}` : "Welcome back"}
          </h1>
        </div>
      </div>
      <div className="flex items-center gap-x-2">
        <Button
          variant="ghost"
          size="icon"
          className="relative text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)]"
        >
          <span className="absolute top-1.5 right-1.5 h-2 w-2 rounded-full bg-[var(--color-carolina)]" />
          <span className="sr-only">View notifications</span>
          <Bell className="h-5 w-5" aria-hidden="true" />
        </Button>
      </div>
    </header>
  );
}
