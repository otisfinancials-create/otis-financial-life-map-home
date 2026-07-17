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

import { useCreateAccount, useUpdateAccount, getListAccountsQueryKey, getGetAccountsSummaryQueryKey, getGetDashboardSummaryQueryKey } from "@workspace/api-client-react";
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
    ccCycleStartDate: z.string(),
    ccCycleEndDate: z.string(),
    ccPaymentDueDate: z.string(),
  })
  .superRefine((vals, ctx) => {
    if (vals.accountType === "credit_card") {
      for (const key of ["ccCycleStartDate", "ccCycleEndDate", "ccPaymentDueDate"] as const) {
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
  const isEditing = !!account;

  const defaults = (): AccountFormValues => ({
    accountName: account?.accountName || "",
    institutionName: account?.institutionName || "",
    accountType: account?.accountType || "",
    currentBalance: account?.currentBalance || 0,
    accountNumberLast4: account?.accountNumberLast4 || "",
    monthlyContribution: account?.monthlyContribution || 0,
    notes: account?.notes || "",
    ccCycleStartDate: account?.ccCycleStartDate != null ? String(account.ccCycleStartDate) : "",
    ccCycleEndDate: account?.ccCycleEndDate != null ? String(account.ccCycleEndDate) : "",
    ccPaymentDueDate: account?.ccPaymentDueDate != null ? String(account.ccPaymentDueDate) : "",
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
      ccCycleStartDate: values.accountType === "credit_card" && values.ccCycleStartDate !== "" ? Number(values.ccCycleStartDate) : null,
      ccCycleEndDate: values.accountType === "credit_card" && values.ccCycleEndDate !== "" ? Number(values.ccCycleEndDate) : null,
      ccPaymentDueDate: values.accountType === "credit_card" && values.ccPaymentDueDate !== "" ? Number(values.ccPaymentDueDate) : null,
    };
    const invalidate = () => {
      queryClient.invalidateQueries({ queryKey: getListAccountsQueryKey() });
      queryClient.invalidateQueries({ queryKey: getGetAccountsSummaryQueryKey() });
      queryClient.invalidateQueries({ queryKey: getGetDashboardSummaryQueryKey() });
    };
    if (isEditing) {
      updateAccount.mutate({ id: account.id, data }, {
        onSuccess: () => {
          invalidate();
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
        onSuccess: () => {
          invalidate();
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
            {isEditing ? "Make changes to your account details." : "Add a financial account. Plaid sync is coming soon."}
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
                <p className="text-sm font-semibold">Credit Card Billing Cycle</p>
                <div className="grid grid-cols-3 gap-3">
                  <FormField
                    control={form.control}
                    name="ccCycleStartDate"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel className="text-xs">Start Date</FormLabel>
                        <FormControl>
                          <Input placeholder="1" inputMode="numeric" {...field} />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                  <FormField
                    control={form.control}
                    name="ccCycleEndDate"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel className="text-xs">End Date</FormLabel>
                        <FormControl>
                          <Input placeholder="31" inputMode="numeric" {...field} />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                  <FormField
                    control={form.control}
                    name="ccPaymentDueDate"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel className="text-xs">Payment Due Date</FormLabel>
                        <FormControl>
                          <Input placeholder="15" inputMode="numeric" {...field} />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                </div>
                <p className="text-xs text-muted-foreground">Day of month (1-31). Bills paid by this card are grouped in the forecast on the payment due date.</p>
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
