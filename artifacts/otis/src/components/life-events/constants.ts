import {
  PawPrint,
  Plane,
  Home,
  GraduationCap,
  PartyPopper,
  Car,
  HeartPulse,
  Sparkles,
  type LucideIcon,
} from "lucide-react";

export interface LifeEventCategory {
  value: string;
  label: string;
  icon: LucideIcon;
}

export const LIFE_EVENT_CATEGORIES: LifeEventCategory[] = [
  { value: "pets", label: "Pets", icon: PawPrint },
  { value: "vacations", label: "Vacations", icon: Plane },
  { value: "home_improvements", label: "Home Improvements", icon: Home },
  { value: "education", label: "Education", icon: GraduationCap },
  { value: "celebrations", label: "Celebrations", icon: PartyPopper },
  { value: "vehicle", label: "Vehicle", icon: Car },
  { value: "medical", label: "Medical", icon: HeartPulse },
  { value: "custom", label: "Custom", icon: Sparkles },
];

export const CATEGORY_MAP: Record<string, LifeEventCategory> = Object.fromEntries(
  LIFE_EVENT_CATEGORIES.map((c) => [c.value, c]),
);

export function categoryLabel(value: string, customCategory?: string | null): string {
  if (value === "custom") return customCategory?.trim() || "Custom";
  return CATEGORY_MAP[value]?.label ?? value;
}

export function categoryIcon(value: string): LucideIcon {
  return CATEGORY_MAP[value]?.icon ?? Sparkles;
}

export const TIMING_TYPES = [
  { value: "one_time" as const, label: "One-time", hint: "A single date" },
  { value: "spread" as const, label: "Spread", hint: "Split over months" },
  { value: "recurring" as const, label: "Recurring", hint: "Repeats over time" },
];

export const TIMING_LABELS: Record<string, string> = {
  one_time: "One-time",
  spread: "Spread",
  recurring: "Recurring",
};

export const RECUR_FREQUENCIES = [
  { value: "monthly", label: "Monthly" },
  { value: "quarterly", label: "Quarterly" },
  { value: "annually", label: "Annually" },
];

export const FREQUENCY_LABELS: Record<string, string> = {
  monthly: "Monthly",
  quarterly: "Quarterly",
  annually: "Annually",
};

export interface PriorityMeta {
  value: string;
  label: string;
  badgeClass: string;
  dot: string;
}

export const PRIORITIES: PriorityMeta[] = [
  { value: "must_do", label: "Must Do", badgeClass: "bg-red-100 text-red-700", dot: "#ef4444" },
  { value: "planning_to", label: "Planning To", badgeClass: "bg-amber-100 text-amber-800", dot: "#f59e0b" },
  { value: "just_dreaming", label: "Just Dreaming", badgeClass: "bg-teal-100 text-teal-700", dot: "#14b8a6" },
];

export const PRIORITY_MAP: Record<string, PriorityMeta> = Object.fromEntries(
  PRIORITIES.map((p) => [p.value, p]),
);
