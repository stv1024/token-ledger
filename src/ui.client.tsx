import type { PluginTheme } from "@getpaseo/plugin";
import { Text, View } from "react-native";
import type { Summary, TurnRecord } from "./ledger.shared";

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

/** Compact cost for per-component cells; "–" when unknown. */
export function fmtCostSmall(value: number | null): string {
  if (value === null) return "–";
  if (value === 0) return "$0";
  if (value >= 0.01) return `$${value.toFixed(2)}`;
  return `$${value.toPrecision(1)}`;
}

/**
 * Signed cost residual (reported total minus list-price component estimate)
 * for the COST cell; blank when unknown or negligible. On Claude turns a
 * positive residual is mostly cache writes, which upstream never reports as
 * tokens.
 */
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

export function tokensLine(input: number | null, cached: number | null, output: number | null): string | null {
  if (input === null && cached === null && output === null) return null;
  return `in ${fmtTokens(input)} · cache ${fmtTokens(cached)} · out ${fmtTokens(output)}`;
}

/** Column widths for the TURNS table; shared by the header and data rows. */
export function turnColumns(compact: boolean) {
  return {
    in: { minWidth: compact ? 48 : 56 },
    cache: { minWidth: compact ? 66 : 78 },
    out: { minWidth: compact ? 48 : 56 },
    cost: { minWidth: compact ? 46 : 54 },
  };
}

export function TurnTableHeader({ theme, compact }: { theme: PluginTheme; compact: boolean }) {
  const cols = turnColumns(compact);
  const cell = {
    color: theme.colors.foregroundMuted,
    fontSize: 10,
    fontWeight: "600" as const,
    letterSpacing: 0.4,
    textAlign: "right" as const,
  };
  return (
    <View style={{ flexDirection: "row", alignItems: "baseline", gap: 8, paddingVertical: 4 }}>
      {/* Doubles as the section title; the column holds seq + time + duration. */}
      <Text style={{ ...cell, textAlign: "left", flex: 1 }}>TURNS</Text>
      <Text style={{ ...cell, ...cols.in }}>IN</Text>
      <Text style={{ ...cell, ...cols.cache }}>CACHE</Text>
      <Text style={{ ...cell, ...cols.out }}>OUT</Text>
      <Text style={{ ...cell, ...cols.cost }}>COST</Text>
    </View>
  );
}

export function Stat({ label, value, theme }: { label: string; value: string; theme: PluginTheme }) {
  return (
    <View style={{ minWidth: 56 }}>
      <Text style={{ color: theme.colors.foreground, fontSize: 15, fontWeight: "600", fontVariant: ["tabular-nums"] }}>
        {value}
      </Text>
      <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11 }}>{label}</Text>
    </View>
  );
}

export function SummaryRow({ summary, theme }: { summary: Summary; theme: PluginTheme }) {
  const cost = fmtCost(summary.costUsd);
  return (
    <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 16 }}>
      <Stat label="turns" value={String(summary.turns)} theme={theme} />
      <Stat label="input" value={fmtTokens(summary.input)} theme={theme} />
      <Stat label="cache" value={fmtTokens(summary.cached)} theme={theme} />
      <Stat label="output" value={fmtTokens(summary.output)} theme={theme} />
      {cost ? <Stat label="cost" value={cost} theme={theme} /> : null}
    </View>
  );
}
