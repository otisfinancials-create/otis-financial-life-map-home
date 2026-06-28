import { Heart } from "lucide-react";
import { EmptyState } from "@/components/ui/empty-state";

export default function LifeEvents() {
  return (
    <div className="space-y-6 animate-in fade-in duration-500">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Life Events</h1>
        <p className="text-muted-foreground mt-1">Plan for major milestones and their financial impact.</p>
      </div>
      
      <EmptyState
        icon={<Heart className="h-8 w-8" />}
        title="Coming Soon"
        description="We're building a new way to model large life events—like buying a house, having a child, or taking a sabbatical—directly into your cash flow forecast."
        className="mt-8"
      />
    </div>
  );
}
