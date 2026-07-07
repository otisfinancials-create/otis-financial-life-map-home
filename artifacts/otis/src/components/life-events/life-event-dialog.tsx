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
  useCreateLifeEvent,
  useUpdateLifeEvent,
  getListLifeEventsQueryKey,
  getGetDashboardSummaryQueryKey,
} from "@workspace/api-client-react";
import type { LifeEvent } from "@workspace/api-client-react";
import { useSyncForecast } from "@/hooks/use-sync-forecast";
import { LIFE_EVENT_CATEGORIES, TIMING_TYPES, RECUR_FREQUENCIES, PRIORITIES } from "./constants";

const lifeEventSchema = z
  .object({
    eventName: z.string().min(2, { message: "Name must be at least 2 characters." }),
    category: z.string().min(1, { message: "Please select a category." }),
    customCategory: z.string().optional(),
    amount: z.coerce.number().positive({ message: "Amount must be greater than 0." }),
    timingType: z.enum(["one_time", "spread", "recurring"]),
    eventDate: z.string().optional(),
    startDate: z.string().optional(),
    endDate: z.string().optional(),
    frequency: z.string().optional(),
    priority: z.string().min(1, { message: "Please select a priority." }),
    notes: z.string().optional(),
    isActive: z.boolean().default(true),
  })
  .superRefine((data, ctx) => {
    if (data.category === "custom" && !data.customCategory?.trim()) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Enter a custom category name.", path: ["customCategory"] });
    }
    if (data.timingType === "one_time" && !data.eventDate) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Pick the date this happens.", path: ["eventDate"] });
    }
    if (data.timingType === "spread") {
      if (!data.startDate) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Pick a start date.", path: ["startDate"] });
      if (!data.endDate) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Pick an end date.", path: ["endDate"] });
      if (data.startDate && data.endDate && data.endDate < data.startDate) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: "End date must be after start date.", path: ["endDate"] });
      }
    }
    if (data.timingType === "recurring") {
      if (!data.startDate) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Pick a start date.", path: ["startDate"] });
      if (!data.frequency) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Pick a frequency.", path: ["frequency"] });
    }
  });

type LifeEventFormValues = z.input<typeof lifeEventSchema>;

interface LifeEventDialogProps {
  event?: LifeEvent;
  trigger?: React.ReactNode;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}

function toDefaults(event?: LifeEvent): LifeEventFormValues {
  return {
    eventName: event?.eventName || "",
    category: event?.category || "",
    customCategory: event?.customCategory || "",
    amount: event?.amount ?? 0,
    timingType: (event?.timingType as LifeEventFormValues["timingType"]) || "one_time",
    eventDate: event?.eventDate || "",
    startDate: event?.startDate || "",
    endDate: event?.endDate || "",
    frequency: event?.frequency || "annually",
    priority: event?.priority || "planning_to",
    notes: event?.notes || "",
    isActive: event?.isActive ?? true,
  };
}

export function LifeEventDialog({ event, trigger, open, onOpenChange }: LifeEventDialogProps) {
  const [internalOpen, setInternalOpen] = useState(false);
  const isControlled = open !== undefined && onOpenChange !== undefined;
  const isOpen = isControlled ? open : internalOpen;
  const setIsOpen = isControlled ? onOpenChange : setInternalOpen;

  const { toast } = useToast();
  const queryClient = useQueryClient();
  const createEvent = useCreateLifeEvent();
  const updateEvent = useUpdateLifeEvent();
  const { sync: syncForecast } = useSyncForecast();
  const isEditing = !!event;

  const form = useForm<LifeEventFormValues>({
    resolver: zodResolver(lifeEventSchema),
    defaultValues: toDefaults(event),
  });

  useEffect(() => {
    if (isOpen) form.reset(toDefaults(event));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, event?.id]);

  const watchedTiming = form.watch("timingType");
  const watchedCategory = form.watch("category");

  function onSubmit(data: LifeEventFormValues) {
    const timing = data.timingType;
    const payload = {
      eventName: data.eventName,
      category: data.category,
      customCategory: data.category === "custom" ? data.customCategory?.trim() || undefined : undefined,
      amount: Number(data.amount),
      timingType: timing,
      eventDate: timing === "one_time" ? data.eventDate || undefined : undefined,
      startDate: timing === "one_time" ? undefined : data.startDate || undefined,
      endDate:
        timing === "spread"
          ? data.endDate || undefined
          : timing === "recurring"
            ? data.endDate || undefined
            : undefined,
      frequency: timing === "recurring" ? data.frequency || undefined : undefined,
      priority: data.priority,
      notes: data.notes?.trim() || undefined,
      isActive: data.isActive,
    };

    const onSuccess = (title: string) => {
      queryClient.invalidateQueries({ queryKey: getListLifeEventsQueryKey() });
      queryClient.invalidateQueries({ queryKey: getGetDashboardSummaryQueryKey() });
      toast({ title, description: "Forecast is syncing in the background." });
      setIsOpen(false);
      if (!isControlled) form.reset(toDefaults());
      syncForecast();
    };

    if (isEditing) {
      updateEvent.mutate(
        { id: event.id, data: payload },
        {
          onSuccess: () => onSuccess("Life event updated"),
          onError: () => toast({ title: "Failed to update life event", variant: "destructive" }),
        },
      );
    } else {
      createEvent.mutate(
        { data: payload },
        {
          onSuccess: () => onSuccess("Life event added"),
          onError: () => toast({ title: "Failed to create life event", variant: "destructive" }),
        },
      );
    }
  }

  const handleOpenChange = (newOpen: boolean) => {
    if (!newOpen && !isControlled) form.reset(toDefaults());
    setIsOpen(newOpen);
  };

  const pending = createEvent.isPending || updateEvent.isPending;

  return (
    <Dialog open={isOpen} onOpenChange={handleOpenChange}>
      {trigger && <DialogTrigger asChild>{trigger}</DialogTrigger>}
      <DialogContent className="sm:max-w-[560px] max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{isEditing ? "Edit Life Event" : "Add Life Event"}</DialogTitle>
          <DialogDescription>
            {isEditing
              ? "Update this milestone and we'll refresh your forecast."
              : "Plan for a big moment and see how it fits into your cash flow."}
          </DialogDescription>
        </DialogHeader>
        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
            <FormField
              control={form.control}
              name="eventName"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Event Name</FormLabel>
                  <FormControl>
                    <Input placeholder="e.g. European Vacation, Kitchen Remodel" {...field} />
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
                        {LIFE_EVENT_CATEGORIES.map((cat) => (
                          <SelectItem key={cat.value} value={cat.value}>{cat.label}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="amount"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Total Amount</FormLabel>
                    <FormControl>
                      <Input type="number" step="0.01" placeholder="0.00" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>

            {watchedCategory === "custom" && (
              <FormField
                control={form.control}
                name="customCategory"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Custom Category Name</FormLabel>
                    <FormControl>
                      <Input placeholder="e.g. Wedding, Sabbatical" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
            )}

            <FormField
              control={form.control}
              name="timingType"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Timing</FormLabel>
                  <div className="grid grid-cols-3 gap-2">
                    {TIMING_TYPES.map((t) => {
                      const active = field.value === t.value;
                      return (
                        <button
                          type="button"
                          key={t.value}
                          onClick={() => field.onChange(t.value)}
                          className={`rounded-lg border p-3 text-left transition-colors ${
                            active
                              ? "border-primary bg-primary/5 ring-1 ring-primary"
                              : "border-border hover:bg-accent"
                          }`}
                        >
                          <span className="block text-sm font-medium">{t.label}</span>
                          <span className="block text-[11px] text-muted-foreground mt-0.5">{t.hint}</span>
                        </button>
                      );
                    })}
                  </div>
                  <FormMessage />
                </FormItem>
              )}
            />

            {watchedTiming === "one_time" && (
              <FormField
                control={form.control}
                name="eventDate"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Event Date</FormLabel>
                    <FormControl>
                      <Input type="date" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
            )}

            {watchedTiming === "spread" && (
              <div className="grid grid-cols-2 gap-4">
                <FormField
                  control={form.control}
                  name="startDate"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Start Date</FormLabel>
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
                      <FormLabel>End Date</FormLabel>
                      <FormControl>
                        <Input type="date" {...field} />
                      </FormControl>
                      <FormDescription className="text-[10px]">Cost is split evenly across these months</FormDescription>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </div>
            )}

            {watchedTiming === "recurring" && (
              <div className="grid grid-cols-3 gap-4">
                <FormField
                  control={form.control}
                  name="startDate"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Start Date</FormLabel>
                      <FormControl>
                        <Input type="date" {...field} />
                      </FormControl>
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
                      <Select onValueChange={field.onChange} value={field.value ?? ""}>
                        <FormControl>
                          <SelectTrigger>
                            <SelectValue placeholder="Select" />
                          </SelectTrigger>
                        </FormControl>
                        <SelectContent>
                          {RECUR_FREQUENCIES.map((f) => (
                            <SelectItem key={f.value} value={f.value}>{f.label}</SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
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
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </div>
            )}

            <FormField
              control={form.control}
              name="priority"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Priority</FormLabel>
                  <Select onValueChange={field.onChange} value={field.value}>
                    <FormControl>
                      <SelectTrigger>
                        <SelectValue placeholder="Select priority" />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      {PRIORITIES.map((p) => (
                        <SelectItem key={p.value} value={p.value}>{p.label}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="notes"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Notes <span className="text-muted-foreground font-normal">(optional)</span></FormLabel>
                  <FormControl>
                    <Textarea placeholder="Any details about this event..." className="resize-none" rows={2} {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="isActive"
              render={({ field }) => (
                <FormItem className="flex flex-row items-center justify-between rounded-lg border border-border p-3">
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

            <DialogFooter className="pt-2">
              <Button type="button" variant="outline" onClick={() => setIsOpen(false)}>
                Cancel
              </Button>
              <Button type="submit" disabled={pending}>
                {pending ? "Saving..." : isEditing ? "Save Changes" : "Add Life Event"}
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
