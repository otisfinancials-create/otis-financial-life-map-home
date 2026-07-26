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

import { useCreateAccount, useUpdateAccount, useUpdateAccountCycleConfig, getListAccountsQueryKey, getGetAccountsSummaryQueryKey, getGetDashboardSummaryQueryKey, getListAccountCyclesQueryKey } from "@workspace/api-client-react";
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
    const saveCycleConfig = (accountId: number) => {
      if (values.accountType !== "credit_card" || values.statementDay === "" || values.dueDay === "") return;
      const statementDay = Number(values.statementDay);
      const dueDay = Number(values.dueDay);
      if (statementDay === account?.statementDay && dueDay === account?.dueDay) return;
      updateCycleConfig.mutate({ id: accountId, data: { statementDay, dueDay } }, {
        onSuccess: () => {
          invalidate();
          queryClient.invalidateQueries({ queryKey: getListAccountCyclesQueryKey(accountId) });
          toast({ title: "Billing cycles generated" });
        },
        onError: () => toast({ title: "Failed to generate billing cycles", variant: "destructive" }),
      });
    };
    if (isEditing) {
      updateAccount.mutate({ id: account.id, data }, {
        onSuccess: () => {
          invalidate();
          saveCycleConfig(account.id);
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
          saveCycleConfig(created.id);
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
