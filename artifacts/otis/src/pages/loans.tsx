import { CreditCard } from "lucide-react";
import { EmptyState } from "@/components/ui/empty-state";

export default function Loans() {
  return (
    <div className="space-y-6 animate-in fade-in duration-500">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Loans & Liabilities</h1>
        <p className="text-muted-foreground mt-1">Manage debt payoff strategies and interest impact.</p>
      </div>
      
      <EmptyState
        icon={<CreditCard className="h-8 w-8" />}
        title="Amortization Engine in Development"
        description="Soon you will be able to visualize payoff schedules, compare extra payment impacts, and see exactly when you'll be debt-free."
        className="mt-8"
      />
    </div>
  );
}
