// Shared bill-category colors, light-mode-friendly, used by the bills
// analytics panel and the dashboard upcoming-bills list.
export const CATEGORY_COLORS: Record<string, string> = {
  "Housing":       "#3b82f6",
  "Insurance":     "#f97316",
  "Subscriptions": "#8b5cf6",
  "Utilities":     "#06b6d4",
  "Auto":          "#eab308",
  "Food":          "#ec4899",
  "Medical":       "#10b981",
  "Debt Payments": "#ef4444",
  "Other":         "#94a3b8",
};

export const FALLBACK_COLORS = ["#14b8a6", "#a855f7", "#f43f5e", "#84cc16", "#64748b"];

// Stable color for any category name (known map first, hashed fallback otherwise).
export function categoryColor(name: string): string {
  const known = CATEGORY_COLORS[name];
  if (known) return known;
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = (hash * 31 + name.charCodeAt(i)) | 0;
  return FALLBACK_COLORS[Math.abs(hash) % FALLBACK_COLORS.length];
}
