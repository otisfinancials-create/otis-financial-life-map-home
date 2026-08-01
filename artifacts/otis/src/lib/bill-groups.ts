/**
 * SHARED categorization concept for goal-contribution bills (Bugs 1+2 root
 * cause fix). Grouping is KIND-BASED and sits ABOVE `category`:
 * `billKind === 'goal_contribution'` decides membership in the "Goal Savings"
 * group; the free-text, user-facing `category` field is never consulted for
 * these bills. Rationale: `category` is user-editable prose that can drift or
 * be renamed; `billKind` is a structural fact set by the goal commit path.
 *
 * Consumers: Budget (use-budget-math.ts), Bills page (pages/bills.tsx), and
 * Planned vs Actual (components/bills/planned-vs-actual.tsx). All three must
 * use these helpers so the pages always show the same shape.
 */

/** The minimal bill shape shared by web Bill types. */
interface BillLike {
  billKind?: string | null;
}

export function isGoalContribution(bill: BillLike): boolean {
  return bill.billKind === "goal_contribution";
}

/** Heading used everywhere goal contributions are grouped. Savings, not spend. */
export const GOAL_SAVINGS_LABEL = "Goal Savings";
