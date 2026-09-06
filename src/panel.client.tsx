import { useAgent, useRpc, type PluginAgentPanelProps, type PluginTheme } from "@getpaseo/plugin";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { ScrollView, Text, View } from "react-native";
import type { Ctx, InFlight, TurnRow } from "./ledger.shared";
import { ledgerSync } from "./ledger.shared";
import { cacheRatio, costBreakdown } from "./pricing";
import {
  fmtCost,
  fmtCostSmall,
  fmtDuration,
  fmtPct,
  fmtResidual,
  fmtTime,
  fmtTokens,
  statusColor,
  SummaryRow,
  tokensLine,
  turnColumns,
  TurnTableHeader,
} from "./ui.client";

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

function CtxBar({ ctx, theme }: { ctx: Ctx; theme: PluginTheme }) {
  const ratio = ctx.max > 0 ? Math.min(1, ctx.used / ctx.max) : 0;
  return (
    <View style={{ gap: 4 }}>
      <View style={{ height: 4, borderRadius: 2, backgroundColor: theme.colors.border, overflow: "hidden" }}>
        <View
          style={{
            width: `${Math.round(ratio * 100)}%`,
            height: 4,
            borderRadius: 2,
            backgroundColor: theme.colors.accent,
          }}
        />
      </View>
      <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11, fontVariant: ["tabular-nums"] }}>
        context {fmtTokens(ctx.used)} / {fmtTokens(ctx.max)}
      </Text>
    </View>
  );
}

function InFlightCard({ inFlight, seq, theme }: { inFlight: InFlight; seq: number; theme: PluginTheme }) {
  const elapsed = useElapsed(inFlight.startedAt);
  const tokens = tokensLine(inFlight.input, inFlight.cached, inFlight.output);
  const pct = fmtPct(cacheRatio(inFlight.input, inFlight.cached));
  const ctx = inFlight.ctxUsed !== null && inFlight.ctxMax !== null ? { used: inFlight.ctxUsed, max: inFlight.ctxMax } : null;
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
          Turn #{seq} in progress
        </Text>
        <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12, fontVariant: ["tabular-nums"] }}>
          {elapsed}
        </Text>
      </View>
      {tokens ? (
        <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12, fontVariant: ["tabular-nums"] }}>
          {tokens}
          {pct ? ` (${pct} cached)` : ""}
          {inFlight.modelCalls > 0 ? ` · ${inFlight.modelCalls} call${inFlight.modelCalls > 1 ? "s" : ""}` : ""}
        </Text>
      ) : (
        <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12, fontStyle: "italic" }}>
          tokens & cost reported at turn end
        </Text>
      )}
      {ctx ? <CtxBar ctx={ctx} theme={theme} /> : null}
    </View>
  );
}

/** One cell of the TURNS table: tokens on top, estimated cost below. */
function TurnCell({
  top,
  bottom,
  width,
  theme,
}: {
  top: string;
  bottom: string;
  width: { minWidth: number };
  theme: PluginTheme;
}) {
  return (
    <View style={{ ...width, alignItems: "flex-end" }}>
      <Text style={{ color: theme.colors.foreground, fontSize: 12, fontVariant: ["tabular-nums"] }}>{top}</Text>
      <Text style={{ color: theme.colors.foregroundMuted, fontSize: 10, fontVariant: ["tabular-nums"] }}>
        {bottom}
      </Text>
    </View>
  );
}

function RecordRow({ record, theme, compact }: { record: TurnRow; theme: PluginTheme; compact: boolean }) {
  const cols = turnColumns(compact);
  const hasUsage = record.input !== null || record.cached !== null || record.output !== null;
  const split = costBreakdown(record);
  const pct = fmtPct(cacheRatio(record.input, record.cached));
  const cacheCost = split ? fmtCostSmall(split.cacheUsd) : "–";
  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: 8,
        paddingVertical: 6,
        borderBottomWidth: 1,
        borderBottomColor: theme.colors.border,
      }}
    >
      <View style={{ flex: 1 }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
          <View style={{ width: 7, height: 7, borderRadius: 4, backgroundColor: statusColor(record.status, theme) }} />
          <Text
            style={{ color: theme.colors.foregroundMuted, fontSize: 12, fontVariant: ["tabular-nums"], minWidth: 24 }}
          >
            #{record.seq}
          </Text>
          <Text style={{ color: theme.colors.foreground, fontSize: 12, fontVariant: ["tabular-nums"] }}>
            {fmtTime(record.endedAt)}
          </Text>
        </View>
        <Text
          style={{
            color: theme.colors.foregroundMuted,
            fontSize: 10,
            fontVariant: ["tabular-nums"],
            paddingLeft: 43,
          }}
        >
          {fmtDuration(record.durationMs)}
          {record.quality === "partial" ? " ≈" : ""}
        </Text>
      </View>
      {hasUsage ? (
        <>
          <TurnCell
            top={fmtTokens(record.input)}
            bottom={split ? fmtCostSmall(split.inUsd) : "–"}
            width={cols.in}
            theme={theme}
          />
          <TurnCell
            top={fmtTokens(record.cached)}
            bottom={pct ? `${cacheCost}·${pct}` : cacheCost}
            width={cols.cache}
            theme={theme}
          />
          <TurnCell
            top={fmtTokens(record.output)}
            bottom={split ? fmtCostSmall(split.outUsd) : "–"}
            width={cols.out}
            theme={theme}
          />
        </>
      ) : (
        <Text
          style={{
            color: theme.colors.foregroundMuted,
            fontSize: 11,
            fontStyle: "italic",
            minWidth: cols.in.minWidth + cols.cache.minWidth + cols.out.minWidth + 16,
            textAlign: "right",
          }}
        >
          usage unavailable
        </Text>
      )}
      <TurnCell
        top={fmtCost(record.costUsd) ?? "–"}
        bottom={fmtResidual(split?.otherUsd ?? null)}
        width={cols.cost}
        theme={theme}
      />
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
  // Make the panel↔agent binding visible: which session is this ledger for?
  const agentLabel = useAgent(agentId, (agent) => {
    const name = agent.title ?? agentId.slice(0, 8);
    return agent.model ? `${name} · ${agent.model}` : name;
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
            <View style={{ flexDirection: "row", alignItems: "baseline", gap: 8 }}>
              <Text style={styles.sectionLabel}>Session</Text>
              <Text numberOfLines={1} style={{ ...styles.muted, fontSize: 12, flexShrink: 1 }}>
                {agentLabel ?? agentId.slice(0, 8)}
              </Text>
            </View>
            <SummaryRow summary={data.summary} theme={theme} />
            {!data.inFlight && data.ctx ? <CtxBar ctx={data.ctx} theme={theme} /> : null}
          </View>
          {data.inFlight ? <InFlightCard inFlight={data.inFlight} seq={data.summary.turns + 1} theme={theme} /> : null}
          <View style={{ gap: 2 }}>
            <TurnTableHeader theme={theme} compact={layout.compact} />
            {data.records.length === 0 && !data.inFlight ? (
              <Text style={styles.muted}>
                No turns recorded yet. Usage is tracked per turn while this plugin is running.
              </Text>
            ) : (
              data.records.map((record) => (
                <RecordRow key={record.id} record={record} theme={theme} compact={layout.compact} />
              ))
            )}
          </View>
        </>
      ) : (
        <Text style={styles.muted}>Loading…</Text>
      )}
    </ScrollView>
  );
}
