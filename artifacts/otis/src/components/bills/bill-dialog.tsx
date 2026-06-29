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
  FormDescription,
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
import { Switch } from "@/components/ui/switch";
import { useToast } from "@/hooks/use-toast";

import {
  useCreateBill,
  useUpdateBill,
  getListBillsQueryKey,
  getGetUpcomingBillsQueryKey,
  getGetDashboardSummaryQueryKey,
} from "@workspace/api-client-react";
import type { Bill } from "@workspace/api-client-react";
import { useSyncForecast } from "@/hooks/use-sync-forecast";

const CATEGORIES = [
  "Housing",
  "Insurance",
  "Subscriptions",
  "Utilities",
  "Auto",
  "Food",
  "Medical",
  "Debt Payments",
  "Other",
];

const FREQUENCIES = [
  { value: "weekly", label: "Weekly" },
  { value: "biweekly", label: "Bi-weekly" },
  { value: "monthly", label: "Monthly" },
  { value: "quarterly", label: "Quarterly" },
  { value: "annually", label: "Annually" },
];

const PAYMENT_METHODS = [
  { value: "auto-pay", label: "Auto-pay" },
  { value: "manual", label: "Manual" },
  { value: "credit-card", label: "Credit Card" },
];

const billSchema = z.object({
  billName: z.string().min(2, { message: "Name must be at least 2 characters." }),
  category: z.string().min(1, { message: "Please select a category." }),
  amount: z.coerce.number().positive({ message: "Amount must be greater than 0." }),
  frequency: z.string().min(1, { message: "Please select a frequency." }),
  dueDay: z.coerce.number().min(1).max(31, { message: "Due day must be between 1 and 31." }),
  paymentMethod: z.string().optional(),
  creditCardName: z.string().optional(),
  companyUrl: z.string().optional(),
  startDate: z.string().optional(),
  endDate: z.string().optional(),
  isVariable: z.boolean().default(false),
  isActive: z.boolean().default(true),
  notes: z.string().optional(),
});

type BillFormValues = z.infer<typeof billSchema>;

function parsePaymentMethod(raw: string | null | undefined): { paymentMethod: string; creditCardName: string } {
  if (!raw) return { paymentMethod: "", creditCardName: "" };
  if (raw.startsWith("credit-card:")) {
    return { paymentMethod: "credit-card", creditCardName: raw.slice("credit-card:".length).trim() };
  }
  return { paymentMethod: raw, creditCardName: "" };
}

interface BillDialogProps {
  bill?: Bill;
  trigger?: React.ReactNode;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}

export function BillDialog({ bill, trigger, open, onOpenChange }: BillDialogProps) {
  const [internalOpen, setInternalOpen] = useState(false);
  const isControlled = open !== undefined && onOpenChange !== undefined;
  const isOpen = isControlled ? open : internalOpen;
  const setIsOpen = isControlled ? onOpenChange : setInternalOpen;

  const { toast } = useToast();
  const queryClient = useQueryClient();
  const createBill = useCreateBill();
  const updateBill = useUpdateBill();
  const { sync: syncForecast } = useSyncForecast();
  const isEditing = !!bill;

  const { paymentMethod: parsedMethod, creditCardName: parsedCard } = parsePaymentMethod(bill?.paymentMethod);

  const form = useForm<BillFormValues>({
    resolver: zodResolver(billSchema),
    defaultValues: {
      billName: bill?.billName || "",
      category: bill?.category || "",
      amount: bill?.amount || 0,
      frequency: bill?.frequency || "monthly",
      dueDay: bill?.dueDay || 1,
      paymentMethod: parsedMethod,
      creditCardName: parsedCard,
      companyUrl: bill?.companyUrl || "",
      startDate: bill?.startDate || "",
      endDate: bill?.endDate || "",
      isVariable: bill?.isVariable || false,
      isActive: bill?.isActive ?? true,
      notes: bill?.notes || "",
    },
  });

  useEffect(() => {
    if (isOpen) {
      const parsed = parsePaymentMethod(bill?.paymentMethod);
      form.reset({
        billName: bill?.billName || "",
        category: bill?.category || "",
        amount: bill?.amount || 0,
        frequency: bill?.frequency || "monthly",
        dueDay: bill?.dueDay || 1,
        paymentMethod: parsed.paymentMethod,
        creditCardName: parsed.creditCardName,
        companyUrl: bill?.companyUrl || "",
        startDate: bill?.startDate || "",
        endDate: bill?.endDate || "",
        isVariable: bill?.isVariable || false,
        isActive: bill?.isActive ?? true,
        notes: bill?.notes || "",
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, bill?.id]);

  const watchedPaymentMethod = form.watch("paymentMethod");
  const watchedIsVariable = form.watch("isVariable");

  function buildPaymentMethod(values: BillFormValues): string | undefined {
    if (!values.paymentMethod) return undefined;
    if (values.paymentMethod === "credit-card" && values.creditCardName?.trim()) {
      return `credit-card:${values.creditCardName.trim()}`;
    }
    return values.paymentMethod;
  }

  function onSubmit(data: BillFormValues) {
    const payload = {
      billName: data.billName,
      category: data.category,
      amount: data.amount,
      frequency: data.frequency,
      dueDay: data.dueDay,
      paymentMethod: buildPaymentMethod(data),
      companyUrl: data.companyUrl || undefined,
      startDate: data.startDate || undefined,
      endDate: data.endDate || undefined,
      isVariable: data.isVariable,
      isActive: data.isActive,
      notes: data.notes || undefined,
    };

    if (isEditing) {
      updateBill.mutate({ id: bill.id, data: payload }, {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getListBillsQueryKey() });
          queryClient.invalidateQueries({ queryKey: getGetUpcomingBillsQueryKey() });
          queryClient.invalidateQueries({ queryKey: getGetDashboardSummaryQueryKey() });
          toast({ title: "Bill updated", description: "Forecast is syncing in the background." });
          setIsOpen(false);
          if (!isControlled) form.reset();
          syncForecast();
        },
        onError: () => {
          toast({ title: "Failed to update bill", variant: "destructive" });
        },
      });
    } else {
      createBill.mutate({ data: payload }, {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getListBillsQueryKey() });
          queryClient.invalidateQueries({ queryKey: getGetUpcomingBillsQueryKey() });
          queryClient.invalidateQueries({ queryKey: getGetDashboardSummaryQueryKey() });
          toast({ title: "Bill added", description: "Forecast is syncing in the background." });
          setIsOpen(false);
          if (!isControlled) form.reset();
          syncForecast();
        },
        onError: () => {
          toast({ title: "Failed to create bill", variant: "destructive" });
        },
      });
    }
  }

  const handleOpenChange = (newOpen: boolean) => {
    if (!newOpen && !isControlled) form.reset();
    setIsOpen(newOpen);
  };

  return (
    <Dialog open={isOpen} onOpenChange={handleOpenChange}>
      {trigger && <DialogTrigger asChild>{trigger}</DialogTrigger>}
      <DialogContent className="sm:max-w-[560px] max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{isEditing ? "Edit Bill" : "Add Bill"}</DialogTitle>
          <DialogDescription>
            {isEditing
              ? "Make changes to your bill here."
              : "Add a new recurring bill to your forecast."}
          </DialogDescription>
        </DialogHeader>
        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
            <FormField
              control={form.control}
              name="billName"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Bill Name</FormLabel>
                  <FormControl>
                    <Input placeholder="e.g. Netflix, Rent, Car Insurance" {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            <div className="grid grid-cols-2 gap-4">
              <FormField
                control={form.control}
                name="category"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Category</FormLabel>
                    <Select onValueChange={field.onChange} value={field.value}>
                      <FormControl>
                        <SelectTrigger>
                          <SelectValue placeholder="Select category" />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        {CATEGORIES.map((cat) => (
                          <SelectItem key={cat} value={cat}>{cat}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="frequency"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Frequency</FormLabel>
                    <Select onValueChange={field.onChange} value={field.value}>
                      <FormControl>
                        <SelectTrigger>
                          <SelectValue placeholder="Select frequency" />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        {FREQUENCIES.map((f) => (
                          <SelectItem key={f.value} value={f.value}>{f.label}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>

            <div className="grid grid-cols-2 gap-4">
              <FormField
                control={form.control}
                name="amount"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Amount</FormLabel>
                    <FormControl>
                      <Input
                        type="number"
                        step="0.01"
                        disabled={watchedIsVariable}
                        className={watchedIsVariable ? "opacity-50" : ""}
                        {...field}
                      />
                    </FormControl>
                    {watchedIsVariable && (
                      <FormDescription className="text-[10px]">Estimated — marked as variable</FormDescription>
                    )}
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="dueDay"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Due Day</FormLabel>
                    <FormControl>
                      <Input type="number" min="1" max="31" {...field} />
                    </FormControl>
                    <FormDescription className="text-[10px]">Day of month (1–31)</FormDescription>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>

            <div className="grid grid-cols-2 gap-4">
              <FormField
                control={form.control}
                name="paymentMethod"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Payment Method</FormLabel>
                    <Select onValueChange={field.onChange} value={field.value ?? ""}>
                      <FormControl>
                        <SelectTrigger>
                          <SelectValue placeholder="Select method" />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        {PAYMENT_METHODS.map((m) => (
                          <SelectItem key={m.value} value={m.value}>{m.label}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <FormMessage />
                  </FormItem>
                )}
              />
              {watchedPaymentMethod === "credit-card" && (
                <FormField
                  control={form.control}
                  name="creditCardName"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Which Card?</FormLabel>
                      <FormControl>
                        <Input placeholder="e.g. Amex Blue Cash" {...field} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              )}
            </div>

            <FormField
              control={form.control}
              name="companyUrl"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Company Website <span className="text-muted-foreground font-normal">(optional)</span></FormLabel>
                  <FormControl>
                    <Input placeholder="https://example.com" {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            <div className="grid grid-cols-2 gap-4">
              <FormField
                control={form.control}
                name="startDate"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Start Date <span className="text-muted-foreground font-normal">(optional)</span></FormLabel>
                    <FormControl>
                      <Input type="date" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="endDate"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>End Date <span className="text-muted-foreground font-normal">(optional)</span></FormLabel>
                    <FormControl>
                      <Input type="date" {...field} />
                    </FormControl>
                    <FormDescription className="text-[10px]">e.g. loan payoff date</FormDescription>
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
                  <FormLabel>Notes <span className="text-muted-foreground font-normal">(optional)</span></FormLabel>
                  <FormControl>
                    <Textarea
                      placeholder="Any notes about this bill..."
                      className="resize-none"
                      rows={2}
                      {...field}
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            <div className="flex gap-4 pt-1">
              <FormField
                control={form.control}
                name="isVariable"
                render={({ field }) => (
                  <FormItem className="flex flex-row items-center justify-between rounded-lg border border-border p-3 flex-1">
                    <div className="space-y-0.5">
                      <FormLabel>Variable Amount</FormLabel>
                      <FormDescription className="text-xs">Amount fluctuates</FormDescription>
                    </div>
                    <FormControl>
                      <Switch checked={field.value} onCheckedChange={field.onChange} />
                    </FormControl>
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="isActive"
                render={({ field }) => (
                  <FormItem className="flex flex-row items-center justify-between rounded-lg border border-border p-3 flex-1">
                    <div className="space-y-0.5">
                      <FormLabel>Active</FormLabel>
                      <FormDescription className="text-xs">Include in forecast</FormDescription>
                    </div>
                    <FormControl>
                      <Switch checked={field.value} onCheckedChange={field.onChange} />
                    </FormControl>
                  </FormItem>
                )}
              />
            </div>

            <DialogFooter className="pt-2">
              <Button type="button" variant="outline" onClick={() => setIsOpen(false)}>
                Cancel
              </Button>
              <Button type="submit" disabled={createBill.isPending || updateBill.isPending}>
                {createBill.isPending || updateBill.isPending
                  ? "Saving..."
                  : isEditing
                  ? "Save Changes"
                  : "Add Bill"}
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
