import { Link, useLocation } from "wouter";
import {
  LayoutDashboard,
  Receipt,
  Landmark,
  LineChart,
  CalendarHeart,
  PiggyBank,
  Scale,
  CreditCard,
  Banknote,
  Wallet,
  Target,
  LogOut,
  type LucideIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useClerk, useUser } from "@clerk/react";

interface NavItem {
  name: string;
  href: string;
  icon: LucideIcon;
}

const sections: { label: string; items: NavItem[] }[] = [
  {
    label: "Planning",
    items: [
      { name: "Dashboard", href: "/", icon: LayoutDashboard },
      { name: "Bills", href: "/bills", icon: Receipt },
      { name: "Pay", href: "/pay-schedules", icon: Banknote },
      { name: "Budget", href: "/budget", icon: Wallet },
      { name: "Forecast", href: "/forecast", icon: LineChart },
    ],
  },
  {
    label: "Accounts",
    items: [
      { name: "Connected accounts", href: "/accounts", icon: Landmark },
      { name: "Assets & Investments", href: "/assets-investments", icon: Scale },
      { name: "Loans", href: "/loans", icon: CreditCard },
    ],
  },
  {
    label: "Life",
    items: [
      { name: "Life events", href: "/life-events", icon: CalendarHeart },
      { name: "Goals", href: "/goals", icon: Target },
      { name: "Retirement", href: "/retirement", icon: PiggyBank },
    ],
  },
];

const basePath = import.meta.env.BASE_URL.replace(/\/$/, "");

function SidebarItem({
  item,
  active,
  onNavigate,
}: {
  item: NavItem;
  active: boolean;
  onNavigate?: () => void;
}) {
  return (
    <Link
      href={item.href}
      onClick={onNavigate}
      className={cn(
        "flex items-center gap-[9px] rounded-[7px] transition-colors",
        active ? "bg-[var(--color-active-bg)]" : "hover:bg-white/[0.06]"
      )}
      style={{ padding: "7px 10px", marginBottom: 1 }}
    >
      <item.icon
        className={cn("h-4 w-4 shrink-0", active ? "text-white" : "text-white/45")}
        aria-hidden="true"
      />
      <span
        className={cn(
          "text-[12.5px]",
          active ? "text-white font-medium" : "text-[rgba(255,255,255,0.6)] font-normal"
        )}
      >
        {item.name}
      </span>
    </Link>
  );
}

function SectionLabel({ children, first = false }: { children: string; first?: boolean }) {
  return (
    <div
      className="font-semibold uppercase text-[9px] tracking-[0.8px] text-[rgba(255,255,255,0.25)]"
      style={{ padding: first ? "12px 8px 5px" : "14px 8px 5px" }}
    >
      {children}
    </div>
  );
}

interface SidebarContentProps {
  onNavigate?: () => void;
}

export function SidebarContent({ onNavigate }: SidebarContentProps) {
  const [location] = useLocation();
  const { signOut } = useClerk();
  const { user } = useUser();

  const displayName = user?.fullName || user?.primaryEmailAddress?.emailAddress || "Account";
  const initials = user?.fullName
    ? user.fullName.split(" ").map((n) => n[0]).join("").slice(0, 2).toUpperCase()
    : (user?.primaryEmailAddress?.emailAddress?.[0] ?? "?").toUpperCase();

  return (
    <div className="flex h-full w-full flex-col bg-[var(--color-sidebar-bg)]">
      {/* Logo area — off-white section at the top with a Georgia serif wordmark */}
      <div
        className="shrink-0"
        style={{ background: "var(--color-logo-bg)", padding: "12px 14px 10px" }}
      >
        <span
          className="sidebar-logo-text"
          style={{
            fontFamily: "Georgia, 'Times New Roman', serif",
            fontSize: 28,
            fontWeight: "bold",
            color: "#0D2B45",
            letterSpacing: "-0.5px",
            display: "block",
          }}
        >
          Otis
        </span>
        <div
          className="sidebar-tagline"
          style={{
            fontSize: 7,
            color: "#94a3b8",
            letterSpacing: "0.7px",
            textTransform: "uppercase",
            whiteSpace: "nowrap",
            marginTop: 2,
          }}
        >
          Organize · Track · Inform · Simulate
        </div>
      </div>

      {/* Nav */}
      <nav className="flex-1 overflow-y-auto" style={{ padding: "10px 8px" }}>
        {sections.map((section, sectionIndex) => (
          <div key={section.label}>
            <SectionLabel first={sectionIndex === 0}>{section.label}</SectionLabel>
            {section.items.map((item) => (
              <SidebarItem
                key={item.href}
                item={item}
                active={location === item.href}
                onNavigate={onNavigate}
              />
            ))}
          </div>
        ))}

        <SectionLabel>Intelligence</SectionLabel>
        <Link
          href="/otis"
          onClick={onNavigate}
          className={cn(
            "flex items-center gap-[9px] rounded-[7px] transition-colors",
            location === "/otis" ? "bg-[var(--color-active-bg)]" : "hover:bg-white/[0.06]"
          )}
          style={{ padding: "7px 10px", marginBottom: 1 }}
        >
          <img
            src={`${import.meta.env.BASE_URL}images/otis-avatar.png`}
            alt=""
            className="h-6 w-6 shrink-0 rounded-full object-cover"
            aria-hidden="true"
          />
          <span
            className={cn(
              "text-[12.5px]",
              location === "/otis"
                ? "text-white font-medium"
                : "text-[rgba(255,255,255,0.6)] font-normal"
            )}
          >
            Otis AI
          </span>
        </Link>
      </nav>

      {/* Bottom area — Help & Support, divider, user profile. NO icon row. */}
      <div className="shrink-0 border-t border-white/[0.07]" style={{ padding: "10px 8px 12px" }}>
        <div
          className="flex items-center gap-2 rounded-[7px] text-[11.5px] text-white/45 cursor-pointer hover:bg-white/[0.06] transition-colors"
          style={{ padding: "6px 10px", marginBottom: 8 }}
          role="button"
          tabIndex={0}
        >
          <span aria-hidden>❓</span>
          <span>Help &amp; Support</span>
        </div>
        <div style={{ height: 1, background: "rgba(255,255,255,0.08)", margin: "0 8px 10px" }} />
        <div className="flex items-center justify-between gap-2" style={{ padding: "6px 10px" }}>
          <div className="flex min-w-0 items-center gap-[9px]">
            <div
              className="flex shrink-0 items-center justify-center rounded-full text-[11px] font-semibold text-white"
              style={{ width: 28, height: 28, background: "var(--color-carolina)" }}
            >
              {initials}
            </div>
            <div className="flex min-w-0 flex-col">
              <span className="truncate text-[11.5px] font-medium text-white/80">{displayName}</span>
              <span className="text-[10px] text-white/35">Personal plan</span>
            </div>
          </div>
          <button
            type="button"
            onClick={() => signOut({ redirectUrl: basePath || "/" })}
            className="shrink-0 rounded-md p-1.5 text-white/60 transition-colors hover:bg-white/10 hover:text-white"
            title="Sign out"
          >
            <LogOut className="h-4 w-4" />
          </button>
        </div>
      </div>
    </div>
  );
}

export function Sidebar({ collapsed }: { collapsed: boolean }) {
  return (
    <div
      className="hidden md:flex overflow-hidden rounded-[14px] transition-[width,margin] duration-200"
      style={
        collapsed
          ? {
              width: 0,
              margin: "10px 0",
              height: "calc(100vh - 20px)",
              position: "fixed",
              top: 0,
              left: 0,
            }
          : {
              width: "var(--sidebar-width)",
              margin: "10px 0 10px 10px",
              height: "calc(100vh - 20px)",
              position: "fixed",
              top: 0,
              left: 0,
            }
      }
    >
      <SidebarContent />
    </div>
  );
}
