import { useState } from "react";

export interface Citation {
  cite: string;
  label: string;
  kind: "sourced" | "calculated" | "estimated";
  origin?: "live" | "manual";
  lastSyncedAt: string | null;
}

/**
 * Freshness is computed AT RENDER TIME from the ISO timestamp — never baked
 * into the response — so a cached reply replayed three days later resolves
 * "synced 3 days ago", not a fossilized "3 hours ago".
 */
export function relativeFreshness(iso: string, now = Date.now()): string {
  const ms = now - new Date(iso).getTime();
  if (!isFinite(ms) || ms < 0) return "synced just now";
  const min = Math.floor(ms / 60_000);
  if (min < 1) return "synced just now";
  if (min < 60) return `synced ${min} minute${min === 1 ? "" : "s"} ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `synced ${hr} hour${hr === 1 ? "" : "s"} ago`;
  const day = Math.floor(hr / 24);
  if (day < 30) return `synced ${day} day${day === 1 ? "" : "s"} ago`;
  const mo = Math.floor(day / 30);
  return `synced ${mo} month${mo === 1 ? "" : "s"} ago`;
}

const KIND_META: Record<Citation["kind"], { word: string; text: string; chip: string }> = {
  // Chip sits on the Otis-blue bubble; a white pill keeps the kind color
  // readable at WCAG AA (all three text colors ≥4.5:1 on white).
  sourced: { word: "Sourced", text: "text-[#047857]", chip: "bg-white text-[#047857] border border-transparent" },
  calculated: { word: "Calculated", text: "text-[#1d4ed8]", chip: "bg-white/90 text-[#1d4ed8] border border-transparent" },
  estimated: { word: "Estimate", text: "text-[#b45309]", chip: "bg-white/90 text-[#b45309] border border-dashed border-[#b45309]" },
};

function kindDescription(c: Citation): string {
  if (c.kind === "sourced") {
    return c.origin === "live" ? "Live balance from a connected account" : "Entered by you";
  }
  if (c.kind === "calculated") return "Calculated from your data";
  return "Our best estimate — actual may differ";
}

export function CitationChip({ citation }: { citation: Citation }) {
  const [open, setOpen] = useState(false);
  const meta = KIND_META[citation.kind];

  return (
    <span
      className="relative inline-block align-super"
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
    >
      <button
        type="button"
        aria-label={`Citation: ${citation.label}`}
        onClick={() => setOpen((v) => !v)}
        className={`inline-flex items-center rounded-full px-1.5 text-[10px] font-semibold leading-4 shadow-sm cursor-pointer select-none ${meta.chip}`}
      >
        {citation.kind === "estimated" ? "~" : "•"}
        <span className="ml-0.5">{citation.kind === "estimated" ? "est" : "src"}</span>
      </button>
      {open && (
        <span className="absolute bottom-full left-1/2 z-20 mb-1.5 w-max max-w-[240px] -translate-x-1/2 rounded-lg border border-slate-200 bg-white px-3 py-2 text-left shadow-lg">
          <span className="block text-xs font-semibold text-[#0f172a]">{citation.label}</span>
          <span className={`block text-[11px] font-medium ${meta.text}`}>
            {meta.word} · {kindDescription(citation)}
          </span>
          {citation.lastSyncedAt && (
            <span className="block text-[11px] text-[#475569]">{relativeFreshness(citation.lastSyncedAt)}</span>
          )}
        </span>
      )}
    </span>
  );
}
