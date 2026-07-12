import { useCallback, useEffect, useRef, useState } from "react";
import { useUser } from "@clerk/react";
import { useQueryClient } from "@tanstack/react-query";
import {
  useRunOtisScenario,
  useCreateScenario,
  getListScenariosQueryKey,
  type SavedScenario,
} from "@workspace/api-client-react";
import { OtisChat, type ChatDirective } from "@/components/otis/OtisChat";
import { ScenarioForm } from "@/components/otis/ScenarioForm";
import { ScenarioResults } from "@/components/otis/ScenarioResults";
import { SavedScenarios } from "@/components/otis/SavedScenarios";
import { SCENARIO_CARDS, scenarioMeta, fmtSigned, type ScenarioResultData } from "@/components/otis/scenario-meta";

export default function Otis() {
  const { user } = useUser();
  const queryClient = useQueryClient();
  const firstName = user?.firstName ?? "there";

  const [selectedType, setSelectedType] = useState<string | null>(null);
  const [formKey, setFormKey] = useState(0);
  const [initialInputs, setInitialInputs] = useState<Record<string, unknown> | undefined>(undefined);
  const [result, setResult] = useState<ScenarioResultData | null>(null);
  const [lastInputs, setLastInputs] = useState<Record<string, unknown>>({});
  const [directive, setDirective] = useState<ChatDirective | null>(null);
  const [runError, setRunError] = useState<string | null>(null);

  const chatRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  const runScenario = useRunOtisScenario();
  const createScenario = useCreateScenario({
    mutation: {
      onSuccess: () => queryClient.invalidateQueries({ queryKey: getListScenariosQueryKey() }),
    },
  });

  const selectType = useCallback((type: string) => {
    setSelectedType(type);
    setInitialInputs(undefined);
    setResult(null);
    setRunError(null);
    setFormKey((k) => k + 1);
    setTimeout(() => panelRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }), 50);
  }, []);

  const handleRun = useCallback(
    async (inputs: Record<string, unknown>) => {
      if (!selectedType || selectedType === "custom") return;
      setRunError(null);
      setLastInputs(inputs);
      try {
        const res = await runScenario.mutateAsync({
          data: { scenarioType: selectedType as never, inputs },
        });
        setResult(res as ScenarioResultData);
      } catch {
        setResult(null);
        setRunError("Otis couldn't run that scenario. Please check your inputs and try again.");
      }
    },
    [selectedType, runScenario],
  );

  const handleSave = useCallback(
    (name: string) => {
      if (!selectedType || !result) return;
      createScenario.mutate({
        data: {
          scenarioName: name,
          scenarioType: selectedType,
          inputParameters: lastInputs,
          resultsSummary: {
            monthlyCashFlowImpact: result.monthlyCashFlowImpact,
            netWorthImpactOneYear: result.netWorthImpactOneYear,
            retirementImpactLabel: result.retirementImpactLabel,
          },
        },
      });
    },
    [selectedType, result, lastInputs, createScenario],
  );

  const handleAskOtis = useCallback(() => {
    if (!selectedType || !result) return;
    const meta = scenarioMeta(selectedType);
    const text = `I just ran a "${meta.name}" scenario with these inputs: ${JSON.stringify(lastInputs)}. The results were: ${fmtSigned(result.monthlyCashFlowImpact)}/month cash flow, ${fmtSigned(result.netWorthImpactOneYear)} net worth at 1 year, and "${result.retirementImpactLabel}" for retirement. Can you help me think through whether this makes sense for me?`;
    setDirective({ text, send: false });
    chatRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, [selectedType, result, lastInputs]);

  const handleCustomSubmit = useCallback((text: string) => {
    setDirective({ text, send: true });
    chatRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, []);

  // Pre-fill the chat when arriving via "Ask Otis about this" links (?prompt=…).
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const prompt = params.get("prompt");
    if (prompt) {
      setDirective({ text: prompt, send: false });
      params.delete("prompt");
      const rest = params.toString();
      window.history.replaceState(null, "", window.location.pathname + (rest ? `?${rest}` : ""));
      setTimeout(() => chatRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }), 50);
    }
  }, []);

  const handleReopen = useCallback(
    (s: SavedScenario) => {
      const inputs = s.inputParameters as Record<string, unknown>;
      setSelectedType(s.scenarioType);
      setInitialInputs(inputs);
      setResult(null);
      setRunError(null);
      setFormKey((k) => k + 1);
      setLastInputs(inputs);
      setTimeout(() => panelRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }), 50);
      if (s.scenarioType !== "custom") {
        runScenario
          .mutateAsync({ data: { scenarioType: s.scenarioType as never, inputs } })
          .then((res) => setResult(res as ScenarioResultData))
          .catch(() => setRunError("Otis couldn't re-run that scenario. Please check the inputs and try again."));
      }
    },
    [runScenario],
  );

  return (
    <div className="space-y-8">
      <div ref={chatRef}>
        <h1 className="text-2xl font-semibold tracking-tight">
          Hi {firstName}, what's on your financial mind today?
        </h1>
        <p className="text-sm text-muted-foreground mt-1">
          Ask Otis anything, or explore a what-if scenario below.
        </p>
      </div>

      <OtisChat directive={directive} onDirectiveConsumed={() => setDirective(null)} />

      <div>
        <h2 className="text-base font-semibold mb-3">Or explore a scenario:</h2>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {SCENARIO_CARDS.map((card) => (
            <button
              key={card.type}
              onClick={() => selectType(card.type)}
              className={`group rounded-xl border bg-card p-4 text-left shadow-sm transition-all duration-200 hover:-translate-y-0.5 hover:shadow-md ${
                selectedType === card.type ? "border-teal-600 ring-1 ring-teal-600/30" : "border-border"
              }`}
            >
              <div className="text-3xl">{card.emoji}</div>
              <div className="mt-2 font-semibold text-sm">{card.name}</div>
              <div className="mt-0.5 text-xs text-muted-foreground">{card.description}</div>
              <div className="mt-2 text-xs font-medium text-teal-700 opacity-0 transition-opacity group-hover:opacity-100">
                Explore →
              </div>
            </button>
          ))}
        </div>
      </div>

      {selectedType && (
        <div ref={panelRef} className="rounded-xl border border-border bg-stone-50/60 p-5 shadow-sm animate-in fade-in slide-in-from-bottom-2 duration-300">
          <ScenarioForm
            key={formKey}
            type={selectedType}
            initialInputs={initialInputs}
            running={runScenario.isPending}
            onRun={handleRun}
            onCustomSubmit={handleCustomSubmit}
          />
          {runScenario.isPending && (
            <div className="mt-5 flex items-center gap-2 text-sm text-muted-foreground">
              <span className="animate-bounce">🐾</span> Otis is crunching your numbers…
            </div>
          )}
          {runError && <div className="mt-5 text-sm text-destructive">{runError}</div>}
          {result && selectedType !== "custom" && (
            <div className="mt-6">
              <ScenarioResults
                type={selectedType}
                result={result}
                saving={createScenario.isPending}
                onSave={handleSave}
                onAskOtis={handleAskOtis}
              />
            </div>
          )}
        </div>
      )}

      <SavedScenarios onReopen={handleReopen} />
    </div>
  );
}
