import { useState } from "react";
import { ChevronDown, FolderOpen, Trash2 } from "lucide-react";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { useQueryClient } from "@tanstack/react-query";
import {
  useListScenarios,
  useDeleteScenario,
  getListScenariosQueryKey,
  type SavedScenario,
} from "@workspace/api-client-react";
import { scenarioMeta, fmtSigned } from "./scenario-meta";

interface SavedScenariosProps {
  onReopen: (scenario: SavedScenario) => void;
}

function impactLine(results: Record<string, unknown>): string {
  const parts: string[] = [];
  const cf = results["monthlyCashFlowImpact"];
  const nw = results["netWorthImpactOneYear"];
  const ret = results["retirementImpactLabel"];
  if (typeof cf === "number" && cf !== 0) parts.push(`${fmtSigned(cf)}/mo cash flow`);
  if (typeof nw === "number" && nw !== 0) parts.push(`${fmtSigned(nw)} net worth at 1 yr`);
  if (typeof ret === "string" && ret && parts.length < 2) parts.push(ret);
  return parts.join(" · ") || "No impact summary";
}

export function SavedScenarios({ onReopen }: SavedScenariosProps) {
  const [open, setOpen] = useState(true);
  const queryClient = useQueryClient();
  const { data: scenarios, isLoading } = useListScenarios();
  const deleteScenario = useDeleteScenario({
    mutation: {
      onSuccess: () => queryClient.invalidateQueries({ queryKey: getListScenariosQueryKey() }),
    },
  });

  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <div className="rounded-xl border border-border bg-card shadow-sm">
        <CollapsibleTrigger asChild>
          <button className="flex w-full items-center justify-between px-4 py-3 text-left">
            <div className="flex items-center gap-2">
              <span className="text-sm font-semibold">Saved Scenarios</span>
              {scenarios && <Badge variant="secondary">{scenarios.length}</Badge>}
            </div>
            <ChevronDown className={`h-4 w-4 text-muted-foreground transition-transform ${open ? "rotate-180" : ""}`} />
          </button>
        </CollapsibleTrigger>
        <CollapsibleContent>
          <div className="border-t border-border/60 divide-y divide-border/60">
            {isLoading ? (
              <div className="px-4 py-6 text-sm text-muted-foreground">Loading…</div>
            ) : !scenarios || scenarios.length === 0 ? (
              <div className="px-4 py-6 text-sm text-muted-foreground">
                No saved scenarios yet. Run a scenario above and save it to compare over time. 🐾
              </div>
            ) : (
              scenarios.map((s) => {
                const meta = scenarioMeta(s.scenarioType);
                return (
                  <div key={s.id} className="flex items-center gap-3 px-4 py-3">
                    <div className="text-xl">{meta.emoji}</div>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-medium truncate">{s.scenarioName}</span>
                        <Badge variant="outline" className="shrink-0">{meta.name}</Badge>
                      </div>
                      <div className="text-xs text-muted-foreground truncate mt-0.5">
                        Saved {new Date(s.createdAt).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}
                        {" · "}
                        {impactLine(s.resultsSummary as Record<string, unknown>)}
                      </div>
                    </div>
                    <Button variant="ghost" size="sm" onClick={() => onReopen(s)}>
                      <FolderOpen className="h-3.5 w-3.5 mr-1.5" />
                      Reopen
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="text-muted-foreground hover:text-destructive"
                      disabled={deleteScenario.isPending}
                      onClick={() => deleteScenario.mutate({ id: s.id })}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                );
              })
            )}
          </div>
        </CollapsibleContent>
      </div>
    </Collapsible>
  );
}
