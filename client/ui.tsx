import type { PluginTheme } from "@getpaseo/plugin";
import { Text, View } from "react-native";
import type { Summary, TurnRecord } from "../shared/ledger.ts";

export function fmtTokens(value: number | null): string {
  if (value === null) return "–";
  if (value < 1000) return String(value);
  if (value < 1_000_000) return `${(value / 1000).toFixed(1)}k`;
  return `${(value / 1_000_000).toFixed(2)}M`;
}

export function fmtCost(value: number | null): string | null {
  if (value === null) return null;
  return value >= 0.01 ? `$${value.toFixed(2)}` : `$${value.toFixed(4)}`;
}

/** Compact totals always disclose omitted costs or incomplete token coverage. */
export function costOrTokens(summary: Summary): string {
  const cost = fmtCost(summary.effectiveCostUsd);
  const unknown = summary.pricingWarningTurns > 0 ? ' · price config'
    : summary.unpricedTurns > 0 ? ` · ${summary.unpricedTurns} unknown` : '';
  if (cost) return `${summary.estimatedTurns > 0 ? '≈' : ''}${cost}${summary.partialCostTurns > 0 ? ' partial' : ''}${unknown}`;
  if (summary.input === null && summary.cached === null && summary.output === null && summary.cacheWrite == null) {
    return summary.unmeasuredTurns > 0 ? `turn usage unavailable${unknown}` : `no usage reported${unknown}`;
  }
  const total = (summary.input ?? 0) + (summary.cached ?? 0) + (summary.cacheWrite ?? 0) + (summary.output ?? 0);
  return `${fmtTokens(total)} tok${summary.incompleteTurns > 0 ? ' partial' : ''}${unknown}`;
}

/** Compact cost for per-component cells; "–" when unknown. */
export function fmtCostSmall(value: number | null): string {
  if (value === null) return "–";
  if (value === 0) return "$0";
  if (value >= 0.01) return `$${value.toFixed(2)}`;
  return `$${value.toPrecision(1)}`;
}

/** Reported runtime cost minus known component estimates, not missing-token attribution. */
export function fmtResidual(value: number | null): string {
  if (value === null || Math.abs(value) < 0.005) return " ";
  return `${value > 0 ? "+" : "−"}${fmtCostSmall(Math.abs(value))}`;
}

export function fmtPct(ratio: number | null): string | null {
  if (ratio === null) return null;
  const pct = ratio * 100;
  if (pct > 0 && pct < 1) return "<1%";
  return `${Math.round(pct)}%`;
}

export function fmtDuration(ms: number | null): string {
  if (ms === null) return "–";
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${String(seconds % 60).padStart(2, "0")}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

export function fmtTime(iso: string): string {
  const date = new Date(iso);
  const today = new Date();
  const time = `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
  if (date.toDateString() === today.toDateString()) return time;
  return `${date.getMonth() + 1}/${date.getDate()} ${time}`;
}

export function statusColor(status: TurnRecord["status"], theme: PluginTheme): string {
  if (status === "completed") return theme.colors.statusSuccess;
  if (status === "failed") return theme.colors.statusDanger;
  return theme.colors.statusWarning;
}

export function tokensLine(input: number | null, cached: number | null, output: number | null, cacheWrite?: number | null): string | null {
  if (input === null && cached === null && output === null && cacheWrite == null) return null;
  return `in ${fmtTokens(input)} · cache ${fmtTokens(cached)} · write ${fmtTokens(cacheWrite ?? null)} · out ${fmtTokens(output)}`;
}

/** Column widths for the TURNS table; shared by the header and data rows. */
export function turnColumns(dense: boolean) {
  return {
    in: { minWidth: dense ? 40 : 56 },
    cache: { minWidth: dense ? 58 : 78 },
    out: { minWidth: dense ? 42 : 56 },
    cost: { minWidth: dense ? 44 : 54 },
    gap: dense ? 6 : 8,
  };
}

export function TurnTableHeader({ theme, dense }: { theme: PluginTheme; dense: boolean }) {
  const cols = turnColumns(dense);
  const cell = {
    color: theme.colors.foregroundMuted,
    fontSize: 10,
    fontWeight: "600" as const,
    letterSpacing: 0.4,
    textAlign: "right" as const,
  };
  return (
    <View style={{ flexDirection: "row", alignItems: "baseline", gap: cols.gap, paddingVertical: 4 }}>
      {/* Doubles as the section title; the column holds seq + time + duration. */}
      <Text style={{ ...cell, textAlign: "left", flex: 1 }}>TURNS</Text>
      <Text style={{ ...cell, ...cols.in }}>IN</Text>
      <Text style={{ ...cell, ...cols.cache }}>CACHE</Text>
      <Text style={{ ...cell, ...cols.out }}>OUT</Text>
      <Text style={{ ...cell, ...cols.cost }}>COST</Text>
    </View>
  );
}

export function Stat({ label, value, theme, dense }: { label: string; value: string; theme: PluginTheme; dense?: boolean }) {
  return (
    <View style={{ minWidth: dense ? 44 : 56 }}>
      <Text style={{ color: theme.colors.foreground, fontSize: 15, fontWeight: "600", fontVariant: ["tabular-nums"] }}>
        {value}
      </Text>
      <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11 }}>{label}</Text>
    </View>
  );
}

export function SummaryRow({ summary, theme, dense }: { summary: Summary; theme: PluginTheme; dense?: boolean }) {
  const cost = fmtCost(summary.effectiveCostUsd);
  const costValue = cost ? `${summary.estimatedTurns > 0 ? '≈' : ''}${cost}` : 'unknown';
  const costLabel = ['known cost', summary.partialCostTurns > 0 ? `${summary.partialCostTurns} partial` : null,
    summary.unpricedTurns > 0 ? `${summary.unpricedTurns} unknown` : null].filter(Boolean).join(' · ');
  return (
    <View style={{ gap: 8 }}>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: dense ? 10 : 16 }}>
        <Stat label="turns" value={String(summary.turns)} theme={theme} dense={dense} />
        <Stat label="known input" value={fmtTokens(summary.input)} theme={theme} dense={dense} />
        <Stat label="cache read" value={fmtTokens(summary.cached)} theme={theme} dense={dense} />
        <Stat label="cache write" value={fmtTokens(summary.cacheWrite ?? null)} theme={theme} dense={dense} />
        <Stat label="known output" value={fmtTokens(summary.output)} theme={theme} dense={dense} />
        <Stat label={costLabel} value={costValue} theme={theme} dense={dense} />
      </View>
      {summary.incompleteTurns > 0 ? <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11 }}>
        {summary.incompleteTurns} turn(s) with incomplete usage{summary.unmeasuredTurns > 0 ? ` · ${summary.unmeasuredTurns} snapshot(s) excluded from totals` : ''}.
      </Text> : null}
      {summary.pricingWarningTurns > 0 ? <Text style={{ color: theme.colors.statusWarning, fontSize: 11 }}>
        {summary.pricingWarningTurns} turn(s) need pricing.json review. Reference-price fallback is blocked for ambiguous or unsafe old matches.
      </Text> : null}
    </View>
  );
}

export function UsageCoverageNote({ theme }: { theme: PluginTheme }) {
  return (
    <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11 }}>
      Known usage only. “–” means unknown, not zero. Runtime-reported and reference costs are not verified bills; descendant usage may be missing.
    </Text>
  );
}
