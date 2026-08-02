/**
 * Single source of truth for Otis bill categories, plus the Plaid
 * personal_finance_category → Otis category pre-fill mapping.
 *
 * Consumed by the web bill dialog, the mobile bill form, and the API server
 * (detected-bill confirmation pre-fill).
 */

export const BILL_CATEGORIES = [
  "Housing",
  "Utilities",
  "Subscriptions",
  "Insurance",
  "Food",
  "Transportation",
  "Auto",
  "Cell Phone",
  "Medical",
  "Health",
  "Childcare / Education",
  "Debt Payments",
  "Taxes",
  "Pets",
  "Giving / Charity",
  "Other",
] as const;

export type BillCategory = (typeof BILL_CATEGORIES)[number];

/**
 * Categories for upkeep bills (billKind = 'upkeep'): recurring expected
 * expenses like vet visits, HVAC service, and car maintenance. Deliberately
 * a separate list from BILL_CATEGORIES — upkeep groups by what is being
 * maintained, not by household budget line.
 */
export const UPKEEP_CATEGORIES = [
  "Pets & Vet",
  "Home Maintenance",
  "Auto Maintenance",
  "Kids & Activities",
  "Yard & Outdoor",
  "Pool & Spa",
  "Other Upkeep",
] as const;

export type UpkeepCategory = (typeof UPKEEP_CATEGORIES)[number];

/**
 * Plaid personal_finance_category PRIMARY → Otis bill category.
 * Anything unmapped (or absent) defaults to "Other".
 * TRANSFER_* / INCOME / BANK_FEES never become bills in practice, but map to
 * "Other" defensively rather than being special-cased here.
 */
const PLAID_PRIMARY_TO_CATEGORY: Record<string, BillCategory> = {
  FOOD_AND_DRINK: "Food",
  GENERAL_MERCHANDISE: "Other",
  TRANSPORTATION: "Transportation",
  TRAVEL: "Transportation",
  RENT_AND_UTILITIES: "Utilities",
  LOAN_PAYMENTS: "Debt Payments",
  MEDICAL: "Medical",
  PERSONAL_CARE: "Health",
  ENTERTAINMENT: "Subscriptions",
  GENERAL_SERVICES: "Other",
  HOME_IMPROVEMENT: "Housing",
  GOVERNMENT_AND_NON_PROFIT: "Giving / Charity",
};

/**
 * Detailed-category overrides that beat the primary mapping when they apply.
 * Matched by substring on personal_finance_category_detailed.
 */
const PLAID_DETAILED_OVERRIDES: Array<[substring: string, category: BillCategory]> = [
  ["TELEPHONE", "Cell Phone"],
  ["RENT_AND_UTILITIES_RENT", "Housing"],
  ["MORTGAGE", "Housing"],
  ["TAX_PAYMENT", "Taxes"],
  ["DONATIONS", "Giving / Charity"],
  ["INSURANCE", "Insurance"],
  ["EDUCATION", "Childcare / Education"],
  ["CHILDCARE", "Childcare / Education"],
  ["VETERINARY", "Pets"],
  ["PET", "Pets"],
];

/**
 * Suggest an Otis bill category from a Plaid personal_finance_category.
 * Pre-fill only — never binding; the user can always override.
 */
export function suggestCategoryFromPlaid(
  primary: string | null | undefined,
  detailed?: string | null,
): BillCategory {
  const det = (detailed ?? "").toUpperCase();
  if (det) {
    for (const [needle, category] of PLAID_DETAILED_OVERRIDES) {
      if (det.includes(needle)) return category;
    }
  }
  const prim = (primary ?? "").toUpperCase().trim();
  return PLAID_PRIMARY_TO_CATEGORY[prim] ?? "Other";
}
