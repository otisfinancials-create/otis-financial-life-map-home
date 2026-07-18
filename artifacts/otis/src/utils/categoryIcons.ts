// ─── Shared category icon + color system ────────────────────────────────────
// Single source of truth for category icons, accent colors, and badge colors
// across the entire app: Forecast ledger, Bills (table + donut), Dashboard
// (upcoming bills + account types), and Life Events.
//
// If a color or icon ever needs to change, change it HERE only.
//
// Icons are Lucide components. Render category icons with strokeWidth={1.5}
// (thinner reads better at 16px) — use the ICON_STROKE constant.

import {
  Briefcase,
  Car,
  CreditCard,
  GraduationCap,
  Hammer,
  HeartPulse,
  Home,
  Landmark,
  PartyPopper,
  PawPrint,
  Pencil,
  PiggyBank,
  Plane,
  Receipt,
  RefreshCw,
  Shield,
  Smartphone,
  Sparkles,
  TrendingUp,
  Tv,
  Umbrella,
  UtensilsCrossed,
  Zap,
  type LucideIcon,
} from "lucide-react";

export const ICON_STROKE = 1.5;

export type CategoryKey =
  | "income"
  | "housing"
  | "insurance"
  | "subscriptions"
  | "auto"
  | "cellPhone"
  | "utilities"
  | "food"
  | "vacation"
  | "medical"
  | "savings"
  | "taxes"
  | "debt"
  | "pets"
  | "education"
  | "celebrations"
  | "homeImprovements"
  | "cryptocurrency"
  | "balanceUpdate"
  | "custom"
  | "other";

export type CategoryMeta = {
  icon: LucideIcon;
  /** Accent color: icon tint, color bars, chart slices. */
  color: string;
  /** Badge light-fill background. */
  bg: string;
  /** Badge dark text from the same color family. */
  text: string;
  /** Canonical display label. */
  label: string;
};

export const CATEGORY_META: Record<CategoryKey, CategoryMeta> = {
  income:           { icon: Briefcase,       color: "#2D9B6F", bg: "#E1F5EE", text: "#085041", label: "Salary" },
  housing:          { icon: Home,            color: "#185FA5", bg: "#E6F1FB", text: "#0C447C", label: "Housing" },
  insurance:        { icon: Shield,          color: "#D85A30", bg: "#FAECE7", text: "#712B13", label: "Insurance" },
  subscriptions:    { icon: Tv,              color: "#534AB7", bg: "#EEEDFE", text: "#3C3489", label: "Subscriptions" },
  auto:             { icon: Car,             color: "#BA7517", bg: "#FAEEDA", text: "#633806", label: "Auto" },
  cellPhone:        { icon: Smartphone,      color: "#8B5CF6", bg: "#F1EBFD", text: "#5B21B6", label: "Cell Phone" },
  utilities:        { icon: Zap,             color: "#0F6E56", bg: "#E1F5EE", text: "#085041", label: "Utilities" },
  food:             { icon: UtensilsCrossed,  color: "#D85A30", bg: "#FAECE7", text: "#712B13", label: "Food" },
  vacation:         { icon: Plane,           color: "#1D9E75", bg: "#E1F5EE", text: "#085041", label: "Vacations" },
  medical:          { icon: HeartPulse,      color: "#993556", bg: "#FBEAF0", text: "#72243E", label: "Medical" },
  savings:          { icon: PiggyBank,       color: "#E24B4A", bg: "#FCEBEB", text: "#791F1F", label: "Savings" },
  taxes:            { icon: Landmark,        color: "#E24B4A", bg: "#FCEBEB", text: "#791F1F", label: "Taxes" },
  debt:             { icon: Receipt,         color: "#E24B4A", bg: "#FCEBEB", text: "#791F1F", label: "Debt Payments" },
  pets:             { icon: PawPrint,        color: "#1D9E75", bg: "#E1F5EE", text: "#085041", label: "Pets" },
  education:        { icon: GraduationCap,   color: "#534AB7", bg: "#EEEDFE", text: "#3C3489", label: "Education" },
  celebrations:     { icon: PartyPopper,     color: "#D4537E", bg: "#FBEAF0", text: "#72243E", label: "Celebrations" },
  homeImprovements: { icon: Hammer,          color: "#BA7517", bg: "#FAEEDA", text: "#633806", label: "Home Improvements" },
  cryptocurrency:   { icon: TrendingUp,      color: "#F59E0B", bg: "#FEF3C7", text: "#92400E", label: "Cryptocurrency" },
  balanceUpdate:    { icon: RefreshCw,       color: "#185FA5", bg: "#E6F1FB", text: "#0C447C", label: "Balance Update" },
  custom:           { icon: Sparkles,        color: "#888780", bg: "#F1EFE8", text: "#444441", label: "Custom" },
  other:            { icon: Pencil,          color: "#888780", bg: "#F1EFE8", text: "#444441", label: "Other" },
};

// ── Raw-name → canonical key resolution ─────────────────────────────────────
// Category strings arrive in many shapes ("Housing", "salary", "Auto", "Gas",
// "home_improvements", "Balance Update", …). Resolve them all here.
const NAME_TO_KEY: Record<string, CategoryKey> = {
  income: "income", salary: "income", paycheck: "income",
  housing: "housing", mortgage: "housing", rent: "housing",
  insurance: "insurance",
  subscriptions: "subscriptions", subscription: "subscriptions",
  auto: "auto", gas: "auto", car: "auto", transportation: "auto", vehicle: "auto",
  "cell phone": "cellPhone", cellphone: "cellPhone", cell_phone: "cellPhone", phone: "cellPhone", mobile: "cellPhone",
  utilities: "utilities", electric: "utilities", water: "utilities",
  food: "food", groceries: "food",
  vacation: "vacation", vacations: "vacation", travel: "vacation",
  medical: "medical", health: "medical",
  savings: "savings",
  taxes: "taxes", tax: "taxes",
  "debt payments": "debt", debt: "debt", loan: "debt",
  pets: "pets",
  education: "education",
  celebrations: "celebrations",
  "home improvements": "homeImprovements", home_improvements: "homeImprovements",
  cryptocurrency: "cryptocurrency", crypto: "cryptocurrency", bitcoin: "cryptocurrency",
  adjustment: "balanceUpdate", "balance update": "balanceUpdate",
  custom: "custom",
  other: "other", manual: "other",
};

export function resolveCategoryKey(raw: string): CategoryKey {
  return NAME_TO_KEY[raw.trim().toLowerCase()] ?? "other";
}

/** Full meta (icon, color, bg, text, label) for any raw category string. */
export function categoryMeta(raw: string): CategoryMeta {
  return CATEGORY_META[resolveCategoryKey(raw)];
}

/**
 * Display label for a raw category string. Known categories get their
 * canonical label; unknown strings display as-is (custom category names).
 */
export function categoryDisplayLabel(raw: string): string {
  const key = NAME_TO_KEY[raw.trim().toLowerCase()];
  return key ? CATEGORY_META[key].label : raw;
}

// ── Account types (Dashboard "By Account Type" panel) ───────────────────────
export type AccountTypeMeta = { icon: LucideIcon; color: string; label: string };

export const ACCOUNT_TYPE_META: Record<string, AccountTypeMeta> = {
  checking:    { icon: Landmark,   color: "#185FA5", label: "Checking" },
  savings:     { icon: Landmark,   color: "#185FA5", label: "Savings" },
  credit_card: { icon: CreditCard, color: "#534AB7", label: "Credit Card" },
  investment:  { icon: TrendingUp, color: "#2D9B6F", label: "Investment" },
  retirement:  { icon: Umbrella,   color: "#0F6E56", label: "Retirement" },
  mortgage:    { icon: Home,       color: "#185FA5", label: "Mortgage" },
  loan:        { icon: Receipt,    color: "#E24B4A", label: "Loans" },
  real_estate: { icon: Home,       color: "#185FA5", label: "Real Estate" },
};

export function accountTypeMeta(type: string): AccountTypeMeta | undefined {
  return ACCOUNT_TYPE_META[type];
}

// ── Emoji category icons ─────────────────────────────────────────────────────
// The category icon CELL in ledger/table rows renders a plain emoji character
// (no icon library). Lucide icons above remain for charts/badges/nav accents.
// Insertion order matters: earlier keys win ("gas for" before the generic
// "gas" fuel entry). Matching is substring-based over category + description.
export const CATEGORY_EMOJI: Record<string, string> = {
  salary: "💼",
  income: "💼",
  paycheck: "💼",
  mortgage: "🏠",
  housing: "🏠",
  rent: "🏠",
  insurance: "🛡️",
  subscription: "📺",
  netflix: "📺",
  spotify: "📺",
  streaming: "📺",
  utilities: "⚡",
  electric: "⚡",
  water: "💧",
  "cell phone": "📱",
  cellphone: "📱",
  phone: "📱",
  "gas for": "🚗",
  auto: "🚗",
  car: "🚗",
  vehicle: "🚗",
  transport: "🚗",
  food: "🍽️",
  grocer: "🛒",
  restaurant: "🍽️",
  dining: "🍽️",
  vacation: "✈️",
  travel: "✈️",
  medical: "❤️",
  health: "❤️",
  doctor: "❤️",
  cryptocurrency: "🪙",
  crypto: "🪙",
  bitcoin: "🪙",
  savings: "🏦",
  transfer: "🏦",
  pets: "🐾",
  education: "🎓",
  celebration: "🎉",
  "home improvement": "🔨",
  renovation: "🔨",
  "balance update": "🔄",
  garbage: "🗑️",
  trash: "🗑️",
  waste: "🗑️",
  other: "📋",
  manual: "✏️",
  gas: "⛽",
};

export function getCategoryEmoji(category: string, description: string = ""): string {
  const searchText = (category + " " + description).toLowerCase();
  for (const [key, emoji] of Object.entries(CATEGORY_EMOJI)) {
    if (searchText.includes(key)) return emoji;
  }
  return "📋";
}

// ── Flat lookups (kept for spec compliance / simple consumers) ──────────────
export const CATEGORY_ICONS = Object.fromEntries(
  (Object.keys(CATEGORY_META) as CategoryKey[]).map((k) => [
    k,
    { icon: CATEGORY_META[k].icon, color: CATEGORY_META[k].color },
  ]),
) as Record<CategoryKey, { icon: LucideIcon; color: string }>;

export const CATEGORY_BADGE_COLORS = Object.fromEntries(
  (Object.keys(CATEGORY_META) as CategoryKey[]).map((k) => [
    k,
    { bg: CATEGORY_META[k].bg, text: CATEGORY_META[k].text },
  ]),
) as Record<CategoryKey, { bg: string; text: string }>;

export const CATEGORY_BAR_COLORS = Object.fromEntries(
  (Object.keys(CATEGORY_META) as CategoryKey[]).map((k) => [k, CATEGORY_META[k].color]),
) as Record<CategoryKey, string>;
