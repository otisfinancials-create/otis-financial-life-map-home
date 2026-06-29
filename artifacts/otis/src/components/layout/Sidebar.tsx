import { Link, useLocation } from "wouter";
import { 
  LayoutDashboard, 
  Receipt, 
  Landmark, 
  LineChart, 
  CalendarHeart, 
  FlaskConical,
  PiggyBank,
  Scale,
  CreditCard,
  Bot,
  Banknote,
  LogOut
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useClerk, useUser } from "@clerk/react";

const navigation = [
  { name: "Dashboard", href: "/", icon: LayoutDashboard },
  { name: "Accounts", href: "/accounts", icon: Landmark },
  { name: "My Assets", href: "/assets-liabilities", icon: Scale },
  { name: "Bills", href: "/bills", icon: Receipt },
  { name: "Pay Schedules", href: "/pay-schedules", icon: Banknote },
  { name: "Forecast", href: "/forecast", icon: LineChart },
  { name: "Loans", href: "/loans", icon: CreditCard },
  { name: "Life Events", href: "/life-events", icon: CalendarHeart },
  { name: "Retirement", href: "/retirement", icon: PiggyBank },
  { name: "Simulator", href: "/simulator", icon: FlaskConical },
];

const basePath = import.meta.env.BASE_URL.replace(/\/$/, "");

export function Sidebar() {
  const [location] = useLocation();
  const { signOut } = useClerk();
  const { user } = useUser();

  const displayName = user?.fullName || user?.primaryEmailAddress?.emailAddress || "Account";
  const initials = user?.fullName
    ? user.fullName.split(" ").map((n) => n[0]).join("").slice(0, 2).toUpperCase()
    : (user?.primaryEmailAddress?.emailAddress?.[0] ?? "?").toUpperCase();

  return (
    <div className="flex h-full w-64 flex-col border-r border-border bg-sidebar text-sidebar-foreground">
      <div className="flex h-16 items-center px-6 border-b border-border">
        <div className="flex items-center gap-2 font-semibold tracking-tight text-lg">
          <div className="h-6 w-6 rounded-sm bg-primary flex items-center justify-center">
            <span className="text-primary-foreground text-xs font-bold font-mono">O</span>
          </div>
          Otis
        </div>
      </div>
      <div className="flex-1 overflow-y-auto py-4">
        <nav className="space-y-1 px-3">
          <div className="mb-2 px-3 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            Overview
          </div>
          {navigation.map((item) => {
            const isActive = location === item.href;
            return (
              <Link 
                key={item.name} 
                href={item.href}
                className={cn(
                  "group flex items-center rounded-md px-3 py-2 text-sm font-medium transition-colors",
                  isActive
                    ? "bg-sidebar-accent text-sidebar-accent-foreground"
                    : "text-muted-foreground hover:bg-sidebar-accent/50 hover:text-sidebar-foreground"
                )}
              >
                <item.icon
                  className={cn(
                    "mr-3 h-4 w-4 shrink-0",
                    isActive ? "text-primary" : "text-muted-foreground group-hover:text-sidebar-foreground"
                  )}
                  aria-hidden="true"
                />
                {item.name}
              </Link>
            );
          })}

          <div className="mt-8 mb-2 px-3 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            Intelligence
          </div>
          <Link 
            href="/ai"
            className={cn(
              "group flex items-center rounded-md px-3 py-2 text-sm font-medium transition-colors",
              location === "/ai"
                ? "bg-sidebar-accent text-sidebar-accent-foreground"
                : "text-muted-foreground hover:bg-sidebar-accent/50 hover:text-sidebar-foreground"
            )}
          >
            <Bot
              className={cn(
                "mr-3 h-4 w-4 shrink-0",
                location === "/ai" ? "text-primary" : "text-muted-foreground group-hover:text-sidebar-foreground"
              )}
              aria-hidden="true"
            />
            Otis AI
          </Link>
        </nav>
      </div>
      <div className="p-4 border-t border-border">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-3 min-w-0">
            <div className="h-8 w-8 shrink-0 rounded-full bg-secondary flex items-center justify-center text-xs font-medium border border-border">
              {initials}
            </div>
            <div className="flex flex-col min-w-0">
              <span className="text-sm font-medium leading-none truncate">{displayName}</span>
              <span className="text-xs text-muted-foreground mt-1">Personal</span>
            </div>
          </div>
          <button
            type="button"
            onClick={() => signOut({ redirectUrl: basePath || "/" })}
            className="shrink-0 rounded-md p-1.5 text-muted-foreground hover:text-foreground hover:bg-sidebar-accent/50 transition-colors"
            title="Sign out"
          >
            <LogOut className="h-4 w-4" />
          </button>
        </div>
      </div>
    </div>
  );
}
