import { PiggyBank } from "lucide-react";
import { EmptyState } from "@/components/ui/empty-state";

export default function Retirement() {
  return (
    <div className="space-y-6 animate-in fade-in duration-500">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Retirement</h1>
        <p className="text-muted-foreground mt-1">Track your progress toward a comfortable retirement.</p>
      </div>

      <EmptyState
        icon={<PiggyBank className="h-8 w-8" />}
        title="Coming Soon"
        description="We're building retirement planning so you can project your savings, model contribution strategies, and see whether you're on track to reach your goals."
        className="mt-8"
      />
    </div>
  );
}
