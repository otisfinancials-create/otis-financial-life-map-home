import { useEffect, useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import * as z from "zod";
import { useQueryClient } from "@tanstack/react-query";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";

import { useCreateAccount, useUpdateAccount, useUpdateAccountCycleConfig, useUpdateAccountPaymentMode, getListAccountsQueryKey, getGetAccountsSummaryQueryKey, getGetDashboardSummaryQueryKey, getListAccountCyclesQueryKey } from "@workspace/api-client-react";
import type { Account } from "@workspace/api-client-react";

export const ACCOUNT_TYPE_OPTIONS = [
  { value: "checking", label: "Checking" },
  { value: "savings", label: "Savings" },
  { value: "investment", label: "Investment" },
  { value: "brokerage", label: "Brokerage" },
  { value: "credit_card", label: "Credit Card" },
  { value: "retirement", label: "Retirement" },
  { value: "mortgage", label: "Mortgage" },
  { value: "loan", label: "Loan" },
  { value: "other", label: "Other" },
] as const;

const LIABILITY_TYPES = ["credit_card", "loan", "mortgage"];

const accountSchema = z
  .object({
    accountName: z.string().min(2, { message: "Name must be at least 2 characters." }),
    institutionName: z.string().min(1, { message: "Please provide an institution name." }),
    accountType: z.string().min(1, { message: "Please select an account type." }),
    currentBalance: z.coerce
      .number({ message: "Balance must be a number." })
      .refine((v) => Number.isFinite(v), { message: "Balance must be a number." })
      .refine((v) => /^-?\d{1,9}(\.\d{1,2})?$/.test(String(v)), {
        message: "Balance is limited to 9 digits before the decimal point and 2 decimal places.",
      }),
    accountNumberLast4: z
      .string()
      .refine((v) => v === "" || /^\d{4}$/.test(v), { message: "Enter exactly 4 digits." }),
    monthlyContribution: z.coerce
      .number({ message: "Monthly contribution must be a number." })
      .refine((v) => Number.isFinite(v) && v >= 0, {
        message: "Monthly contribution must be a positive number.",
      }),
    notes: z.string().max(200, { message: "Notes are limited to 200 characters." }),
    statementDay: z.string(),
    dueDay: z.string(),
    paymentMode: z.enum(["full", "fixed"]),
    fixedPaymentAmount: z.string(),
    payoffTargetDate: z.string(),
  })
  .superRefine((vals, ctx) => {
    if (vals.accountType === "credit_card") {
      // Billing cycle needs both days or neither.
      if ((vals.statementDay === "") !== (vals.dueDay === "")) {
        ctx.addIssue({ code: "custom", path: [vals.statementDay === "" ? "statementDay" : "dueDay"], message: "Set both statement and due day, or neither." });
      }
      for (const key of ["statementDay", "dueDay"] as const) {
        const v = vals[key];
        if (v !== "" && !(/^\d+$/.test(v) && Number(v) >= 1 && Number(v) <= 31)) {
          ctx.addIssue({ code: "custom", path: [key], message: "Enter a day of month (1-31)." });
        }
      }
      if (vals.paymentMode === "fixed") {
        const amt = Number(vals.fixedPaymentAmount);
        if (vals.fixedPaymentAmount === "" || !Number.isFinite(amt) || amt <= 0) {
          ctx.addIssue({ code: "custom", path: ["fixedPaymentAmount"], message: "Enter the amount you pay each month." });
        }
      }
    }
    if (LIABILITY_TYPES.includes(vals.accountType) && vals.currentBalance < 0) {
      ctx.addIssue({
        code: "custom",
        path: ["currentBalance"],
        message:
          "Credit card and loan balances are always treated as negative in calculations. Enter the balance as a positive number and Otis will do the rest.",
      });
    }
  });

type AccountFormValues = z.infer<typeof accountSchema>;

// ─── Billing-cycle plain-English preview ─────────────────────────────────────

const ordinal = (n: number) => {
  const s = ["th", "st", "nd", "rd"] as const;
  const v = n % 100;
  return `${n}${s[(v - 20) % 10] ?? s[v] ?? s[0]}`;
};

/** Day clamped to the given month (year, monthIndex 0-based, may overflow). */
function clampedDate(year: number, monthIndex: number, day: number): Date {
  const y = year + Math.floor(monthIndex / 12);
  const m = ((monthIndex % 12) + 12) % 12;
  const last = new Date(y, m + 1, 0).getDate();
  return new Date(y, m, Math.min(day, last));
}

const monD = (d: Date) => d.toLocaleDateString("en-US", { month: "short", day: "numeric" });

/**
 * Live preview of the derived cycle: start = day after close, end = closing
 * day, due = due day in the month AFTER the close. Short months clamp the
 * closing day (e.g. 31 → Feb 28/29); the example uses real calendar dates.
 */
function CyclePreview({ statementDay, dueDay }: { statementDay: string; dueDay: string }) {
  const close = /^\d+$/.test(statementDay) ? Number(statementDay) : NaN;
  const due = /^\d+$/.test(dueDay) ? Number(dueDay) : NaN;
  if (!(close >= 1 && close <= 31 && due >= 1 && due <= 31)) return null;

  const now = new Date();
  const y = now.getFullYear();
  // Example window: the CURRENT cycle — first statement close on/after today
  // (same rule the server uses when generating cycles).
  let m = now.getMonth();
  if (clampedDate(y, m, close).getTime() < new Date(y, now.getMonth(), now.getDate()).getTime()) m += 1;
  const exampleClose = clampedDate(y, m, close);
  const exampleStart = new Date(clampedDate(y, m - 1, close));
  exampleStart.setDate(exampleStart.getDate() + 1);
  const exampleDue = clampedDate(y, m + 1, due);

  const startDay = close >= 31 ? 1 : close + 1;
  return (
    <p className="text-xs text-foreground bg-white border border-border rounded-md px-2.5 py-2" data-testid="cycle-preview">
      Runs the {ordinal(startDay)} to the {ordinal(close)} each month, payment due the {ordinal(due)} of the
      following month. Example: {monD(exampleStart)} – {monD(exampleClose)}, due {monD(exampleDue)}.
    </p>
  );
}

interface AccountDialogProps {
  account?: Account;
  trigger?: React.ReactNode;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}

export function AccountDialog({ account, trigger, open, onOpenChange }: AccountDialogProps) {
  const [internalOpen, setInternalOpen] = useState(false);
  const isControlled = open !== undefined && onOpenChange !== undefined;
  const isOpen = isControlled ? open : internalOpen;
  const setIsOpen = isControlled ? onOpenChange : setInternalOpen;

  const { toast } = useToast();
  const queryClient = useQueryClient();
  const createAccount = useCreateAccount();
  const updateAccount = useUpdateAccount();
  const updateCycleConfig = useUpdateAccountCycleConfig();
  const updatePaymentMode = useUpdateAccountPaymentMode();
  const isEditing = !!account;

  const defaults = (): AccountFormValues => ({
    accountName: account?.accountName || "",
    institutionName: account?.institutionName || "",
    accountType: account?.accountType || "",
    currentBalance: account?.currentBalance || 0,
    accountNumberLast4: account?.accountNumberLast4 || "",
    monthlyContribution: account?.monthlyContribution || 0,
    notes: account?.notes || "",
    statementDay: account?.statementDay != null ? String(account.statementDay) : "",
    dueDay: account?.dueDay != null ? String(account.dueDay) : "",
    paymentMode: (account?.paymentMode as "full" | "fixed" | undefined) ?? "full",
    fixedPaymentAmount: account?.fixedPaymentAmount != null ? String(account.fixedPaymentAmount) : "",
    payoffTargetDate: account?.payoffTargetDate ?? "",
  });

  const form = useForm<AccountFormValues>({
    resolver: zodResolver(accountSchema),
    defaultValues: defaults(),
  });

  useEffect(() => {
    if (isOpen) {
      form.reset(defaults());
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, account?.id]);

  function onSubmit(values: AccountFormValues) {
    const isLiability = LIABILITY_TYPES.includes(values.accountType);
    const data = {
      accountName: values.accountName,
      institutionName: values.institutionName,
      accountType: values.accountType,
      // Liability balances are stored as positive magnitudes and treated as
      // negative in all calculations (isAsset: false).
      currentBalance: isLiability ? Math.abs(values.currentBalance) : values.currentBalance,
      isAsset: !isLiability,
      accountNumberLast4: values.accountNumberLast4 || null,
      monthlyContribution: values.accountType === "retirement" ? values.monthlyContribution : 0,
      notes: values.notes || null,
      // Legacy per-account cycle fields are retired: the single statement/due
      // day config is the only cycle definition. Clear the stale values so the
      // old forecast grouping path can't disagree with the cycles — but only
      // once a real cycle config exists, so a card still mid-migration (legacy
      // fields set, no statement/due day yet) keeps its forecast grouping.
      ...(values.accountType === "credit_card" && values.statementDay !== "" && values.dueDay !== ""
        ? { ccCycleStartDate: null, ccCycleEndDate: null, ccPaymentDueDate: null }
        : {}),
    };
    const invalidate = () => {
      queryClient.invalidateQueries({ queryKey: getListAccountsQueryKey() });
      queryClient.invalidateQueries({ queryKey: getGetAccountsSummaryQueryKey() });
      queryClient.invalidateQueries({ queryKey: getGetDashboardSummaryQueryKey() });
    };
    // Envelope-cycle config (statement/due day): saved via its own endpoint,
    // which also generates the card's cycles.
    // `then` runs after the cycle-config save settles (or immediately when
    // nothing changed) — payment-mode must not race it, since both endpoints
    // regenerate the forecast and last-write-wins on stale state otherwise.
    const saveCycleConfig = (accountId: number, then?: () => void) => {
      if (values.accountType !== "credit_card" || values.statementDay === "" || values.dueDay === "") {
        then?.();
        return;
      }
      const statementDay = Number(values.statementDay);
      const dueDay = Number(values.dueDay);
      if (statementDay === account?.statementDay && dueDay === account?.dueDay) {
        then?.();
        return;
      }
      updateCycleConfig.mutate({ id: accountId, data: { statementDay, dueDay } }, {
        onSuccess: () => {
          invalidate();
          queryClient.invalidateQueries({ queryKey: getListAccountCyclesQueryKey(accountId) });
          toast({ title: "Billing cycles generated" });
        },
        onError: () => toast({ title: "Failed to generate billing cycles", variant: "destructive" }),
        onSettled: () => then?.(),
      });
    };
    // Payment mode (full vs fixed) is saved via its own endpoint, which
    // also rebuilds the forecast and reports the payoff projection.
    const savePaymentMode = (accountId: number) => {
      if (values.accountType !== "credit_card") return;
      const fixedAmt = values.paymentMode === "fixed" ? Number(values.fixedPaymentAmount) : null;
      const payoff = values.paymentMode === "fixed" && values.payoffTargetDate !== "" ? values.payoffTargetDate : null;
      const unchanged =
        values.paymentMode === (account?.paymentMode ?? "full") &&
        (fixedAmt ?? null) === (account?.fixedPaymentAmount ?? null) &&
        (payoff ?? null) === (account?.payoffTargetDate ?? null);
      if (unchanged) return;
      updatePaymentMode.mutate(
        { id: accountId, data: { paymentMode: values.paymentMode, fixedPaymentAmount: fixedAmt, payoffTargetDate: payoff } },
        {
          onSuccess: (result) => {
            invalidate();
            if (result.shortfallAtTarget != null) {
              toast({
                title: "Fixed payment won't hit your payoff date",
                description: `About $${result.shortfallAtTarget.toFixed(2)} would still remain on ${result.account.payoffTargetDate}. Consider a higher amount.`,
                variant: "destructive",
              });
            } else if (values.paymentMode === "fixed" && result.projectedPayoffDate) {
              toast({ title: "Fixed payment plan saved", description: `Projected payoff: ${result.projectedPayoffDate}` });
            }
          },
          onError: () => toast({ title: "Failed to save payment plan", variant: "destructive" }),
        },
      );
    };
    if (isEditing) {
      updateAccount.mutate({ id: account.id, data }, {
        onSuccess: () => {
          invalidate();
          saveCycleConfig(account.id, () => savePaymentMode(account.id));
          toast({ title: "Account updated successfully" });
          setIsOpen(false);
          if (!isControlled) form.reset();
        },
        onError: () => {
          toast({ title: "Failed to update account", variant: "destructive" });
        }
      });
    } else {
      createAccount.mutate({ data }, {
        onSuccess: (created) => {
          invalidate();
          saveCycleConfig(created.id, () => savePaymentMode(created.id));
          toast({ title: "Account created successfully" });
          setIsOpen(false);
          if (!isControlled) form.reset();
        },
        onError: () => {
          toast({ title: "Failed to create account", variant: "destructive" });
        }
      });
    }
  }

  const handleOpenChange = (newOpen: boolean) => {
    if (!newOpen && !isControlled) {
      form.reset();
    }
    setIsOpen(newOpen);
  };

  return (
    <Dialog open={isOpen} onOpenChange={handleOpenChange}>
      {trigger && <DialogTrigger asChild>{trigger}</DialogTrigger>}
      <DialogContent className="sm:max-w-[425px]">
        <DialogHeader>
          <DialogTitle>{isEditing ? "Edit Account" : "Add Account"}</DialogTitle>
          <DialogDescription>
            {isEditing ? "Make changes to your account details." : "Add a financial account, or track a card manually with statement and due days."}
          </DialogDescription>
        </DialogHeader>
        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
            <FormField
              control={form.control}
              name="accountName"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Account Name</FormLabel>
                  <FormControl>
                    <Input placeholder="e.g. Primary Checking, 401k" {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="institutionName"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Institution Name</FormLabel>
                  <FormControl>
                    <Input placeholder="e.g. Wells Fargo, ETrade" {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <div className="grid grid-cols-2 gap-4">
              <FormField
                control={form.control}
                name="accountType"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Account Type</FormLabel>
                    <Select onValueChange={field.onChange} value={field.value}>
                      <FormControl>
                        <SelectTrigger>
                          <SelectValue placeholder="Select type" />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        {ACCOUNT_TYPE_OPTIONS.map((opt) => (
                          <SelectItem key={opt.value} value={opt.value}>{opt.label}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="currentBalance"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Current Balance</FormLabel>
                    <FormControl>
                      <Input type="number" step="0.01" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>
            {form.watch("accountType") === "credit_card" && (
              <div className="space-y-3 rounded-lg border border-border bg-muted/30 p-3">
                <p className="text-sm font-semibold">Billing Cycle</p>
                <div className="grid grid-cols-2 gap-3">
                  <FormField
                    control={form.control}
                    name="statementDay"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel className="text-xs">Statement closing day</FormLabel>
                        <FormControl>
                          <Input placeholder="14" inputMode="numeric" data-testid="input-statement-day" {...field} />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                  <FormField
                    control={form.control}
                    name="dueDay"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel className="text-xs">Payment due day</FormLabel>
                        <FormControl>
                          <Input placeholder="8" inputMode="numeric" data-testid="input-due-day" {...field} />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                </div>
                <CyclePreview
                  statementDay={form.watch("statementDay")}
                  dueDay={form.watch("dueDay")}
                />
                <p className="text-xs text-muted-foreground">The cycle window and due date are derived from these two days. Billing cycles with spending envelopes are generated automatically; for cards without a bank connection you can record charges by hand from "Manage envelopes".</p>
              </div>
            )}
            {form.watch("accountType") === "credit_card" && (
              <div className="space-y-3 rounded-lg border border-border bg-muted/30 p-3">
                <p className="text-sm font-semibold">Payment Plan</p>
                <FormField
                  control={form.control}
                  name="paymentMode"
                  render={({ field }) => (
                    <FormItem>
                      <FormControl>
                        <div className="grid grid-cols-2 gap-2">
                          <Button
                            type="button"
                            variant={field.value === "full" ? "default" : "outline"}
                            size="sm"
                            onClick={() => field.onChange("full")}
                            data-testid="button-payment-mode-full"
                          >
                            Pay statement in full
                          </Button>
                          <Button
                            type="button"
                            variant={field.value === "fixed" ? "default" : "outline"}
                            size="sm"
                            onClick={() => field.onChange("fixed")}
                            data-testid="button-payment-mode-fixed"
                          >
                            Fixed amount monthly
                          </Button>
                        </div>
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                {form.watch("paymentMode") === "fixed" && (
                  <div className="grid grid-cols-2 gap-3">
                    <FormField
                      control={form.control}
                      name="fixedPaymentAmount"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel className="text-xs">Monthly payment ($)</FormLabel>
                          <FormControl>
                            <Input placeholder="190" inputMode="decimal" data-testid="input-fixed-payment" {...field} />
                          </FormControl>
                          <FormMessage />
                        </FormItem>
                      )}
                    />
                    <FormField
                      control={form.control}
                      name="payoffTargetDate"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel className="text-xs">Payoff goal (optional)</FormLabel>
                          <FormControl>
                            <Input type="date" data-testid="input-payoff-target" {...field} />
                          </FormControl>
                          <FormMessage />
                        </FormItem>
                      )}
                    />
                  </div>
                )}
                <p className="text-xs text-muted-foreground">
                  {form.watch("paymentMode") === "fixed"
                    ? "The forecast spreads the card's carried balance at this amount per cycle until it clears — new charges in a cycle are added on top. If a payoff goal is set, you'll be warned when the amount won't get there."
                    : "The forecast assumes each statement is paid in full on its due date."}
                </p>
              </div>
            )}
            {form.watch("accountType") === "retirement" && (
              <FormField
                control={form.control}
                name="monthlyContribution"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Monthly Contribution ($)</FormLabel>
                    <FormControl>
                      <Input type="number" step="0.01" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
            )}
            <FormField
              control={form.control}
              name="accountNumberLast4"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Account Number (last 4 digits)</FormLabel>
                  <FormControl>
                    <Input placeholder="e.g. 4821" maxLength={4} inputMode="numeric" {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="notes"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Notes</FormLabel>
                  <FormControl>
                    <Textarea placeholder="Optional notes about this account" rows={2} maxLength={200} {...field} />
                  </FormControl>
                  <div className="text-right text-xs text-muted-foreground">{field.value.length}/200</div>
                  <FormMessage />
                </FormItem>
              )}
            />

            <DialogFooter className="pt-4">
              <Button type="button" variant="outline" onClick={() => setIsOpen(false)}>
                Cancel
              </Button>
              <Button type="submit" disabled={createAccount.isPending || updateAccount.isPending}>
                {createAccount.isPending || updateAccount.isPending ? "Saving..." : isEditing ? "Save Changes" : "Add Account"}
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
