import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { PiggyBank } from "lucide-react";

import {
  useListAccounts,
  useUpdateAccount,
  useGetSavingsSummary,
  getListAccountsQueryKey,
  getGetSavingsSummaryQueryKey,
} from "@workspace/api-client-react";
import type { Account } from "@workspace/api-client-react";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";
import { FormatCurrency } from "@/components/ui/format-currency";

const SAVINGS_INVESTMENT_TYPES = ["savings", "investment", "brokerage"];

const TYPE_LABELS: Record<string, string> = {
  savings: "Savings",
  investment: "Investment",
  brokerage: "Brokerage",
};

function GoalSection({ account }: { account: Account }) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const updateAccount = useUpdateAccount();
  const [editing, setEditing] = useState(false);
  const [goalInput, setGoalInput] = useState(
    account.savingsGoal != null ? String(account.savingsGoal) : "",
  );

  const goal = account.savingsGoal;

  function save() {
    const trimmed = goalInput.trim();
    const value = trimmed === "" ? null : parseFloat(trimmed);
    if (value !== null && (!Number.isFinite(value) || value < 0)) {
      toast({ title: "Enter a valid goal amount", variant: "destructive" });
      return;
    }
    updateAccount.mutate(
      { id: account.id, data: { savingsGoal: value } },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getListAccountsQueryKey() });
          queryClient.invalidateQueries({ queryKey: getGetSavingsSummaryQueryKey() });
          setEditing(false);
          toast({ title: value === null ? "Goal cleared" : "Goal saved" });
        },
        onError: () => toast({ title: "Could not save goal", variant: "destructive" }),
      },
    );
  }

  if (editing || goal == null) {
    return (
      <div className="mt-3 flex items-center gap-2">
        <Input
          type="number"
          min="0"
          step="0.01"
          placeholder="Set a goal for this account ($)"
          className="h-8 max-w-[240px] text-[13px]"
          value={goalInput}
          onChange={(e) => setGoalInput(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && save()}
        />
        <Button size="sm" className="h-8" onClick={save} disabled={updateAccount.isPending}>
          Save
        </Button>
        {editing && (
          <Button
            size="sm"
            variant="ghost"
            className="h-8"
            onClick={() => {
              setEditing(false);
              setGoalInput(goal != null ? String(goal) : "");
            }}
          >
            Cancel
          </Button>
        )}
      </div>
    );
  }

  const pct = goal > 0 ? Math.min(100, Math.round((account.currentBalance / goal) * 100)) : 0;

  return (
    <div className="mt-3">
      <div className="flex items-center justify-between text-[12px] text-muted-foreground mb-1.5">
        <span>
          <FormatCurrency amount={account.currentBalance} /> of{" "}
          <FormatCurrency amount={goal} /> goal — {pct}% there
        </span>
        <button
          type="button"
          className="text-[12px] text-[#56A0D3] hover:underline"
          onClick={() => {
            setGoalInput(String(goal));
            setEditing(true);
          }}
        >
          Edit goal
        </button>
      </div>
      <div className="h-2 w-full rounded-full bg-muted overflow-hidden">
        <div
          className="h-full rounded-full transition-all"
          style={{ width: `${pct}%`, background: "#56A0D3" }}
        />
      </div>
    </div>
  );
}

export default function SavingsInvestments() {
  const { data: accounts, isLoading } = useListAccounts();
  const { data: summary } = useGetSavingsSummary();

  const savingsAccounts = (accounts ?? []).filter((a) =>
    SAVINGS_INVESTMENT_TYPES.includes(a.accountType),
  );
  const total = savingsAccounts.reduce((s, a) => s + a.currentBalance, 0);
  const momChange = summary?.momChange ?? null;

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-2xl font-bold text-foreground">Savings &amp; Investments</h1>
        <p className="text-sm text-muted-foreground mt-0.5">
          Track your savings and investment balances
        </p>
      </div>

      {isLoading ? (
        <div className="space-y-4">
          {[1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-28 w-full rounded-xl" />
          ))}
        </div>
      ) : (
        <>
          <Card className="border-card-border bg-card rounded-xl p-5">
            <div className="flex items-center gap-3">
              <div className="flex h-10 w-10 items-center justify-center rounded-full bg-[#E6F1FB]">
                <PiggyBank className="h-5 w-5 text-[#56A0D3]" strokeWidth={1.5} />
              </div>
              <div>
                <p className="text-[12px] font-medium uppercase tracking-wide text-muted-foreground">
                  Total Savings &amp; Investments
                </p>
                <p className="text-2xl font-bold font-mono">
                  <FormatCurrency amount={total} />
                </p>
                <p className="text-[12px] text-muted-foreground">
                  {savingsAccounts.length} account{savingsAccounts.length === 1 ? "" : "s"}
                  {momChange != null && (
                    <span
                      className={momChange >= 0 ? "text-[#059669] ml-2" : "text-[#dc2626] ml-2"}
                    >
                      {momChange >= 0 ? "▲" : "▼"} <FormatCurrency amount={Math.abs(momChange)} />{" "}
                      vs last month
                    </span>
                  )}
                </p>
              </div>
            </div>
          </Card>

          {savingsAccounts.length === 0 ? (
            <Card className="border-card-border bg-card rounded-xl p-8 text-center text-sm text-muted-foreground">
              Add savings or investment accounts in Connected Accounts to see them here.
            </Card>
          ) : (
            <div className="space-y-3">
              {savingsAccounts.map((account) => (
                <Card key={account.id} className="border-card-border bg-card rounded-xl p-5">
                  <div className="flex items-start justify-between gap-4">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <p className="font-semibold truncate">{account.accountName}</p>
                        <Badge variant="secondary" className="text-[11px]">
                          {TYPE_LABELS[account.accountType] ?? account.accountType}
                        </Badge>
                      </div>
                      <p className="text-[12px] text-muted-foreground mt-0.5">
                        {account.institutionName}
                      </p>
                    </div>
                    <p className="text-lg font-bold font-mono shrink-0">
                      <FormatCurrency amount={account.currentBalance} />
                    </p>
                  </div>
                  <GoalSection account={account} />
                </Card>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}
