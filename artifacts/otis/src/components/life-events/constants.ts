import { type LucideIcon } from "lucide-react";

import { categoryMeta, type CategoryMeta } from "@/utils/categoryIcons";

export interface LifeEventCategory {
  value: string;
  label: string;
  icon: LucideIcon;
  /** Accent color for the icon (shared category color system). */
  color: string;
  /** Light-fill badge background. */
  bg: string;
  /** Dark badge text from the same color family. */
  text: string;
}

// Icons + colors come from the shared category system (src/utils/categoryIcons.ts).
function fromShared(value: string, label: string): LifeEventCategory {
  const meta: CategoryMeta = categoryMeta(value);
  return { value, label, icon: meta.icon, color: meta.color, bg: meta.bg, text: meta.text };
}

export const LIFE_EVENT_CATEGORIES: LifeEventCategory[] = [
  fromShared("pets", "Pets"),
  fromShared("vacations", "Vacations"),
  fromShared("home_improvements", "Home Improvements"),
  fromShared("education", "Education"),
  fromShared("celebrations", "Celebrations"),
  fromShared("vehicle", "Vehicle"),
  fromShared("medical", "Medical"),
  fromShared("custom", "Custom"),
];

export const CATEGORY_MAP: Record<string, LifeEventCategory> = Object.fromEntries(
  LIFE_EVENT_CATEGORIES.map((c) => [c.value, c]),
);

export function categoryLabel(value: string, customCategory?: string | null): string {
  if (value === "custom") return customCategory?.trim() || "Custom";
  return CATEGORY_MAP[value]?.label ?? value;
}

export function lifeEventCategoryMeta(value: string): LifeEventCategory {
  return CATEGORY_MAP[value] ?? CATEGORY_MAP.custom!;
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
