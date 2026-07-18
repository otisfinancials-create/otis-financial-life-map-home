import { useState } from "react";
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

function OtisLogo() {
  return (
    <img
      src={`${basePath}/images/otis_logo.png`}
      alt="Otis Financial"
      className="sidebar-logo-img"
      style={{ width: 90, height: "auto", display: "block" }}
    />
  );
}

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
        "flex items-center gap-2.5 rounded-lg transition-colors",
        active ? "bg-[var(--color-active-bg)]" : "hover:bg-white/10"
      )}
      style={{ padding: "7px 10px", marginBottom: 1 }}
    >
      <item.icon
        className={cn("h-4 w-4 shrink-0", active ? "text-white" : "text-white/60")}
        aria-hidden="true"
      />
      <span
        className={cn(
          "text-[13px]",
          active ? "text-white font-medium" : "text-[rgba(255,255,255,0.85)] font-normal"
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
      className="font-semibold uppercase text-[9px] tracking-[0.8px] text-[rgba(255,255,255,0.35)]"
      style={{ padding: first ? "10px 8px 4px" : "14px 8px 4px" }}
    >
      {children}
    </div>
  );
}

interface SidebarContentProps {
  onNavigate?: () => void;
  onToggleCollapse?: () => void;
}

export function SidebarContent({ onNavigate, onToggleCollapse }: SidebarContentProps) {
  const [location] = useLocation();
  const { signOut } = useClerk();
  const { user } = useUser();

  const displayName = user?.fullName || user?.primaryEmailAddress?.emailAddress || "Account";
  const initials = user?.fullName
    ? user.fullName.split(" ").map((n) => n[0]).join("").slice(0, 2).toUpperCase()
    : (user?.primaryEmailAddress?.emailAddress?.[0] ?? "?").toUpperCase();

  return (
    <div className="flex h-full w-full flex-col bg-[var(--color-sidebar-bg)]">
      {/* Logo area — its own floating off-white rounded box (#R3-5) */}
      <div
        className="shrink-0 flex flex-col items-center"
        style={{ background: "#F8F6F1", borderRadius: 12, margin: "8px 8px 0 8px", padding: "10px 14px" }}
      >
        <OtisLogo />
        <div
          className="sidebar-tagline"
          style={{
            fontSize: 7,
            color: "#6b7280",
            letterSpacing: "0.6px",
            textTransform: "uppercase",
            whiteSpace: "nowrap",
            marginTop: 3,
            fontWeight: 500,
          }}
        >
          Organize · Track · Inform · Simulate
        </div>
      </div>

      {/* Nav — 8px gap below the logo box (#R3-5) */}
      <nav className="flex-1 overflow-y-auto" style={{ marginTop: 8, padding: "8px 10px" }}>
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
            "flex items-center gap-2.5 rounded-lg transition-colors",
            location === "/otis" ? "bg-[var(--color-active-bg)]" : "hover:bg-white/10"
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
              "text-[13px]",
              location === "/otis"
                ? "text-white font-medium"
                : "text-[rgba(255,255,255,0.85)] font-normal"
            )}
          >
            Otis AI
          </span>
        </Link>
      </nav>

      {/* Help & Support (placeholder) — sits just above the divider (#R3-9) */}
      <div className="shrink-0 px-2.5 pb-2" style={{ marginTop: 6 }}>
        <div
          className="flex items-center gap-2 rounded-lg text-[11px] text-white/70 cursor-pointer hover:bg-white/10 transition-colors"
          style={{ padding: "7px 10px" }}
          role="button"
          tabIndex={0}
        >
          <span aria-hidden>❓</span>
          <span>Help &amp; Support</span>
        </div>
      </div>

      {/* Bottom area */}
      <div className="shrink-0 border-t border-white/20 px-2.5 pt-3 pb-4">
        <div className="flex items-center justify-between gap-2 px-2 py-1">
          <div className="flex min-w-0 items-center gap-2.5">
            <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-[var(--color-navy)] text-xs font-semibold text-white">
              {initials}
            </div>
            <div className="flex min-w-0 flex-col">
              <span className="truncate text-xs font-medium text-white/90">{displayName}</span>
              <span className="text-[10px] text-white/50">Personal plan</span>
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

        {/* Placeholder icon row (#R3-9) — only the hide toggle does anything yet */}
        <div className="flex justify-around" style={{ padding: "8px 10px 4px", marginTop: 8 }}>
          {[
            { title: "Search", glyph: "🔍" },
            { title: "Alerts", glyph: "🔔" },
            { title: "Settings", glyph: "⚙️" },
          ].map((b) => (
            <button
              key={b.title}
              type="button"
              title={b.title}
              className="flex h-9 w-9 items-center justify-center rounded-lg bg-white/15 text-[14px] hover:bg-white/25 transition-colors"
            >
              <span aria-hidden>{b.glyph}</span>
            </button>
          ))}
          <button
            type="button"
            title="Hide sidebar"
            onClick={onToggleCollapse}
            className="flex h-9 w-9 items-center justify-center rounded-lg bg-white/15 text-[14px] text-white/80 hover:bg-white/25 transition-colors"
          >
            <span aria-hidden>◀</span>
          </button>
        </div>
      </div>
    </div>
  );
}

export function Sidebar() {
  const [collapsed, setCollapsed] = useState(false);

  return (
    <>
      <div
        className="hidden md:flex shrink-0 overflow-hidden rounded-2xl transition-[width,margin] duration-200"
        style={
          collapsed
            ? { width: 0, margin: "12px 0", height: "calc(100vh - 24px)" }
            : { width: "var(--sidebar-width)", margin: "12px 0 12px 12px", height: "calc(100vh - 24px)" }
        }
      >
        <SidebarContent onToggleCollapse={() => setCollapsed(true)} />
      </div>
      {collapsed && (
        <button
          type="button"
          title="Show sidebar"
          onClick={() => setCollapsed(false)}
          className="hidden md:flex fixed left-2 top-4 z-40 h-9 w-9 items-center justify-center rounded-lg bg-[var(--color-navy)] text-[14px] text-white shadow-md hover:opacity-90 transition-opacity"
        >
          <span aria-hidden>▶</span>
        </button>
      )}
    </>
  );
}
