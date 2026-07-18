import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import { FormatCurrency } from "@/components/ui/format-currency";
import { monthlyFactor } from "@/lib/bill-math";
import { accountTypeMeta } from "@/utils/categoryIcons";
import type { Account, Asset, Loan, PaySchedule, Bill } from "@workspace/api-client-react";

/* ── Shared helpers ───────────────────────────────────────────────────── */

const titleCase = (type: string) =>
  type
    .split(/[_\s]+/)
    .map((w) => (w ? w[0]!.toUpperCase() + w.slice(1) : w))
    .join(" ");

const accountTypeLabel = (type: string) => accountTypeMeta(type)?.label ?? titleCase(type);

// Mirrors the server's dedup rule (financial-dedup.ts): a loan is a duplicate
// if a liability account has the same name (case-insensitive) OR the same
// monthly payment (account monthlyContribution).
function dedupeLoans(loans: Loan[], liabilityAccounts: Account[]): Loan[] {
  return loans.filter(
    (l) =>
      !liabilityAccounts.some((a) => {
        if (a.accountName.trim().toLowerCase() === l.loanName.trim().toLowerCase()) return true;
        const acctPayment = Number(a.monthlyContribution) || 0;
        return acctPayment > 0 && Math.abs(acctPayment - l.monthlyPayment) < 0.005;
      }),
  );
}

function TypeBadge({ label }: { label: string }) {
  return (
    <Badge variant="secondary" className="shrink-0 font-normal">
      {label}
    </Badge>
  );
}

function LineRow({
  name,
  badge,
  amount,
  amountClass = "",
}: {
  name: string;
  badge?: string;
  amount: number;
  amountClass?: string;
}) {
  return (
    <div className="flex items-center justify-between gap-3 py-1.5">
      <div className="flex items-center gap-2 min-w-0">
        <span className="text-sm truncate">{name}</span>
        {badge && <TypeBadge label={badge} />}
      </div>
      <span className={`text-sm font-mono tabular-nums shrink-0 ${amountClass}`}>
        <FormatCurrency amount={amount} />
      </span>
    </div>
  );
}

/* ── #14 Net Worth breakdown ──────────────────────────────────────────── */

export function NetWorthModal({
  open,
  onOpenChange,
  accounts,
  assets,
  loans,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  accounts: Account[];
  assets: Asset[];
  loans: Loan[];
}) {
  const assetAccounts = accounts.filter((a) => a.isAsset);
  const liabilityAccounts = accounts.filter((a) => !a.isAsset);
  const dedupedLoans = dedupeLoans(loans, liabilityAccounts);

  const assetsTotal =
    assetAccounts.reduce((s, a) => s + a.currentBalance, 0) +
    assets.reduce((s, a) => s + a.currentBalance, 0);
  const liabilitiesTotal =
    liabilityAccounts.reduce((s, a) => s + Math.abs(a.currentBalance), 0) +
    dedupedLoans.reduce((s, l) => s + l.currentBalance, 0);
  const netWorth = assetsTotal - liabilitiesTotal;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>How your net worth is calculated</DialogTitle>
        </DialogHeader>

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div className="rounded-lg border border-border p-4">
            <h3 className="text-sm font-semibold text-emerald-600 mb-2">Assets</h3>
            <div className="divide-y divide-border">
              {assetAccounts.map((a) => (
                <LineRow
                  key={`acc-${a.id}`}
                  name={a.accountName}
                  badge={accountTypeLabel(a.accountType)}
                  amount={a.currentBalance}
                  amountClass="text-emerald-600"
                />
              ))}
              {assets.map((a) => (
                <LineRow
                  key={`asset-${a.id}`}
                  name={a.assetName}
                  badge={titleCase(a.assetType)}
                  amount={a.currentBalance}
                  amountClass="text-emerald-600"
                />
              ))}
              {assetAccounts.length === 0 && assets.length === 0 && (
                <p className="text-sm text-muted-foreground py-1.5">No assets.</p>
              )}
            </div>
            <div className="flex items-center justify-between pt-2 mt-1 border-t border-border">
              <span className="text-sm font-medium">Total</span>
              <span className="text-sm font-mono tabular-nums font-semibold text-emerald-600">
                <FormatCurrency amount={assetsTotal} />
              </span>
            </div>
          </div>

          <div className="rounded-lg border border-border p-4">
            <h3 className="text-sm font-semibold text-orange-600 mb-2">Liabilities</h3>
            <div className="divide-y divide-border">
              {liabilityAccounts.map((a) => (
                <LineRow
                  key={`lacc-${a.id}`}
                  name={a.accountName}
                  badge={accountTypeLabel(a.accountType)}
                  amount={Math.abs(a.currentBalance)}
                  amountClass="text-orange-600"
                />
              ))}
              {dedupedLoans.map((l) => (
                <LineRow
                  key={`loan-${l.id}`}
                  name={l.loanName}
                  badge={titleCase(l.loanType)}
                  amount={l.currentBalance}
                  amountClass="text-orange-600"
                />
              ))}
              {liabilityAccounts.length === 0 && dedupedLoans.length === 0 && (
                <p className="text-sm text-muted-foreground py-1.5">No liabilities.</p>
              )}
            </div>
            <div className="flex items-center justify-between pt-2 mt-1 border-t border-border">
              <span className="text-sm font-medium">Total</span>
              <span className="text-sm font-mono tabular-nums font-semibold text-orange-600">
                <FormatCurrency amount={liabilitiesTotal} />
              </span>
            </div>
          </div>
        </div>

        <div className="rounded-lg bg-muted/50 p-4 flex flex-wrap items-center justify-center gap-x-2 gap-y-1 text-base font-bold font-mono tabular-nums">
          <span className="text-emerald-600">
            <FormatCurrency amount={assetsTotal} />
          </span>
          <span className="text-muted-foreground">−</span>
          <span className="text-orange-600">
            <FormatCurrency amount={liabilitiesTotal} />
          </span>
          <span className="text-muted-foreground">=</span>
          <span>
            <FormatCurrency amount={netWorth} />
          </span>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/* ── #15 Monthly Cash Flow breakdown ──────────────────────────────────── */

export function CashFlowModal({
  open,
  onOpenChange,
  paySchedules,
  bills,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  paySchedules: PaySchedule[];
  bills: Bill[];
}) {
  const incomeRows = paySchedules.map((p) => ({
    name: p.employerName,
    amount: p.amount * monthlyFactor(p.frequency),
  }));
  const moneyIn = incomeRows.reduce((s, r) => s + r.amount, 0);

  const byCategory = bills
    .filter((b) => b.isActive)
    .reduce<Record<string, number>>((acc, b) => {
      acc[b.category] = (acc[b.category] ?? 0) + b.amount * monthlyFactor(b.frequency);
      return acc;
    }, {});
  const outRows = Object.entries(byCategory).sort((a, b) => b[1] - a[1]);
  const moneyOut = outRows.reduce((s, [, v]) => s + v, 0);

  const net = moneyIn - moneyOut;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Your monthly cash flow</DialogTitle>
        </DialogHeader>

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div className="rounded-lg border border-border p-4">
            <h3 className="text-sm font-semibold text-emerald-600 mb-2">Money In</h3>
            <div className="divide-y divide-border">
              {incomeRows.length ? (
                incomeRows.map((r, i) => (
                  <LineRow key={i} name={r.name} amount={r.amount} amountClass="text-emerald-600" />
                ))
              ) : (
                <p className="text-sm text-muted-foreground py-1.5">No pay entries.</p>
              )}
            </div>
            <div className="flex items-center justify-between pt-2 mt-1 border-t border-border">
              <span className="text-sm font-medium">Total</span>
              <span className="text-sm font-mono tabular-nums font-semibold text-emerald-600">
                <FormatCurrency amount={moneyIn} />
              </span>
            </div>
          </div>

          <div className="rounded-lg border border-border p-4">
            <h3 className="text-sm font-semibold text-red-600 mb-2">Money Out</h3>
            <div className="divide-y divide-border">
              {outRows.length ? (
                outRows.map(([cat, amt]) => (
                  <LineRow key={cat} name={cat} amount={amt} amountClass="text-red-600" />
                ))
              ) : (
                <p className="text-sm text-muted-foreground py-1.5">No active bills.</p>
              )}
            </div>
            <div className="flex items-center justify-between pt-2 mt-1 border-t border-border">
              <span className="text-sm font-medium">Total</span>
              <span className="text-sm font-mono tabular-nums font-semibold text-red-600">
                <FormatCurrency amount={moneyOut} />
              </span>
            </div>
          </div>
        </div>

        <div className="rounded-lg bg-muted/50 p-4 flex items-center justify-between">
          <span className="text-base font-bold">Net Cash Flow</span>
          <span
            className={`text-base font-bold font-mono tabular-nums ${
              net >= 0 ? "text-emerald-600" : "text-red-600"
            }`}
          >
            <FormatCurrency amount={net} showSign />
          </span>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/* ── #16 Total Liabilities breakdown ──────────────────────────────────── */

export function LiabilitiesModal({
  open,
  onOpenChange,
  accounts,
  loans,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  accounts: Account[];
  loans: Loan[];
}) {
  const liabilityAccounts = accounts.filter((a) => !a.isAsset);
  const dedupedLoans = dedupeLoans(loans, liabilityAccounts);

  const mortgages = dedupedLoans.filter((l) => l.loanType.toLowerCase() === "mortgage");
  const otherLoans = dedupedLoans.filter((l) => l.loanType.toLowerCase() !== "mortgage");
  const creditCards = liabilityAccounts.filter((a) => a.accountType === "credit_card");
  // Liability accounts that aren't credit cards (e.g. loan/mortgage accounts)
  // still count toward the total and are shown alongside loans.
  const otherLiabilityAccounts = liabilityAccounts.filter((a) => a.accountType !== "credit_card");
  const mortgageAccounts = otherLiabilityAccounts.filter((a) => a.accountType === "mortgage");
  const loanAccounts = otherLiabilityAccounts.filter((a) => a.accountType !== "mortgage");

  const total =
    dedupedLoans.reduce((s, l) => s + l.currentBalance, 0) +
    liabilityAccounts.reduce((s, a) => s + Math.abs(a.currentBalance), 0);

  const Section = ({
    title,
    rows,
  }: {
    title: string;
    rows: { key: string; name: string; badge?: string; amount: number }[];
  }) => (
    <div className="rounded-lg border border-border p-4">
      <h3 className="text-sm font-semibold mb-2">{title}</h3>
      <div className="divide-y divide-border">
        {rows.length ? (
          rows.map((r) => (
            <LineRow
              key={r.key}
              name={r.name}
              badge={r.badge}
              amount={r.amount}
              amountClass="text-orange-600"
            />
          ))
        ) : (
          <p className="text-sm text-muted-foreground py-1.5">None.</p>
        )}
      </div>
    </div>
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Your total liabilities</DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
          <Section
            title="Mortgages"
            rows={[
              ...mortgages.map((l) => ({
                key: `m-${l.id}`,
                name: l.loanName,
                badge: titleCase(l.loanType),
                amount: l.currentBalance,
              })),
              ...mortgageAccounts.map((a) => ({
                key: `ma-${a.id}`,
                name: a.accountName,
                badge: accountTypeLabel(a.accountType),
                amount: Math.abs(a.currentBalance),
              })),
            ]}
          />
          <Section
            title="Loans"
            rows={[
              ...otherLoans.map((l) => ({
                key: `l-${l.id}`,
                name: l.loanName,
                badge: titleCase(l.loanType),
                amount: l.currentBalance,
              })),
              ...loanAccounts.map((a) => ({
                key: `la-${a.id}`,
                name: a.accountName,
                badge: accountTypeLabel(a.accountType),
                amount: Math.abs(a.currentBalance),
              })),
            ]}
          />
          <Section
            title="Credit Cards"
            rows={creditCards.map((a) => ({
              key: `cc-${a.id}`,
              name: a.accountName,
              badge: accountTypeLabel(a.accountType),
              amount: Math.abs(a.currentBalance),
            }))}
          />

          <div className="rounded-lg bg-muted/50 p-4 flex items-center justify-between">
            <span className="text-base font-bold">Total Liabilities</span>
            <span className="text-base font-bold font-mono tabular-nums text-orange-600">
              <FormatCurrency amount={total} />
            </span>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/* ── Savings & Investments breakdown ──────────────────────────────────── */

const SAVINGS_INVESTMENT_TYPES = ["savings", "investment", "retirement", "brokerage"];

export function SavingsInvestmentsModal({
  open,
  onOpenChange,
  accounts,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  accounts: Account[];
}) {
  const list = accounts.filter((a) => SAVINGS_INVESTMENT_TYPES.includes(a.accountType));
  const total = list.reduce((s, a) => s + a.currentBalance, 0);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Your savings &amp; investments</DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
          <div className="rounded-lg border border-border p-4">
            <div className="divide-y divide-border">
              {list.length ? (
                list.map((a) => (
                  <LineRow
                    key={`si-${a.id}`}
                    name={a.accountName}
                    badge={accountTypeLabel(a.accountType)}
                    amount={a.currentBalance}
                    amountClass="text-emerald-600"
                  />
                ))
              ) : (
                <p className="text-sm text-muted-foreground py-1.5">
                  No savings or investment accounts.
                </p>
              )}
            </div>
            <div className="flex items-center justify-between pt-2 mt-1 border-t border-border">
              <span className="text-sm font-medium">Total</span>
              <span className="text-sm font-mono tabular-nums font-semibold text-emerald-600">
                <FormatCurrency amount={total} />
              </span>
            </div>
          </div>

          <div className="rounded-lg bg-muted/50 p-4 flex items-center justify-between">
            <span className="text-base font-bold">Savings &amp; Investments</span>
            <span className="text-base font-bold font-mono tabular-nums text-emerald-600">
              <FormatCurrency amount={total} />
            </span>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/* ── Bills Snapshot breakdown ─────────────────────────────────────────── */

export function BillsSnapshotModal({
  open,
  onOpenChange,
  takeHomePay,
  totalBills,
  netCashFlow,
  daysUntilPaycheck,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  takeHomePay: number;
  totalBills: number;
  netCashFlow: number;
  daysUntilPaycheck: number | null;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Bills snapshot</DialogTitle>
        </DialogHeader>

        <div className="grid grid-cols-2 gap-4">
          <div className="rounded-lg border border-border p-4 text-center">
            <p className="text-2xl font-bold font-mono tabular-nums text-emerald-600">
              <FormatCurrency amount={takeHomePay} compact />
            </p>
            <p className="text-xs text-muted-foreground mt-1 uppercase tracking-wider font-medium">
              Take-home pay
            </p>
          </div>
          <div className="rounded-lg border border-border p-4 text-center">
            <p className="text-2xl font-bold font-mono tabular-nums text-orange-600">
              <FormatCurrency amount={totalBills} compact />
            </p>
            <p className="text-xs text-muted-foreground mt-1 uppercase tracking-wider font-medium">
              Total bills
            </p>
          </div>
          <div className="rounded-lg border border-border p-4 text-center">
            <p
              className={`text-2xl font-bold font-mono tabular-nums ${
                netCashFlow >= 0 ? "text-emerald-600" : "text-red-600"
              }`}
            >
              <FormatCurrency amount={netCashFlow} compact showSign />
            </p>
            <p className="text-xs text-muted-foreground mt-1 uppercase tracking-wider font-medium">
              Net cash flow
            </p>
          </div>
          <div className="rounded-lg border border-border p-4 text-center">
            <p className="text-2xl font-bold font-mono tabular-nums text-primary">
              {daysUntilPaycheck === null
                ? "—"
                : daysUntilPaycheck === 0
                  ? "Today"
                  : `${daysUntilPaycheck}d`}
            </p>
            <p className="text-xs text-muted-foreground mt-1 uppercase tracking-wider font-medium">
              Next paycheck
            </p>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
