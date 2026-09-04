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
