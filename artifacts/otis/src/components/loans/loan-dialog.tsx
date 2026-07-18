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

import {
  useCreateLoan,
  useUpdateLoan,
  getListLoansQueryKey,
  getGetLoansSummaryQueryKey,
  getGetLoanAmortizationQueryKey,
  getGetDashboardSummaryQueryKey,
  getListBillsQueryKey,
} from "@workspace/api-client-react";
import type { Loan } from "@workspace/api-client-react";

export const LOAN_TYPE_OPTIONS = [
  { value: "mortgage", label: "Mortgage" },
  { value: "auto", label: "Auto" },
  { value: "personal", label: "Personal" },
  { value: "student", label: "Student" },
  { value: "other", label: "Other" },
] as const;

export const LOAN_TERM_OPTIONS = [12, 24, 36, 48, 60, 84, 120, 180, 240, 360] as const;

const loanSchema = z.object({
  loanName: z.string().min(2, { message: "Name must be at least 2 characters." }),
  lenderName: z.string().min(1, { message: "Please provide a lender name." }),
  loanType: z.string().min(1, { message: "Please select a loan type." }),
  originalAmount: z.coerce.number().positive({ message: "Enter an amount greater than 0." }),
  currentBalance: z.coerce.number().nonnegative({ message: "Balance cannot be negative." }),
  interestRate: z.coerce.number().min(0, { message: "Rate cannot be negative." }),
  monthlyPayment: z.coerce.number().positive({ message: "Enter a payment greater than 0." }),
  startDate: z.string().min(1, { message: "Please select a start date." }),
  termMonths: z.coerce
    .number({ message: "Enter the term in months." })
    .int({ message: "Term must be a whole number of months." })
    .positive({ message: "Term must be a positive number of months." }),
  nextPaymentDate: z.string().min(1, { message: "Please select a due date." }),
  notes: z.string(),
}).refine((v) => !v.startDate || !v.nextPaymentDate || v.nextPaymentDate >= v.startDate, {
  message: "Next payment date must be on or after the loan start date.",
  path: ["nextPaymentDate"],
});

type LoanFormValues = z.infer<typeof loanSchema>;

interface LoanDialogProps {
  loan?: Loan;
  trigger?: React.ReactNode;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}

const today = () => new Date().toISOString().slice(0, 10);

export function LoanDialog({ loan, trigger, open, onOpenChange }: LoanDialogProps) {
  const [internalOpen, setInternalOpen] = useState(false);
  const isControlled = open !== undefined && onOpenChange !== undefined;
  const isOpen = isControlled ? open : internalOpen;
  const setIsOpen = isControlled ? onOpenChange : setInternalOpen;

  const { toast } = useToast();
  const queryClient = useQueryClient();
  const createLoan = useCreateLoan();
  const updateLoan = useUpdateLoan();
  const isEditing = !!loan;

  // "Custom" loan term: when the saved term isn't one of the presets (or the
  // user picks Custom), show a free-form months input instead of the dropdown.
  const isPresetTerm = (months: number | undefined) =>
    months !== undefined && (LOAN_TERM_OPTIONS as readonly number[]).includes(months);
  const [customTerm, setCustomTerm] = useState(false);

  const defaults = (): LoanFormValues => ({
    loanName: loan?.loanName || "",
    lenderName: loan?.lenderName || "",
    loanType: loan?.loanType || "",
    originalAmount: loan?.originalAmount ?? 0,
    currentBalance: loan?.currentBalance ?? 0,
    interestRate: loan?.interestRate ?? 0,
    monthlyPayment: loan?.monthlyPayment ?? 0,
    startDate: loan?.startDate || today(),
    termMonths: loan?.termMonths ?? 360,
    nextPaymentDate: loan?.nextPaymentDate || today(),
    notes: loan?.notes || "",
  });

  const form = useForm<LoanFormValues>({
    resolver: zodResolver(loanSchema),
    defaultValues: defaults(),
  });

  useEffect(() => {
    if (isOpen) {
      form.reset(defaults());
      setCustomTerm(loan ? !isPresetTerm(loan.termMonths) : false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, loan?.id]);

  function onSubmit(values: LoanFormValues) {
    const data = {
      loanName: values.loanName,
      lenderName: values.lenderName,
      loanType: values.loanType,
      originalAmount: values.originalAmount,
      currentBalance: values.currentBalance,
      interestRate: values.interestRate,
      monthlyPayment: values.monthlyPayment,
      startDate: values.startDate,
      termMonths: values.termMonths,
      nextPaymentDate: values.nextPaymentDate,
      notes: values.notes || null,
    };
    const invalidate = () => {
      queryClient.invalidateQueries({ queryKey: getListLoansQueryKey() });
      queryClient.invalidateQueries({ queryKey: getGetLoansSummaryQueryKey() });
      queryClient.invalidateQueries({ queryKey: getGetDashboardSummaryQueryKey() });
      queryClient.invalidateQueries({ queryKey: getListBillsQueryKey() });
      if (isEditing) {
        queryClient.invalidateQueries({ queryKey: getGetLoanAmortizationQueryKey(loan.id) });
      }
    };
    const billSyncToast = (
      billSync: { matched: boolean; billName: string } | undefined,
      fallback: string,
    ) => {
      if (billSync) {
        toast({
          title: billSync.matched
            ? `This loan payment matches your existing ${billSync.billName} bill — no duplicate created.`
            : `We've added ${billSync.billName} to your Bills to keep your forecast accurate.`,
        });
      } else {
        toast({ title: fallback });
      }
    };
    if (isEditing) {
      updateLoan.mutate({ id: loan.id, data }, {
        onSuccess: (result) => {
          invalidate();
          billSyncToast(result?.billSync, "Loan updated successfully");
          setIsOpen(false);
          if (!isControlled) form.reset();
        },
        onError: () => {
          toast({ title: "Failed to update loan", variant: "destructive" });
        },
      });
    } else {
      createLoan.mutate({ data }, {
        onSuccess: (result) => {
          invalidate();
          billSyncToast(result?.billSync, "Loan created successfully");
          setIsOpen(false);
          if (!isControlled) form.reset();
        },
        onError: () => {
          toast({ title: "Failed to create loan", variant: "destructive" });
        },
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
      <DialogContent className="sm:max-w-[520px] max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{isEditing ? "Edit Loan" : "Add Loan"}</DialogTitle>
          <DialogDescription>
            {isEditing ? "Update the details of this debt obligation." : "Track a new debt obligation with full amortization detail."}
          </DialogDescription>
        </DialogHeader>
        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
            <div className="grid grid-cols-2 gap-4">
              <FormField
                control={form.control}
                name="loanName"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Loan Name</FormLabel>
                    <FormControl>
                      <Input placeholder="e.g. Primary Mortgage" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="lenderName"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Lender</FormLabel>
                    <FormControl>
                      <Input placeholder="e.g. Wells Fargo" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>
            <div className="grid grid-cols-2 gap-4">
              <FormField
                control={form.control}
                name="loanType"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Loan Type</FormLabel>
                    <Select onValueChange={field.onChange} value={field.value}>
                      <FormControl>
                        <SelectTrigger>
                          <SelectValue placeholder="Select type" />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        {LOAN_TYPE_OPTIONS.map((opt) => (
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
                name="termMonths"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Loan Term</FormLabel>
                    <Select
                      onValueChange={(v) => {
                        if (v === "custom") {
                          setCustomTerm(true);
                          field.onChange("");
                        } else {
                          setCustomTerm(false);
                          field.onChange(v);
                        }
                      }}
                      value={customTerm ? "custom" : String(field.value)}
                    >
                      <FormControl>
                        <SelectTrigger>
                          <SelectValue placeholder="Select term" />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        {LOAN_TERM_OPTIONS.map((months) => (
                          <SelectItem key={months} value={String(months)}>{months} months</SelectItem>
                        ))}
                        <SelectItem value="custom">Custom…</SelectItem>
                      </SelectContent>
                    </Select>
                    {customTerm && (
                      <FormControl>
                        <Input
                          type="number"
                          min="1"
                          step="1"
                          inputMode="numeric"
                          placeholder="Number of months"
                          value={field.value || ""}
                          onChange={(e) => field.onChange(e.target.value)}
                        />
                      </FormControl>
                    )}
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>
            <div className="grid grid-cols-2 gap-4">
              <FormField
                control={form.control}
                name="originalAmount"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Original Amount</FormLabel>
                    <FormControl>
                      <Input type="number" step="0.01" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="currentBalance"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Remaining Balance</FormLabel>
                    <FormControl>
                      <Input type="number" step="0.01" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>
            <div className="grid grid-cols-2 gap-4">
              <FormField
                control={form.control}
                name="interestRate"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Interest Rate (APR %)</FormLabel>
                    <FormControl>
                      <Input type="number" step="0.001" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="monthlyPayment"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Monthly Payment</FormLabel>
                    <FormControl>
                      <Input type="number" step="0.01" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>
            <div className="grid grid-cols-2 gap-4">
              <FormField
                control={form.control}
                name="startDate"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Loan Start Date</FormLabel>
                    <FormControl>
                      <Input type="date" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="nextPaymentDate"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Next Payment Due</FormLabel>
                    <FormControl>
                      <Input type="date" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>
            <FormField
              control={form.control}
              name="notes"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Notes</FormLabel>
                  <FormControl>
                    <Textarea placeholder="Optional notes about this loan" rows={2} {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            <DialogFooter className="pt-4">
              <Button type="button" variant="outline" onClick={() => setIsOpen(false)}>
                Cancel
              </Button>
              <Button type="submit" disabled={createLoan.isPending || updateLoan.isPending}>
                {createLoan.isPending || updateLoan.isPending ? "Saving..." : isEditing ? "Save Changes" : "Add Loan"}
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
