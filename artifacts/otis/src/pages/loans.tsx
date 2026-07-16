import { useState } from "react";
import {
  Plus,
  CreditCard,
  Home,
  Car,
  User,
  GraduationCap,
  Banknote,
  MoreHorizontal,
  Pencil,
  Trash2,
  ChevronDown,
} from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { useLocation } from "wouter";

import {
  useListLoans,
  useGetLoansSummary,
  useDeleteLoan,
  getListLoansQueryKey,
  getGetLoansSummaryQueryKey,
  getGetDashboardSummaryQueryKey,
} from "@workspace/api-client-react";
import type { Loan } from "@workspace/api-client-react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { FormatCurrency } from "@/components/ui/format-currency";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { useToast } from "@/hooks/use-toast";
import { EmptyState } from "@/components/ui/empty-state";
import { LoanDialog } from "@/components/loans/loan-dialog";
import { AmortizationSchedule } from "@/components/loans/amortization-schedule";
import { computeAmortization } from "@/components/loans/amortization";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
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
import { cn } from "@/lib/utils";

const TYPE_LABELS: Record<string, string> = {
  mortgage: "Mortgage",
  auto: "Auto",
  personal: "Personal",
  student: "Student",
  other: "Other",
};

const getTypeLabel = (type: string) =>
  TYPE_LABELS[type] ?? type.replace(/\b\w/g, (c) => c.toUpperCase());

const getLoanIcon = (type: string) => {
  switch (type) {
    case "mortgage": return <Home className="h-4 w-4" />;
    case "auto": return <Car className="h-4 w-4" />;
    case "personal": return <User className="h-4 w-4" />;
    case "student": return <GraduationCap className="h-4 w-4" />;
    default: return <Banknote className="h-4 w-4" />;
  }
};

const formatDate = (iso: string | null) =>
  iso ? new Date(`${iso}T00:00:00`).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }) : "—";

const formatMonthYear = (iso: string | null) =>
  iso ? new Date(`${iso}T00:00:00`).toLocaleDateString("en-US", { month: "short", year: "numeric" }) : "—";

export default function Loans() {
  const [loanToEdit, setLoanToEdit] = useState<Loan | undefined>(undefined);
  const [isEditDialogOpen, setIsEditDialogOpen] = useState(false);
  const [loanToDelete, setLoanToDelete] = useState<Loan | undefined>(undefined);
  const [expandedId, setExpandedId] = useState<number | null>(null);

  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [, navigate] = useLocation();
  const { data: loans, isLoading: isLoadingLoans } = useListLoans();
  const { data: summary, isLoading: isLoadingSummary } = useGetLoansSummary();
  const deleteLoan = useDeleteLoan();

  const handleEdit = (loan: Loan) => {
    setLoanToEdit(loan);
    setIsEditDialogOpen(true);
  };

  const handleDelete = () => {
    if (!loanToDelete) return;
    deleteLoan.mutate({ id: loanToDelete.id }, {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getListLoansQueryKey() });
        queryClient.invalidateQueries({ queryKey: getGetLoansSummaryQueryKey() });
        queryClient.invalidateQueries({ queryKey: getGetDashboardSummaryQueryKey() });
        toast({ title: "Loan deleted successfully" });
        setLoanToDelete(undefined);
      },
      onError: () => {
        toast({ title: "Failed to delete loan", variant: "destructive" });
        setLoanToDelete(undefined);
      },
    });
  };

  return (
    <div className="space-y-6 animate-in fade-in duration-500">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Loans</h1>
          <p className="text-muted-foreground mt-1">Track every debt obligation with full amortization detail.</p>
        </div>
        <div className="flex flex-col sm:flex-row gap-2">
          <Button
            variant="outline"
            onClick={() =>
              navigate(
                `/otis?prompt=${encodeURIComponent("I'd like to model a potential new loan. Can you help me understand the financial impact?")}`,
              )
            }
          >
            Model a Loan 🤖
          </Button>
          <LoanDialog
            trigger={
              <Button>
                <Plus className="mr-2 h-4 w-4" />
                Add Loan
              </Button>
            }
          />
        </div>
      </div>

      {/* Summary */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Card className="bg-card border-border rounded-xl">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Total Debt Balance</CardTitle>
          </CardHeader>
          <CardContent>
            {isLoadingSummary ? (
              <Skeleton className="h-8 w-[120px]" />
            ) : (
              <div className="text-2xl font-bold tracking-tight text-red-600">
                <FormatCurrency amount={summary?.totalDebt || 0} />
              </div>
            )}
          </CardContent>
        </Card>
        <Card className="bg-card border-border rounded-xl">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Total Monthly Payments</CardTitle>
          </CardHeader>
          <CardContent>
            {isLoadingSummary ? (
              <Skeleton className="h-8 w-[120px]" />
            ) : (
              <div className="text-2xl font-bold tracking-tight text-foreground">
                <FormatCurrency amount={summary?.totalMonthlyPayments || 0} />
              </div>
            )}
          </CardContent>
        </Card>
        <Card className="bg-card border-border rounded-xl">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Earliest Payoff</CardTitle>
          </CardHeader>
          <CardContent>
            {isLoadingSummary ? (
              <Skeleton className="h-8 w-[120px]" />
            ) : (
              <div className="text-2xl font-bold tracking-tight text-foreground">
                {formatMonthYear(summary?.earliestPayoffDate ?? null)}
              </div>
            )}
          </CardContent>
        </Card>
        <Card className="bg-card border-border rounded-xl">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Latest Payoff</CardTitle>
          </CardHeader>
          <CardContent>
            {isLoadingSummary ? (
              <Skeleton className="h-8 w-[120px]" />
            ) : (
              <div className="text-2xl font-bold tracking-tight text-foreground">
                {formatMonthYear(summary?.latestPayoffDate ?? null)}
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Loan list */}
      {isLoadingLoans ? (
        <div className="space-y-4">
          <Skeleton className="h-[220px] w-full" />
          <Skeleton className="h-[220px] w-full" />
        </div>
      ) : loans && loans.length > 0 ? (
        <div className="space-y-4">
          {loans.map((loan) => {
            const paidOff = loan.originalAmount - loan.currentBalance;
            const pctPaid = loan.originalAmount > 0
              ? Math.min(100, Math.max(0, (paidOff / loan.originalAmount) * 100))
              : 0;
            const isExpanded = expandedId === loan.id;
            const payoffDate = computeAmortization(loan).payoffDate;
            return (
              <Card key={loan.id} className="bg-card border-border overflow-hidden rounded-xl">
                <CardContent className="p-5">
                  <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
                    <div className="flex items-start gap-3 min-w-0">
                      <div className="h-10 w-10 rounded-md bg-secondary border border-border flex items-center justify-center shrink-0 text-primary">
                        {getLoanIcon(loan.loanType)}
                      </div>
                      <div className="min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          <h3 className="text-base font-semibold tracking-tight truncate">{loan.loanName}</h3>
                          <Badge variant="outline" className="text-[10px] px-1.5 py-0 h-4 leading-none shrink-0">
                            {getTypeLabel(loan.loanType)}
                          </Badge>
                        </div>
                        <p className="text-sm text-muted-foreground mt-0.5">{loan.lenderName}</p>
                      </div>
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button variant="ghost" size="icon" className="h-8 w-8">
                            <MoreHorizontal className="h-4 w-4" />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          <DropdownMenuItem onClick={() => handleEdit(loan)}>
                            <Pencil className="mr-2 h-4 w-4" />
                            Edit
                          </DropdownMenuItem>
                          <DropdownMenuSeparator />
                          <DropdownMenuItem
                            onClick={() => setLoanToDelete(loan)}
                            className="text-destructive focus:bg-destructive focus:text-destructive-foreground"
                          >
                            <Trash2 className="mr-2 h-4 w-4" />
                            Delete
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </div>
                  </div>

                  {/* Progress bar */}
                  <div className="mt-5">
                    <div className="flex items-center justify-between text-sm">
                      <span className="font-mono font-medium text-foreground">
                        <FormatCurrency amount={loan.currentBalance} /> remaining
                      </span>
                      <span className="text-xs text-muted-foreground">
                        of <FormatCurrency amount={loan.originalAmount} /> original
                      </span>
                    </div>
                    <Progress value={pctPaid} className="mt-2 h-2 [&>div]:bg-primary" />
                    <div className="mt-1 text-xs text-muted-foreground">
                      {pctPaid.toFixed(1)}% paid off
                    </div>
                  </div>

                  {/* Stat row */}
                  <div className="mt-5 grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-5">
                    <div>
                      <div className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Interest Rate</div>
                      <div className="mt-0.5 text-sm font-semibold font-mono">{loan.interestRate.toFixed(2)}%</div>
                    </div>
                    <div>
                      <div className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Monthly Payment</div>
                      <div className="mt-0.5 text-sm font-semibold font-mono"><FormatCurrency amount={loan.monthlyPayment} /></div>
                    </div>
                    <div>
                      <div className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Next Payment</div>
                      <div className="mt-0.5 text-sm font-semibold">{formatDate(loan.nextPaymentDate)}</div>
                    </div>
                    <div>
                      <div className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Payoff Date</div>
                      <div className="mt-0.5 text-sm font-semibold">{formatMonthYear(payoffDate)}</div>
                    </div>
                    <div>
                      <div className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Term</div>
                      <div className="mt-0.5 text-sm font-semibold">{loan.termMonths} months</div>
                    </div>
                  </div>

                  <div className="mt-5 border-t border-border pt-4">
                    <button
                      type="button"
                      onClick={() => setExpandedId(isExpanded ? null : loan.id)}
                      className="flex items-center gap-1.5 text-sm font-medium text-primary hover:text-primary/80 transition-colors"
                    >
                      <ChevronDown className={cn("h-4 w-4 transition-transform", isExpanded && "rotate-180")} />
                      {isExpanded ? "Hide Amortization" : "View Amortization"}
                    </button>
                  </div>
                </CardContent>

                {isExpanded && (
                  <div className="border-t border-border">
                    <AmortizationSchedule loan={loan} />
                  </div>
                )}
              </Card>
            );
          })}
        </div>
      ) : (
        <EmptyState
          icon={<CreditCard className="h-8 w-8" />}
          title="No loans tracked yet"
          description="Add your mortgage, auto loans, and other debts to see payoff schedules and simulate extra payments."
          action={<LoanDialog trigger={<Button>Add Loan</Button>} />}
        />
      )}

      <LoanDialog
        loan={loanToEdit}
        open={isEditDialogOpen}
        onOpenChange={setIsEditDialogOpen}
      />

      <AlertDialog open={!!loanToDelete} onOpenChange={(open) => !open && setLoanToDelete(undefined)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete Loan?</AlertDialogTitle>
            <AlertDialogDescription>
              This will permanently remove "{loanToDelete?.loanName}" and its amortization schedule.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDelete}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {deleteLoan.isPending ? "Deleting..." : "Delete"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
