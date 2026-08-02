import { eq } from "drizzle-orm";
import { db, accountsTable, assetsTable, loansTable } from "@workspace/db";

const num = (v: unknown) => parseFloat(String(v)) || 0;

export interface LiabilityItem {
  name: string;
  balance: number;
  source: "account" | "loan" | "manual";
}

export interface NetWorthContext {
  totalAssets: number;
  totalLiabilities: number;
  netWorth: number;
  liabilitiesBreakdown: {
    creditCards: LiabilityItem[];
    mortgages: LiabilityItem[];
    otherLoans: LiabilityItem[];
  };
}

/**
 * THE single liabilities/net-worth computation. Dashboard, assets summary,
 * breakdown modal (via dashboard payload), and the Otis AI context all
 * consume this — never re-derive the split anywhere else.
 *
 * Rules:
 *  - Liability Connected Accounts count at |balance|.
 *  - Manual liability rows in `assets` count at |balance|.
 *  - Loans count ONLY when NOT linked to an account (loans.account_id NULL).
 *    A linked loan's balance is owned by the account; the loan contributes
 *    only its amortization schedule. No name/payment heuristic — the explicit
 *    link is the only dedupe.
 */
export async function computeNetWorth(userId: string): Promise<NetWorthContext> {
  const [accounts, assets, loans] = await Promise.all([
    db.select().from(accountsTable).where(eq(accountsTable.userId, userId)),
    db.select().from(assetsTable).where(eq(assetsTable.userId, userId)),
    db.select().from(loansTable).where(eq(loansTable.userId, userId)),
  ]);

  const totalAssets =
    accounts.filter((a) => a.isAsset).reduce((s, a) => s + num(a.currentBalance), 0) +
    assets.filter((a) => a.isAsset).reduce((s, a) => s + num(a.currentBalance), 0);

  const creditCards: LiabilityItem[] = [];
  const mortgages: LiabilityItem[] = [];
  const otherLoans: LiabilityItem[] = [];

  for (const a of accounts.filter((x) => !x.isAsset)) {
    const item: LiabilityItem = { name: a.accountName, balance: Math.abs(num(a.currentBalance)), source: "account" };
    if (a.accountType === "credit_card") creditCards.push(item);
    else if (a.accountType === "mortgage") mortgages.push(item);
    else otherLoans.push(item);
  }
  for (const m of assets.filter((x) => !x.isAsset)) {
    otherLoans.push({ name: m.assetName, balance: Math.abs(num(m.currentBalance)), source: "manual" });
  }
  for (const l of loans) {
    if (l.accountId != null) continue; // account owns the balance
    const item: LiabilityItem = { name: l.loanName, balance: Math.abs(num(l.currentBalance)), source: "loan" };
    if (l.loanType === "mortgage") mortgages.push(item);
    else otherLoans.push(item);
  }

  const totalLiabilities =
    [...creditCards, ...mortgages, ...otherLoans].reduce((s, i) => s + i.balance, 0);

  return {
    totalAssets,
    totalLiabilities,
    netWorth: totalAssets - totalLiabilities,
    liabilitiesBreakdown: { creditCards, mortgages, otherLoans },
  };
}
