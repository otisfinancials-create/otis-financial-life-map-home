import { FlaskConical } from "lucide-react";
import { EmptyState } from "@/components/ui/empty-state";

export default function Simulator() {
  return (
    <div className="space-y-6 animate-in fade-in duration-500">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Simulator</h1>
        <p className="text-muted-foreground mt-1">Run what-if scenarios against your financial forecast.</p>
      </div>

      <EmptyState
        icon={<FlaskConical className="h-8 w-8" />}
        title="Coming Soon"
        description="We're building a scenario simulator so you can model changes—like a raise, a new loan, or adjusting your spending—and instantly see the impact on your cash flow and net worth."
        className="mt-8"
      />
    </div>
  );
}
