import { useState } from "react";
import { format } from "date-fns";
import { Plus, MoreHorizontal, CheckCircle2, Circle, Search, Pencil, Trash2 } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";

import { useListBills, useDeleteBill, getListBillsQueryKey, getGetUpcomingBillsQueryKey, getGetDashboardSummaryQueryKey } from "@workspace/api-client-react";
import type { Bill } from "@workspace/api-client-react";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { FormatCurrency } from "@/components/ui/format-currency";
import { Input } from "@/components/ui/input";
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
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";
import { EmptyState } from "@/components/ui/empty-state";
import { BillDialog } from "@/components/bills/bill-dialog";
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

export default function Bills() {
  const [searchTerm, setSearchTerm] = useState("");
  const [billToEdit, setBillToEdit] = useState<Bill | undefined>(undefined);
  const [isEditDialogOpen, setIsEditDialogOpen] = useState(false);
  const [billToDelete, setBillToDelete] = useState<Bill | undefined>(undefined);
  
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const { data: bills, isLoading } = useListBills();
  const deleteBill = useDeleteBill();

  const filteredBills = bills?.filter((bill) => 
    bill.billName.toLowerCase().includes(searchTerm.toLowerCase()) ||
    bill.category.toLowerCase().includes(searchTerm.toLowerCase())
  ) || [];

  const handleEdit = (bill: Bill) => {
    setBillToEdit(bill);
    setIsEditDialogOpen(true);
  };

  const handleDelete = () => {
    if (!billToDelete) return;
    
    deleteBill.mutate({ id: billToDelete.id }, {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getListBillsQueryKey() });
        queryClient.invalidateQueries({ queryKey: getGetUpcomingBillsQueryKey() });
        queryClient.invalidateQueries({ queryKey: getGetDashboardSummaryQueryKey() });
        toast({ title: "Bill deleted successfully" });
        setBillToDelete(undefined);
      },
      onError: () => {
        toast({ title: "Failed to delete bill", variant: "destructive" });
        setBillToDelete(undefined);
      }
    });
  };

  return (
    <div className="space-y-6 animate-in fade-in duration-500">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Bills & Subscriptions</h1>
          <p className="text-muted-foreground mt-1">Manage your recurring expenses and forecast commitments.</p>
        </div>
        <div className="flex items-center gap-2">
          <div className="relative">
            <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
            <Input
              type="search"
              placeholder="Search bills..."
              className="pl-9 w-full sm:w-[250px] bg-card border-border"
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
            />
          </div>
          <BillDialog 
            trigger={
              <Button>
                <Plus className="mr-2 h-4 w-4" />
                Add Bill
              </Button>
            } 
          />
        </div>
      </div>

      <Card className="border-border bg-card overflow-hidden">
        {isLoading ? (
          <div className="p-8 space-y-4">
            {[1, 2, 3, 4, 5].map(i => <Skeleton key={i} className="h-12 w-full" />)}
          </div>
        ) : filteredBills.length > 0 ? (
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow className="border-border hover:bg-transparent">
                  <TableHead className="w-[30px]"></TableHead>
                  <TableHead>Bill Name</TableHead>
                  <TableHead>Category</TableHead>
                  <TableHead>Amount</TableHead>
                  <TableHead>Frequency</TableHead>
                  <TableHead>Due Date</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filteredBills.map((bill) => (
                  <TableRow key={bill.id} className="border-border group">
                    <TableCell>
                      {bill.isActive ? (
                        <CheckCircle2 className="h-4 w-4 text-primary" />
                      ) : (
                        <Circle className="h-4 w-4 text-muted-foreground" />
                      )}
                    </TableCell>
                    <TableCell className="font-medium">
                      <div className="flex items-center gap-2">
                        {bill.billName}
                        {bill.isVariable && (
                          <Badge variant="secondary" className="text-[10px] px-1.5 py-0 h-4 bg-muted text-muted-foreground">Var</Badge>
                        )}
                      </div>
                    </TableCell>
                    <TableCell>
                      <Badge variant="outline" className="font-normal border-border bg-background">
                        {bill.category}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      <FormatCurrency amount={bill.amount} />
                    </TableCell>
                    <TableCell className="capitalize text-muted-foreground">
                      {bill.frequency}
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      Day {bill.dueDay}
                    </TableCell>
                    <TableCell className="text-right">
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button variant="ghost" className="h-8 w-8 p-0 opacity-0 group-hover:opacity-100 transition-opacity">
                            <span className="sr-only">Open menu</span>
                            <MoreHorizontal className="h-4 w-4" />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          <DropdownMenuLabel>Actions</DropdownMenuLabel>
                          <DropdownMenuItem onClick={() => handleEdit(bill)}>
                            <Pencil className="mr-2 h-4 w-4" />
                            Edit
                          </DropdownMenuItem>
                          <DropdownMenuSeparator />
                          <DropdownMenuItem 
                            onClick={() => setBillToDelete(bill)}
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
          <EmptyState
            icon={<Receipt className="h-8 w-8" />}
            title={searchTerm ? "No bills found" : "No bills yet"}
            description={searchTerm ? `No bills matching "${searchTerm}"` : "Add your first bill to start forecasting your cash flow."}
            className="border-0 bg-transparent rounded-none"
            action={!searchTerm && <BillDialog trigger={<Button>Add your first bill</Button>} />}
          />
        )}
      </Card>

      <BillDialog 
        bill={billToEdit} 
        open={isEditDialogOpen} 
        onOpenChange={setIsEditDialogOpen} 
      />

      <AlertDialog open={!!billToDelete} onOpenChange={(open) => !open && setBillToDelete(undefined)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Are you absolutely sure?</AlertDialogTitle>
            <AlertDialogDescription>
              This will permanently delete the bill "{billToDelete?.billName}" and remove it from all future forecasts.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction 
              onClick={handleDelete}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {deleteBill.isPending ? "Deleting..." : "Delete"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

// Temporary import for the empty state icon
import { Receipt } from "lucide-react";
