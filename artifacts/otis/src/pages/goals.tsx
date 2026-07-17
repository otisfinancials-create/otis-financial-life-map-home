import { Card } from "@/components/ui/card";

export default function Goals() {
  return (
    <div className="space-y-6 animate-in fade-in duration-500">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Goals</h1>
        <p className="text-muted-foreground mt-1">
          Coming soon — set and track your financial goals.
        </p>
      </div>

      <Card className="border-card-border bg-card rounded-xl p-12 flex flex-col items-center justify-center text-center">
        <span style={{ fontSize: "48px", lineHeight: 1 }} aria-hidden="true">
          🎯
        </span>
        <h2 className="mt-4 text-lg font-semibold text-foreground">
          Goals are coming soon
        </h2>
        <p className="mt-2 max-w-md text-muted-foreground">
          Track savings goals, debt payoff targets, and major purchase milestones.
        </p>
        <p className="mt-4 text-sm text-muted-foreground/70">
          This feature is in development.
        </p>
      </Card>
    </div>
  );
}
