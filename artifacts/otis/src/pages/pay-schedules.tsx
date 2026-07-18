import { useState } from "react";
import { format } from "date-fns";
import { Plus, Pencil, Trash2, MoreHorizontal, Banknote } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";

import {
  useListPaySchedules,
  useDeletePaySchedule,
  getListPaySchedulesQueryKey,
} from "@workspace/api-client-react";
import type { PaySchedule } from "@workspace/api-client-react";
import { useSyncForecast } from "@/hooks/use-sync-forecast";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";
import { PayScheduleDialog } from "@/components/pay-schedules/pay-schedule-dialog";

const FREQUENCY_LABELS: Record<string, string> = {
  weekly: "Weekly",
  biweekly: "Bi-weekly",
  monthly: "Monthly",
  quarterly: "Quarterly",
  annually: "Annually",
};

const FREQUENCY_MULTIPLIER: Record<string, number> = {
  weekly: 52 / 12,
  biweekly: 26 / 12,
  monthly: 1,
  quarterly: 1 / 3,
  annually: 1 / 12,
};

function monthlyEquivalent(amount: number, frequency: string) {
  return amount * (FREQUENCY_MULTIPLIER[frequency] ?? 1);
}

export default function PaySchedules() {
  const [scheduleToEdit, setScheduleToEdit] = useState<PaySchedule | undefined>(undefined);
  const [isEditOpen, setIsEditOpen] = useState(false);
  const [scheduleToDelete, setScheduleToDelete] = useState<PaySchedule | undefined>(undefined);

  const { toast } = useToast();
  const queryClient = useQueryClient();
  const { data: schedules, isLoading } = useListPaySchedules();
  const deleteSchedule = useDeletePaySchedule();
  const { sync: syncForecast } = useSyncForecast();

  const totalMonthlyIncome = schedules?.reduce(
    (sum, s) => sum + monthlyEquivalent(s.amount, s.frequency),
    0
  ) ?? 0;

  const handleDelete = () => {
    if (!scheduleToDelete) return;
    deleteSchedule.mutate({ id: scheduleToDelete.id }, {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getListPaySchedulesQueryKey() });
        toast({ title: "Pay schedule deleted", description: "Forecast is syncing in the background." });
        setScheduleToDelete(undefined);
        syncForecast();
      },
      onError: () => {
        toast({ title: "Failed to delete income source", variant: "destructive" });
        setScheduleToDelete(undefined);
      },
    });
  };

  return (
    <div className="space-y-6 animate-in fade-in duration-500">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Pay</h1>
          <p className="text-muted-foreground mt-1">
            Manage your income sources. Changes sync to the forecast automatically.
          </p>
        </div>
        <PayScheduleDialog
          trigger={
            <Button>
              <Plus className="mr-2 h-4 w-4" />
              Add Income Source
            </Button>
          }
        />
      </div>

      {/* Summary strip */}
      {!isLoading && schedules && schedules.length > 0 && (
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-4">
          <Card className="bg-card border-card-border rounded-xl py-4 px-6 flex flex-col justify-center">
            <span className="text-xs text-muted-foreground uppercase tracking-wider mb-1">
              Monthly Income (est.)
            </span>
            <span className="text-xl font-mono text-positive font-medium">
              {new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(totalMonthlyIncome)}
            </span>
          </Card>
          <Card className="bg-card border-card-border rounded-xl py-4 px-6 flex flex-col justify-center">
            <span className="text-xs text-muted-foreground uppercase tracking-wider mb-1">
              Annual Income (est.)
            </span>
            <span className="text-xl font-mono font-medium">
              {new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(totalMonthlyIncome * 12)}
            </span>
          </Card>
          <Card className="bg-card border-card-border rounded-xl py-4 px-6 flex flex-col justify-center">
            <span className="text-xs text-muted-foreground uppercase tracking-wider mb-1">
              Income Sources
            </span>
            <span className="text-xl font-mono font-medium">
              {schedules.length}
            </span>
          </Card>
        </div>
      )}

      {/* Table */}
      <Card className="border-card-border bg-card rounded-xl overflow-hidden">
        {isLoading ? (
          <div className="p-8 space-y-4">
            {[1, 2, 3].map((i) => (
              <Skeleton key={i} className="h-14 w-full" />
            ))}
          </div>
        ) : schedules && schedules.length > 0 ? (
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow className="border-border hover:bg-transparent">
                  <TableHead>Employer / Source</TableHead>
                  <TableHead>Net Amount</TableHead>
                  <TableHead>Frequency</TableHead>
                  <TableHead>Monthly Equiv.</TableHead>
                  <TableHead>Next Pay Date</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {schedules.map((s) => (
                  <TableRow key={s.id} className="border-border group">
                    <TableCell className="font-medium">{s.employerName}</TableCell>
                    <TableCell className="font-mono text-chart-2">
                      {new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(s.amount)}
                    </TableCell>
                    <TableCell>
                      <Badge variant="outline" className="font-normal border-border bg-background capitalize">
                        {FREQUENCY_LABELS[s.frequency] ?? s.frequency}
                      </Badge>
                    </TableCell>
                    <TableCell className="font-mono text-muted-foreground">
                      {new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(
                        monthlyEquivalent(s.amount, s.frequency)
                      )}
                      <span className="text-xs ml-1">/mo</span>
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {format(new Date(s.nextPayDate + "T00:00:00"), "MMM dd, yyyy")}
                    </TableCell>
                    <TableCell className="text-right">
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button
                            variant="ghost"
                            className="h-8 w-8 p-0 opacity-0 group-hover:opacity-100 transition-opacity"
                          >
                            <span className="sr-only">Open menu</span>
                            <MoreHorizontal className="h-4 w-4" />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          <DropdownMenuLabel>Actions</DropdownMenuLabel>
                          <DropdownMenuItem
                            onClick={() => {
                              setScheduleToEdit(s);
                              setIsEditOpen(true);
                            }}
                          >
                            <Pencil className="mr-2 h-4 w-4" />
                            Edit
                          </DropdownMenuItem>
                          <DropdownMenuSeparator />
                          <DropdownMenuItem
                            onClick={() => setScheduleToDelete(s)}
                            className="text-destructive focus:bg-destructive focus:text-destructive-foreground"
                          >
                            <Trash2 className="mr-2 h-4 w-4" />
                            Delete
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        ) : (
          <div className="flex flex-col items-center justify-center py-16 px-8 text-center gap-4">
            <div className="h-12 w-12 rounded-full bg-muted flex items-center justify-center">
              <Banknote className="h-6 w-6 text-muted-foreground" />
            </div>
            <div>
              <p className="font-medium">No income sources yet</p>
              <p className="text-sm text-muted-foreground mt-1">
                Add your salary, freelance income, or any recurring cash inflow to project your forecast accurately.
              </p>
            </div>
            <PayScheduleDialog
              trigger={
                <Button>
                  <Plus className="mr-2 h-4 w-4" />
                  Add your first income source
                </Button>
              }
            />
          </div>
        )}
      </Card>

      {/* Edit dialog */}
      <PayScheduleDialog
        schedule={scheduleToEdit}
        open={isEditOpen}
        onOpenChange={setIsEditOpen}
      />

      {/* Delete confirmation */}
      <AlertDialog
        open={!!scheduleToDelete}
        onOpenChange={(open) => !open && setScheduleToDelete(undefined)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this income source?</AlertDialogTitle>
            <AlertDialogDescription>
              This will permanently delete "{scheduleToDelete?.employerName}" and remove all projected
              paychecks from your forecast.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDelete}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {deleteSchedule.isPending ? "Deleting..." : "Delete"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
