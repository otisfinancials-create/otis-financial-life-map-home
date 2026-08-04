import { eq } from "drizzle-orm";
import { db, accountsTable, assetsTable, loansTable, plaidItemsTable } from "@workspace/db";

const num = (v: unknown) => parseFloat(String(v)) || 0;

export interface LiabilityItem {
  name: string;
  balance: number;
  source: "account" | "loan" | "manual";
}

/** Per-source provenance for a net-worth figure (Otis AI context lineage). */
export interface NetWorthSource {
  name: string;
  balance: number;
  /** ISO timestamp of the last bank sync (item-level preferred), null for manual data. */
  lastSyncedAt: string | null;
  origin: "live" | "manual";
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
  /** Every row that contributed to totalAssets, with provenance. */
  assetSources: NetWorthSource[];
  /** Every row that contributed to totalLiabilities, with provenance. */
  liabilitySources: NetWorthSource[];
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
  const [accounts, assets, loans, plaidItems] = await Promise.all([
    db.select().from(accountsTable).where(eq(accountsTable.userId, userId)),
    db.select().from(assetsTable).where(eq(assetsTable.userId, userId)),
    db.select().from(loansTable).where(eq(loansTable.userId, userId)),
    db.select().from(plaidItemsTable).where(eq(plaidItemsTable.userId, userId)),
  ]);

  // Item-level sync timestamp preferred over the per-account one (matches the
  // accounts list route's freshness semantics).
  const itemSyncById = new Map(plaidItems.map((i) => [i.id, i.lastSyncedAt]));
  const accountSource = (a: (typeof accounts)[number]): NetWorthSource => {
    const live = a.plaidAccountId != null;
    const synced = (a.plaidItemId != null ? itemSyncById.get(a.plaidItemId) : null) ?? a.lastSyncedAt;
    return {
      name: a.accountName,
      balance: a.isAsset ? num(a.currentBalance) : Math.abs(num(a.currentBalance)),
      lastSyncedAt: live && synced ? synced.toISOString() : null,
      origin: live ? "live" : "manual",
    };
  };

  const assetSources: NetWorthSource[] = [
    ...accounts.filter((a) => a.isAsset).map(accountSource),
    ...assets
      .filter((a) => a.isAsset)
      .map((a) => ({
        name: a.assetName,
        balance: num(a.currentBalance),
        lastSyncedAt: null,
        origin: "manual" as const,
      })),
  ];
  const totalAssets = assetSources.reduce((s, a) => s + a.balance, 0);

  const creditCards: LiabilityItem[] = [];
  const mortgages: LiabilityItem[] = [];
  const otherLoans: LiabilityItem[] = [];
  const liabilitySources: NetWorthSource[] = [];

  for (const a of accounts.filter((x) => !x.isAsset)) {
    const item: LiabilityItem = { name: a.accountName, balance: Math.abs(num(a.currentBalance)), source: "account" };
    if (a.accountType === "credit_card") creditCards.push(item);
    else if (a.accountType === "mortgage") mortgages.push(item);
    else otherLoans.push(item);
    liabilitySources.push(accountSource(a));
  }
  for (const m of assets.filter((x) => !x.isAsset)) {
    otherLoans.push({ name: m.assetName, balance: Math.abs(num(m.currentBalance)), source: "manual" });
    liabilitySources.push({
      name: m.assetName,
      balance: Math.abs(num(m.currentBalance)),
      lastSyncedAt: null,
      origin: "manual",
    });
  }
  for (const l of loans) {
    if (l.accountId != null) continue; // account owns the balance
    const item: LiabilityItem = { name: l.loanName, balance: Math.abs(num(l.currentBalance)), source: "loan" };
    if (l.loanType === "mortgage") mortgages.push(item);
    else otherLoans.push(item);
    liabilitySources.push({
      name: l.loanName,
      balance: Math.abs(num(l.currentBalance)),
      lastSyncedAt: null,
      origin: "manual",
    });
  }

  const totalLiabilities =
    [...creditCards, ...mortgages, ...otherLoans].reduce((s, i) => s + i.balance, 0);

  return {
    totalAssets,
    totalLiabilities,
    netWorth: totalAssets - totalLiabilities,
    liabilitiesBreakdown: { creditCards, mortgages, otherLoans },
    assetSources,
    liabilitySources,
  };
}
