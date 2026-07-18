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
  useCreatePaySchedule,
  useUpdatePaySchedule,
  getListPaySchedulesQueryKey,
} from "@workspace/api-client-react";
import type { PaySchedule } from "@workspace/api-client-react";
import { useSyncForecast } from "@/hooks/use-sync-forecast";

const FREQUENCIES = [
  { value: "weekly", label: "Weekly" },
  { value: "biweekly", label: "Bi-weekly" },
  { value: "semi-monthly", label: "Semi-monthly (1st & 15th)" },
  { value: "monthly", label: "Monthly" },
];

const MAX_NAME = 100;
const MAX_NOTES = 100;

const schema = z.object({
  employerName: z
    .string()
    .min(2, { message: "Employer name must be at least 2 characters." })
    .max(MAX_NAME, { message: `Name must be ${MAX_NAME} characters or fewer.` }),
  amount: z.coerce
    .number({ message: "Amount must be a number." })
    .positive({ message: "Amount must be greater than 0." })
    .refine((v) => /^\d{1,9}(\.\d{1,2})?$/.test(String(v)), {
      message: "Amount is limited to 9 digits before the decimal point and 2 decimal places.",
    }),
  frequency: z.string().min(1, { message: "Please select a frequency." }),
  nextPayDate: z.string().min(1, { message: "Please enter the next pay date." }),
  notes: z.string().max(MAX_NOTES, { message: `Notes must be ${MAX_NOTES} characters or fewer.` }).optional(),
});

type FormValues = z.infer<typeof schema>;

interface PayScheduleDialogProps {
  schedule?: PaySchedule;
  trigger?: React.ReactNode;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}

export function PayScheduleDialog({ schedule, trigger, open, onOpenChange }: PayScheduleDialogProps) {
  const [internalOpen, setInternalOpen] = useState(false);
  const isControlled = open !== undefined && onOpenChange !== undefined;
  const isOpen = isControlled ? open : internalOpen;
  const setIsOpen = isControlled ? onOpenChange : setInternalOpen;

  const { toast } = useToast();
  const queryClient = useQueryClient();
  const createSchedule = useCreatePaySchedule();
  const updateSchedule = useUpdatePaySchedule();
  const { sync: syncForecast } = useSyncForecast();
  const isEditing = !!schedule;

  const form = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: {
      employerName: schedule?.employerName ?? "",
      amount: schedule?.amount ?? 0,
      frequency: schedule?.frequency ?? "biweekly",
      nextPayDate: schedule?.nextPayDate ?? "",
      notes: schedule?.notes ?? "",
    },
  });

  useEffect(() => {
    if (isOpen) {
      form.reset({
        employerName: schedule?.employerName ?? "",
        amount: schedule?.amount ?? 0,
        frequency: schedule?.frequency ?? "biweekly",
        nextPayDate: schedule?.nextPayDate ?? "",
        notes: schedule?.notes ?? "",
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, schedule?.id]);

  function onSubmit(data: FormValues) {
    const payload = {
      ...data,
      notes: data.notes || undefined,
    };

    if (isEditing) {
      updateSchedule.mutate({ id: schedule.id, data: payload }, {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getListPaySchedulesQueryKey() });
          toast({ title: "Pay schedule updated", description: "Forecast is syncing in the background." });
          setIsOpen(false);
          if (!isControlled) form.reset();
          syncForecast();
        },
        onError: () => {
          toast({ title: "Failed to update pay schedule", variant: "destructive" });
        },
      });
    } else {
      createSchedule.mutate({ data: payload }, {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getListPaySchedulesQueryKey() });
          toast({ title: "Pay schedule added", description: "Forecast is syncing in the background." });
          setIsOpen(false);
          if (!isControlled) form.reset();
          syncForecast();
        },
        onError: () => {
          toast({ title: "Failed to create pay schedule", variant: "destructive" });
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
      <DialogContent className="sm:max-w-[440px]">
        <DialogHeader>
          <DialogTitle>{isEditing ? "Edit Pay Schedule" : "Add Income Source"}</DialogTitle>
          <DialogDescription>
            {isEditing
              ? "Update this income source. The forecast will resync automatically."
              : "Add an income source to project your cash inflows."}
          </DialogDescription>
        </DialogHeader>
        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
            <FormField
              control={form.control}
              name="employerName"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Employer / Income Source</FormLabel>
                  <FormControl>
                    <Input placeholder="e.g. Acme Corp, Freelance Clients" maxLength={MAX_NAME} {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            <div className="grid grid-cols-2 gap-4">
              <FormField
                control={form.control}
                name="amount"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Net Pay Amount</FormLabel>
                    <FormControl>
                      <Input type="number" step="0.01" placeholder="0.00" {...field} />
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
                    <FormLabel>Pay Frequency</FormLabel>
                    <Select onValueChange={field.onChange} value={field.value}>
                      <FormControl>
                        <SelectTrigger>
                          <SelectValue placeholder="Select" />
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

            <FormField
              control={form.control}
              name="nextPayDate"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Next Pay Date</FormLabel>
                  <FormControl>
                    <Input type="date" {...field} />
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
                  <FormLabel>Notes <span className="text-muted-foreground font-normal">(optional)</span></FormLabel>
                  <FormControl>
                    <Textarea
                      placeholder="e.g. base salary only, bonuses separate..."
                      className="resize-none"
                      rows={2}
                      maxLength={MAX_NOTES}
                      {...field}
                    />
                  </FormControl>
                  <div className="flex justify-end">
                    <span className={`text-[10px] font-mono ${(field.value?.length ?? 0) > MAX_NOTES ? "text-destructive" : "text-muted-foreground"}`}>
                      {field.value?.length ?? 0}/{MAX_NOTES}
                    </span>
                  </div>
                  <FormMessage />
                </FormItem>
              )}
            />

            <DialogFooter className="pt-2">
              <Button type="button" variant="outline" onClick={() => setIsOpen(false)}>
                Cancel
              </Button>
              <Button type="submit" disabled={createSchedule.isPending || updateSchedule.isPending}>
                {createSchedule.isPending || updateSchedule.isPending
                  ? "Saving..."
                  : isEditing
                  ? "Save Changes"
                  : "Add Schedule"}
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
