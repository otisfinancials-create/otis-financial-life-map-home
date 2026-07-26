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
  useListAccounts,
  useSuggestBillMerchants,
  useGetBillMatchingCharges,
  getListBillsQueryKey,
  getGetUpcomingBillsQueryKey,
  getGetDashboardSummaryQueryKey,
  getGetBillMatchingChargesQueryKey,
} from "@workspace/api-client-react";
import type { Bill, BillInputPaymentMethod } from "@workspace/api-client-react";
import { useSyncForecast } from "@/hooks/use-sync-forecast";
import { MerchantPicker } from "@/components/bills/merchant-picker";

const CATEGORIES = [
  "Housing",
  "Insurance",
  "Subscriptions",
  "Utilities",
  "Auto",
  "Cell Phone",
  "Food",
  "Medical",
  "Pets",
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
  { value: "credit-card", label: "Credit Card" },
  { value: "debit-card", label: "Debit Card" },
  { value: "bank-transfer", label: "Bank Transfer" },
  { value: "check", label: "Check" },
  { value: "cash", label: "Cash" },
];

/** Methods that are paid from a specific account (paying account required). */
const ACCOUNT_METHODS = new Set(["credit-card", "debit-card", "bank-transfer"]);
const CARD_ACCOUNT_TYPES = new Set(["credit_card"]);
const DEPOSITORY_ACCOUNT_TYPES = new Set(["checking", "savings"]);

const MAX_TEXT = 100;

const billSchema = z
  .object({
    billName: z
      .string()
      .min(2, { message: "Name must be at least 2 characters." })
      .max(MAX_TEXT, { message: `Name must be ${MAX_TEXT} characters or fewer.` }),
    category: z.string().min(1, { message: "Please select a category." }),
    amount: z.coerce
      .number({ message: "Amount must be a number." })
      .positive({ message: "Amount must be greater than 0." })
      .refine((v) => /^\d{1,9}(\.\d{1,2})?$/.test(String(v)), {
        message: "Amount is limited to 9 digits before the decimal point and 2 decimal places.",
      }),
    frequency: z.string().min(1, { message: "Please select a frequency." }),
    amountType: z.enum(["positive", "negative"]).default("negative"),
    dueDay: z.preprocess(
      (v) => (v === "" || v === null || v === undefined ? undefined : Number(v)),
      z.number().int().min(1).max(31).optional(),
    ),
    paymentMethod: z.string().min(1, { message: "Please select a payment method." }),
    paymentAccountId: z.string().optional(),
    isAutopay: z.boolean().default(false),
    companyUrl: z
      .string()
      .max(MAX_TEXT, { message: `URL must be ${MAX_TEXT} characters or fewer.` })
      .optional(),
    startDate: z.string().optional(),
    endDate: z.string().optional(),
    isVariable: z.boolean().default(false),
    isActive: z.boolean().default(true),
    notes: z
      .string()
      .max(MAX_TEXT, { message: `Notes must be ${MAX_TEXT} characters or fewer.` })
      .optional(),
    matchMerchant: z
      .string()
      .max(MAX_TEXT, { message: `Merchant must be ${MAX_TEXT} characters or fewer.` })
      .optional(),
  })
  .superRefine((data, ctx) => {
    // Card/bank methods must say which account pays the bill.
    if (ACCOUNT_METHODS.has(data.paymentMethod) && !data.paymentAccountId) {
      ctx.addIssue({ path: ["paymentAccountId"], code: "custom", message: "Please select the paying account." });
    }

    // Due-date requirement depends on frequency.
    if (data.frequency === "monthly") {
      if (data.dueDay == null) {
        ctx.addIssue({ path: ["dueDay"], code: "custom", message: "Please enter a due day." });
      }
    } else if (!data.startDate) {
      ctx.addIssue({
        path: ["startDate"],
        code: "custom",
        message: "First bill date is required.",
      });
    }

    // Company URL: must contain a dot and no spaces (blank is allowed).
    const url = data.companyUrl?.trim();
    if (url && (!url.includes(".") || /\s/.test(url))) {
      ctx.addIssue({
        path: ["companyUrl"],
        code: "custom",
        message: "Please enter a valid URL (e.g. netflix.com)",
      });
    }

    // End date must be on or after the start date.
    if (data.startDate && data.endDate && data.endDate < data.startDate) {
      ctx.addIssue({
        path: ["endDate"],
        code: "custom",
        message: "End date must be after start date.",
      });
    }
  });

type BillFormValues = z.infer<typeof billSchema>;

// Normalize a company URL: if it has no protocol, prefix "https://www."
// (skipping the "www." part when the user already typed it).
export function normalizeCompanyUrl(raw: string | undefined): string | undefined {
  const url = raw?.trim();
  if (!url) return undefined;
  if (/^https?:\/\//i.test(url)) return url;
  return `https://${url.toLowerCase().startsWith("www.") ? "" : "www."}${url}`;
}

// Legacy values (pre-migration free text like "credit-card:Visa *4821") are
// normalized to the constrained method set; unknown values map to "".
function parsePaymentMethod(raw: string | null | undefined): string {
  if (!raw) return "";
  if (raw.startsWith("credit-card")) return "credit-card";
  return PAYMENT_METHODS.some((m) => m.value === raw) ? raw : "";
}

// ── Occurrence preview helpers (mirror the server forecast engine) ───────────
const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

function todayIso(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function clampDayIso(year: number, month1: number, day: number): string {
  const daysInMonth = new Date(Date.UTC(year, month1, 0)).getUTCDate();
  const d = Math.min(Math.max(day, 1), daysInMonth);
  return `${year}-${String(month1).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

function addDaysIso(iso: string, n: number): string {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

function addMonthsIso(iso: string, n: number): string {
  const [y, m, d] = iso.split("-").map(Number);
  const total = (y * 12 + (m - 1)) + n;
  const ny = Math.floor(total / 12);
  const nm = (total % 12) + 1;
  return clampDayIso(ny, nm, d);
}

function formatMonthDay(iso: string): string {
  const [, m, d] = iso.split("-").map(Number);
  return `${MONTHS[m - 1]} ${d}`;
}

function previewOccurrences(frequency: string, dueDay?: number, startDate?: string): string[] {
  const today = todayIso();
  const out: string[] = [];
  const freq = frequency.toLowerCase();

  if (freq === "monthly") {
    if (dueDay == null || Number.isNaN(dueDay)) return [];
    let y = Number(today.slice(0, 4));
    let m = Number(today.slice(5, 7));
    for (let i = 0; i < 36 && out.length < 3; i++) {
      const occ = clampDayIso(y, m, dueDay);
      if (occ >= today) out.push(occ);
      m++;
      if (m > 12) { m = 1; y++; }
    }
    return out;
  }

  if (!startDate) return [];
  const step = (iso: string): string => {
    switch (freq) {
      case "weekly": return addDaysIso(iso, 7);
      case "biweekly": case "bi-weekly": return addDaysIso(iso, 14);
      case "quarterly": return addMonthsIso(iso, 3);
      case "annual": case "annually": case "yearly": return addMonthsIso(iso, 12);
      default: return addMonthsIso(iso, 1);
    }
  };
  let current = startDate;
  let guard = 0;
  while (current < today && guard++ < 500) current = step(current);
  guard = 0;
  while (out.length < 3 && guard++ < 500) {
    out.push(current);
    current = step(current);
  }
  return out;
}

interface BillFormProps {
  bill?: Bill;
  onSaved: () => void;
  onCancel: () => void;
}

// Shared bill form — used by the Add Bill dialog and the inline edit panel on
// the Bills page (split-panel layout).
export function BillForm({ bill, onSaved, onCancel }: BillFormProps) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const createBill = useCreateBill();
  const updateBill = useUpdateBill();
  const { sync: syncForecast } = useSyncForecast();
  const isEditing = !!bill;

  const { data: accounts } = useListAccounts();

  const form = useForm<BillFormValues>({
    resolver: zodResolver(billSchema),
    defaultValues: {
      billName: bill?.billName || "",
      category: bill?.category || "",
      amount: bill?.amount || 0,
      frequency: bill?.frequency || "monthly",
      amountType: (bill?.amountType as "positive" | "negative") || "negative",
      dueDay: bill?.dueDay,
      paymentMethod: parsePaymentMethod(bill?.paymentMethod),
      paymentAccountId: bill?.paymentAccountId != null ? String(bill.paymentAccountId) : "",
      isAutopay: bill?.isAutopay ?? false,
      companyUrl: bill?.companyUrl || "",
      startDate: bill?.startDate || "",
      endDate: bill?.endDate || "",
      isVariable: bill?.isVariable || false,
      isActive: bill?.isActive ?? true,
      notes: bill?.notes || "",
      matchMerchant: bill?.matchMerchant || "",
    },
  });

  useEffect(() => {
    form.reset({
      billName: bill?.billName || "",
      category: bill?.category || "",
      amount: bill?.amount || 0,
      frequency: bill?.frequency || "monthly",
      amountType: (bill?.amountType as "positive" | "negative") || "negative",
      dueDay: bill?.dueDay,
      paymentMethod: parsePaymentMethod(bill?.paymentMethod),
      paymentAccountId: bill?.paymentAccountId != null ? String(bill.paymentAccountId) : "",
      isAutopay: bill?.isAutopay ?? false,
      companyUrl: bill?.companyUrl || "",
      startDate: bill?.startDate || "",
      endDate: bill?.endDate || "",
      isVariable: bill?.isVariable || false,
      isActive: bill?.isActive ?? true,
      notes: bill?.notes || "",
      matchMerchant: bill?.matchMerchant || "",
    });
    // Suggestions belong to the previous bill's context — clear them so
    // stale chips can't be applied to a different bill.
    suggestMerchants.reset();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bill?.id]);

  const suggestMerchants = useSuggestBillMerchants();
  // "Currently matching" preview (edit only): charges presently on this
  // bill's line, so the user can see whether the link grabs the right ones.
  const { data: matchingCharges } = useGetBillMatchingCharges(bill?.id ?? 0, {
    query: { queryKey: getGetBillMatchingChargesQueryKey(bill?.id ?? 0), enabled: !!bill?.id },
  });

  const watchedPaymentMethod = form.watch("paymentMethod");
  const watchedIsVariable = form.watch("isVariable");
  const watchedFrequency = form.watch("frequency");
  const watchedDueDay = form.watch("dueDay");
  const watchedStartDate = form.watch("startDate");
  const watchedBillName = form.watch("billName") ?? "";
  const watchedNotes = form.watch("notes") ?? "";

  const isMonthly = watchedFrequency === "monthly";
  const isAnnual = watchedFrequency === "annually" || watchedFrequency === "annual";

  const preview = previewOccurrences(
    watchedFrequency,
    typeof watchedDueDay === "number" ? watchedDueDay : watchedDueDay ? Number(watchedDueDay) : undefined,
    watchedStartDate || undefined,
  );

  // Paying-account choices, narrowed by method to prevent contradictions
  // (cards pay credit-card bills, depository accounts pay bank transfers).
  // Falls back to all accounts when the narrowed list is empty.
  const accountChoices = (() => {
    const all = accounts ?? [];
    let filtered = all;
    if (watchedPaymentMethod === "credit-card") {
      filtered = all.filter((a) => CARD_ACCOUNT_TYPES.has(a.accountType));
    } else if (watchedPaymentMethod === "bank-transfer" || watchedPaymentMethod === "debit-card") {
      filtered = all.filter((a) => DEPOSITORY_ACCOUNT_TYPES.has(a.accountType));
    }
    return filtered.length > 0 ? filtered : all;
  })();

  function onSubmit(data: BillFormValues) {
    // dueDay is required by the API. For date-driven frequencies we derive it
    // from the first bill date's day-of-month.
    let dueDay = data.dueDay;
    if (data.frequency !== "monthly" && data.startDate) {
      dueDay = Number(data.startDate.slice(8, 10));
    }

    const payload = {
      billName: data.billName,
      category: data.category,
      amount: data.amount,
      frequency: data.frequency,
      amountType: data.amountType,
      dueDay: dueDay ?? 1,
      paymentMethod: (data.paymentMethod || null) as BillInputPaymentMethod | null,
      paymentAccountId:
        ACCOUNT_METHODS.has(data.paymentMethod) && data.paymentAccountId
          ? Number(data.paymentAccountId)
          : null,
      isAutopay: data.isAutopay,
      companyUrl: normalizeCompanyUrl(data.companyUrl),
      startDate: data.startDate || undefined,
      isVariable: data.isVariable,
      isActive: data.isActive,
      notes: data.notes || undefined,
      // null clears an existing link; the server normalizes the string.
      matchMerchant: data.matchMerchant?.trim() || null,
    };

    if (isEditing) {
      // On edit, send null so clearing the end date is persisted (undefined
      // would omit the field from the PATCH and the old value would stick).
      updateBill.mutate({ id: bill.id, data: { ...payload, endDate: data.endDate || null } }, {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getGetBillMatchingChargesQueryKey(bill.id) });
          queryClient.invalidateQueries({ queryKey: getListBillsQueryKey() });
          queryClient.invalidateQueries({ queryKey: getGetUpcomingBillsQueryKey() });
          queryClient.invalidateQueries({ queryKey: getGetDashboardSummaryQueryKey() });
          toast({ title: "Bill updated", description: "Forecast is syncing in the background." });
          onSaved();
          syncForecast();
        },
        onError: () => {
          toast({ title: "Failed to update bill", variant: "destructive" });
        },
      });
    } else {
      createBill.mutate({ data: { ...payload, endDate: data.endDate || undefined } }, {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getListBillsQueryKey() });
          queryClient.invalidateQueries({ queryKey: getGetUpcomingBillsQueryKey() });
          queryClient.invalidateQueries({ queryKey: getGetDashboardSummaryQueryKey() });
          toast({ title: "Bill added", description: "Forecast is syncing in the background." });
          onSaved();
          syncForecast();
        },
        onError: () => {
          toast({ title: "Failed to create bill", variant: "destructive" });
        },
      });
    }
  }

  const dueDateLabel = isMonthly
    ? "Due day of month"
    : isAnnual
    ? "Annual due date"
    : "First bill date";

  return (
    <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4" noValidate>
            <FormField
              control={form.control}
              name="billName"
              render={({ field }) => (
                <FormItem>
                  <div className="flex items-center justify-between">
                    <FormLabel>Bill Name</FormLabel>
                    <span className="text-[10px] text-muted-foreground tabular-nums">
                      {watchedBillName.length}/{MAX_TEXT}
                    </span>
                  </div>
                  <FormControl>
                    <Input
                      placeholder="e.g. Netflix, Rent, Car Insurance"
                      maxLength={MAX_TEXT}
                      {...field}
                    />
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
                    <FormLabel>{watchedIsVariable ? "Estimated Amount" : "Amount"}</FormLabel>
                    <FormControl>
                      <Input type="number" step="0.01" {...field} />
                    </FormControl>
                    {watchedIsVariable && (
                      <FormDescription className="text-[10px]">
                        Estimate — actual amount may vary
                      </FormDescription>
                    )}
                    <FormMessage />
                  </FormItem>
                )}
              />

              <FormField
                control={form.control}
                name="amountType"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Amount Type</FormLabel>
                    <Select onValueChange={field.onChange} value={field.value}>
                      <FormControl>
                        <SelectTrigger>
                          <SelectValue />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        <SelectItem value="negative">Negative (money out)</SelectItem>
                        <SelectItem value="positive">Positive (money in)</SelectItem>
                      </SelectContent>
                    </Select>
                    <FormDescription className="text-[10px]">
                      Positive amounts add to your cash flow (e.g. a recurring reimbursement)
                    </FormDescription>
                    <FormMessage />
                  </FormItem>
                )}
              />

              {isMonthly ? (
                <FormField
                  control={form.control}
                  name="dueDay"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>{dueDateLabel}</FormLabel>
                      <FormControl>
                        <Input
                          type="number"
                          placeholder="e.g. 15"
                          {...field}
                          value={field.value ?? ""}
                        />
                      </FormControl>
                      <FormDescription className="text-[10px]">Day of month (1–31)</FormDescription>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              ) : (
                <FormField
                  control={form.control}
                  name="startDate"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>{dueDateLabel}</FormLabel>
                      <FormControl>
                        <Input type="date" {...field} value={field.value ?? ""} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              )}
            </div>

            {preview.length > 0 && (
              <p className="text-[11px] text-muted-foreground -mt-1">
                This bill will next appear on{" "}
                <span className="text-foreground font-medium">{formatMonthDay(preview[0])}</span>
                {preview[1] && <>, then {formatMonthDay(preview[1])}</>}
                {preview[2] && <>, then {formatMonthDay(preview[2])}</>}
                …
              </p>
            )}

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
              {ACCOUNT_METHODS.has(watchedPaymentMethod) && (
                <FormField
                  control={form.control}
                  name="paymentAccountId"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Paying Account</FormLabel>
                      <Select onValueChange={field.onChange} value={field.value ?? ""}>
                        <FormControl>
                          <SelectTrigger>
                            <SelectValue placeholder="Select account" />
                          </SelectTrigger>
                        </FormControl>
                        <SelectContent>
                          {accountChoices.map((a) => (
                            <SelectItem key={a.id} value={String(a.id)}>
                              {a.accountName}
                              {a.institutionName ? ` — ${a.institutionName}` : ""}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
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
                    <Input placeholder="e.g. netflix.com" maxLength={MAX_TEXT} {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="matchMerchant"
              render={({ field }) => (
                <FormItem>
                  <div className="flex items-center justify-between">
                    <FormLabel>Matches charges from <span className="text-muted-foreground font-normal">(optional)</span></FormLabel>
                    {form.watch("paymentAccountId") && (
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        className="h-6 px-2 text-xs"
                        disabled={suggestMerchants.isPending}
                        onClick={() => {
                          const v = form.getValues();
                          suggestMerchants.mutate({
                            data: {
                              billName: v.billName || "",
                              amount: Number(v.amount) || 0,
                              frequency: v.frequency || "monthly",
                              paymentAccountId: Number(v.paymentAccountId),
                              companyUrl: normalizeCompanyUrl(v.companyUrl) ?? null,
                            },
                          });
                        }}
                        data-testid="button-suggest-merchant"
                      >
                        {suggestMerchants.isPending ? "Looking…" : "Suggest"}
                      </Button>
                    )}
                  </div>
                  <FormControl>
                    <MerchantPicker
                      accountId={form.watch("paymentAccountId") ? Number(form.watch("paymentAccountId")) : null}
                      value={field.value ?? ""}
                      onChange={(m) => form.setValue("matchMerchant", m, { shouldDirty: true })}
                      data-testid="input-match-merchant"
                    />
                  </FormControl>
                  <FormDescription className="text-[10px]">
                    Otis uses this to recognize this bill's charges from your accounts. Usually the
                    merchant name as it appears on your statement (e.g. 'AT&T MOBILITY').
                  </FormDescription>
                  {suggestMerchants.isSuccess && suggestMerchants.data.length === 0 && (
                    <p className="text-[11px] text-muted-foreground">
                      No likely merchant found in recent charges — type it manually.
                    </p>
                  )}
                  {(suggestMerchants.data?.length ?? 0) > 0 && (
                    <div className="flex flex-wrap gap-1.5 pt-1">
                      {suggestMerchants.data!.map((c) => (
                        <button
                          key={c.merchant}
                          type="button"
                          onClick={() => form.setValue("matchMerchant", c.merchant, { shouldDirty: true })}
                          className="rounded-full border border-border px-2.5 py-1 text-xs hover:border-primary hover:bg-primary/5"
                          title={c.samples.map((s) => `$${s.amount.toFixed(2)} on ${s.date}`).join(", ")}
                          data-testid={`chip-suggestion-${c.merchant.replace(/\s+/g, "-")}`}
                        >
                          {c.displayName}{" "}
                          <span className="text-muted-foreground">
                            ({c.samples[0] ? `$${c.samples[0].amount.toFixed(2)}, ` : ""}{c.occurrences}×)
                          </span>
                        </button>
                      ))}
                    </div>
                  )}
                  {isEditing && (matchingCharges?.length ?? 0) > 0 && (
                    <p className="text-[11px] text-muted-foreground" data-testid="text-currently-matching">
                      Currently matching:{" "}
                      {matchingCharges!.slice(0, 3).map((c, i) => (
                        <span key={`${c.date}-${i}`} className="text-foreground">
                          {i > 0 && ", "}
                          {c.description} ${c.amount.toFixed(2)} on {Number(c.date.slice(5, 7))}/{Number(c.date.slice(8, 10))}
                        </span>
                      ))}
                    </p>
                  )}
                  {isEditing && bill?.matchMerchant && (matchingCharges?.length ?? 0) === 0 && (
                    <p className="text-[11px] text-muted-foreground">No charges matched yet this cycle.</p>
                  )}
                  <FormMessage />
                </FormItem>
              )}
            />

            <div className="grid grid-cols-2 gap-4">
              {isMonthly && (
                <FormField
                  control={form.control}
                  name="startDate"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Start Date <span className="text-muted-foreground font-normal">(optional)</span></FormLabel>
                      <FormControl>
                        <Input type="date" {...field} value={field.value ?? ""} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              )}
              <FormField
                control={form.control}
                name="endDate"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>End Date <span className="text-muted-foreground font-normal">(optional)</span></FormLabel>
                    <FormControl>
                      <Input type="date" {...field} value={field.value ?? ""} />
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
                  <div className="flex items-center justify-between">
                    <FormLabel>Notes <span className="text-muted-foreground font-normal">(optional)</span></FormLabel>
                    <span className="text-[10px] text-muted-foreground tabular-nums">
                      {watchedNotes.length}/{MAX_TEXT}
                    </span>
                  </div>
                  <FormControl>
                    <Textarea
                      placeholder="Any notes about this bill..."
                      className="resize-none"
                      rows={2}
                      maxLength={MAX_TEXT}
                      {...field}
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="isAutopay"
              render={({ field }) => (
                <FormItem className="flex flex-row items-center justify-between rounded-lg border border-border p-3">
                  <div className="space-y-0.5">
                    <FormLabel>Auto Pay</FormLabel>
                    <FormDescription className="text-xs">This bill is paid automatically</FormDescription>
                  </div>
                  <FormControl>
                    <Switch checked={field.value} onCheckedChange={field.onChange} />
                  </FormControl>
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

            <div className="flex justify-end gap-2 pt-2">
              <Button type="button" variant="outline" onClick={onCancel}>
                Cancel
              </Button>
              <Button type="submit" disabled={createBill.isPending || updateBill.isPending}>
                {createBill.isPending || updateBill.isPending
                  ? "Saving..."
                  : isEditing
                  ? "Save Changes"
                  : "Add Bill"}
              </Button>
            </div>
          </form>
    </Form>
  );
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
  const isEditing = !!bill;

  return (
    <Dialog open={isOpen} onOpenChange={setIsOpen}>
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
        {isOpen && (
          <BillForm
            bill={bill}
            onSaved={() => setIsOpen(false)}
            onCancel={() => setIsOpen(false)}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}
