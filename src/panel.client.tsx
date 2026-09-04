import { useRpc, type PluginAgentPanelProps, type PluginTheme } from "@getpaseo/plugin";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { ScrollView, Text, View } from "react-native";
import type { InFlight, Summary, TurnRecord } from "./ledger.shared";
import { ledgerSync } from "./ledger.shared";

function fmtTokens(value: number | null): string {
  if (value === null) return "–";
  if (value < 1000) return String(value);
  if (value < 1_000_000) return `${(value / 1000).toFixed(1)}k`;
  return `${(value / 1_000_000).toFixed(2)}M`;
}

function fmtCost(value: number | null): string | null {
  if (value === null) return null;
  return value >= 0.01 ? `$${value.toFixed(2)}` : `$${value.toFixed(4)}`;
}

function fmtDuration(ms: number | null): string {
  if (ms === null) return "–";
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${String(seconds % 60).padStart(2, "0")}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

function fmtTime(iso: string): string {
  const date = new Date(iso);
  const today = new Date();
  const time = `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
  if (date.toDateString() === today.toDateString()) return time;
  return `${date.getMonth() + 1}/${date.getDate()} ${time}`;
}

function statusColor(status: TurnRecord["status"], theme: PluginTheme): string {
  if (status === "completed") return theme.colors.statusSuccess;
  if (status === "failed") return theme.colors.statusDanger;
  return theme.colors.statusWarning;
}

function useElapsed(startedAt: string | null): string {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!startedAt) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [startedAt]);
  if (!startedAt) return "";
  return fmtDuration(Math.max(0, now - Date.parse(startedAt)));
}

function Stat({ label, value, theme }: { label: string; value: string; theme: PluginTheme }) {
  return (
    <View style={{ minWidth: 56 }}>
      <Text style={{ color: theme.colors.foreground, fontSize: 15, fontWeight: "600", fontVariant: ["tabular-nums"] }}>
        {value}
      </Text>
      <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11 }}>{label}</Text>
    </View>
  );
}

function SummaryRow({ summary, theme }: { summary: Summary; theme: PluginTheme }) {
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

function tokensLine(input: number | null, cached: number | null, output: number | null): string | null {
  if (input === null && cached === null && output === null) return null;
  return `in ${fmtTokens(input)} · cache ${fmtTokens(cached)} · out ${fmtTokens(output)}`;
}

function InFlightCard({ inFlight, theme }: { inFlight: InFlight; theme: PluginTheme }) {
  const elapsed = useElapsed(inFlight.startedAt);
  const tokens = tokensLine(inFlight.input, inFlight.cached, inFlight.output);
  const ctxRatio =
    inFlight.ctxUsed !== null && inFlight.ctxMax !== null && inFlight.ctxMax > 0
      ? Math.min(1, inFlight.ctxUsed / inFlight.ctxMax)
      : null;
  return (
    <View
      style={{
        backgroundColor: theme.colors.surface1,
        borderColor: theme.colors.accent,
        borderWidth: 1,
        borderRadius: 10,
        padding: 12,
        gap: 8,
      }}
    >
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
        <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: theme.colors.accent }} />
        <Text style={{ color: theme.colors.foreground, fontSize: 13, fontWeight: "600", flex: 1 }}>
          Turn in progress
        </Text>
        <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12, fontVariant: ["tabular-nums"] }}>
          {elapsed}
        </Text>
      </View>
      {tokens ? (
        <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12, fontVariant: ["tabular-nums"] }}>
          {tokens}
          {inFlight.modelCalls > 0 ? ` · ${inFlight.modelCalls} call${inFlight.modelCalls > 1 ? "s" : ""}` : ""}
        </Text>
      ) : null}
      {ctxRatio !== null ? (
        <View style={{ gap: 4 }}>
          <View style={{ height: 4, borderRadius: 2, backgroundColor: theme.colors.border, overflow: "hidden" }}>
            <View
              style={{
                width: `${Math.round(ctxRatio * 100)}%`,
                height: 4,
                borderRadius: 2,
                backgroundColor: theme.colors.accent,
              }}
            />
          </View>
          <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11, fontVariant: ["tabular-nums"] }}>
            context {fmtTokens(inFlight.ctxUsed)} / {fmtTokens(inFlight.ctxMax)}
          </Text>
        </View>
      ) : null}
    </View>
  );
}

function RecordRow({ record, theme }: { record: TurnRecord; theme: PluginTheme }) {
  const tokens = tokensLine(record.input, record.cached, record.output);
  const cost = fmtCost(record.costUsd);
  return (
    <View
      style={{
        paddingVertical: 8,
        borderBottomWidth: 1,
        borderBottomColor: theme.colors.border,
        gap: 3,
      }}
    >
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
        <View style={{ width: 7, height: 7, borderRadius: 4, backgroundColor: statusColor(record.status, theme) }} />
        <Text style={{ color: theme.colors.foreground, fontSize: 12, fontVariant: ["tabular-nums"] }}>
          {fmtTime(record.endedAt)}
        </Text>
        <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12, fontVariant: ["tabular-nums"], flex: 1 }}>
          {fmtDuration(record.durationMs)}
          {record.quality === "partial" ? " · ≈" : ""}
        </Text>
        {cost ? (
          <Text style={{ color: theme.colors.foreground, fontSize: 12, fontVariant: ["tabular-nums"] }}>{cost}</Text>
        ) : null}
      </View>
      <Text
        style={{
          color: theme.colors.foregroundMuted,
          fontSize: 12,
          fontVariant: ["tabular-nums"],
          paddingLeft: 15,
        }}
      >
        {tokens ?? "usage unavailable"}
      </Text>
    </View>
  );
}

export function TokenLedgerPanel({ theme, layout, agentId }: PluginAgentPanelProps) {
  const sync = useRpc(ledgerSync);
  const { data, error } = useQuery({
    queryKey: ["token-ledger", agentId],
    queryFn: () => sync({ agentId }),
    refetchInterval: 2000,
  });

  const styles = useMemo(
    () => ({
      screen: { flex: 1, backgroundColor: theme.colors.surface0 },
      content: { padding: layout.compact ? 12 : 20, gap: 14 },
      sectionLabel: {
        color: theme.colors.foregroundMuted,
        fontSize: 11,
        fontWeight: "600" as const,
        letterSpacing: 0.6,
        textTransform: "uppercase" as const,
      },
      muted: { color: theme.colors.foregroundMuted, fontSize: 13 },
    }),
    [theme, layout.compact],
  );

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
      {error ? <Text style={{ color: theme.colors.statusDanger, fontSize: 13 }}>{String(error)}</Text> : null}
      {data ? (
        <>
          <View style={{ gap: 8 }}>
            <Text style={styles.sectionLabel}>Session</Text>
            <SummaryRow summary={data.summary} theme={theme} />
          </View>
          {data.inFlight ? <InFlightCard inFlight={data.inFlight} theme={theme} /> : null}
          <View style={{ gap: 4 }}>
            <Text style={styles.sectionLabel}>Turns</Text>
            {data.records.length === 0 && !data.inFlight ? (
              <Text style={styles.muted}>
                No turns recorded yet. Usage is tracked per turn while this plugin is running.
              </Text>
            ) : (
              data.records.map((record) => <RecordRow key={record.id} record={record} theme={theme} />)
            )}
          </View>
        </>
      ) : (
        <Text style={styles.muted}>Loading…</Text>
      )}
    </ScrollView>
  );
}
