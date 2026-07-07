import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  useUpdateAccount,
  getListAccountsQueryKey,
  getGetRetirementSummaryQueryKey,
  getGetRetirementProjectionQueryKey,
} from "@workspace/api-client-react";
import type { Account } from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { RETIREMENT_SUBTYPE_LABELS } from "./projection";

interface EditContributionDialogProps {
  account: Account | null;
  onClose: () => void;
}

export function EditContributionDialog({ account, onClose }: EditContributionDialogProps) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [contribution, setContribution] = useState("");
  const [subtype, setSubtype] = useState<string>("other");

  useEffect(() => {
    if (account) {
      setContribution(String(account.monthlyContribution ?? 0));
      setSubtype(account.retirementSubtype ?? "other");
    }
  }, [account]);

  const updateAccount = useUpdateAccount({
    mutation: {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getListAccountsQueryKey() });
        queryClient.invalidateQueries({ queryKey: getGetRetirementSummaryQueryKey() });
        queryClient.invalidateQueries({ queryKey: getGetRetirementProjectionQueryKey() });
        toast({ title: "Contribution updated", description: "Your projection reflects the change." });
        onClose();
      },
      onError: () => toast({ title: "Could not update the contribution", variant: "destructive" }),
    },
  });

  const handleSave = () => {
    if (!account) return;
    const amount = parseFloat(contribution);
    if (isNaN(amount) || amount < 0) {
      toast({ title: "Please enter a valid contribution amount", variant: "destructive" });
      return;
    }
    updateAccount.mutate({
      id: account.id,
      data: {
        monthlyContribution: amount,
        retirementSubtype: subtype as "401k" | "ira" | "roth_ira" | "pension" | "other",
      },
    });
  };

  return (
    <Dialog open={account !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Edit contribution</DialogTitle>
          <DialogDescription>
            {account ? `How much goes into ${account.accountName} each month?` : ""}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4 py-2">
          <div className="space-y-2">
            <Label htmlFor="monthly-contribution">Monthly contribution ($)</Label>
            <Input
              id="monthly-contribution"
              type="number"
              min="0"
              step="50"
              value={contribution}
              onChange={(e) => setContribution(e.target.value)}
            />
          </div>
          <div className="space-y-2">
            <Label>Account type</Label>
            <Select value={subtype} onValueChange={setSubtype}>
              <SelectTrigger>
                <SelectValue placeholder="Select a type" />
              </SelectTrigger>
              <SelectContent>
                {Object.entries(RETIREMENT_SUBTYPE_LABELS).map(([value, label]) => (
                  <SelectItem key={value} value={value}>
                    {label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={handleSave} disabled={updateAccount.isPending}>
            {updateAccount.isPending ? "Saving..." : "Save"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
