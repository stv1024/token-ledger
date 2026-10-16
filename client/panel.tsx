import { useDenseLayout } from "./layout.ts";
import type { PluginTheme } from "@getpaseo/plugin";
import { useAgent, type PluginAgentPanelProps } from "@getpaseo/plugin/client";
import { ScrollView } from "@getpaseo/plugin/client/react-native";
import { useLedger } from "./data.ts";
import { useEffect, useMemo, useState } from "react";
import { Text, View } from "react-native";
import type { Ctx, InFlight, TurnRow } from "../shared/ledger.ts";
import { cacheRatio } from "../shared/pricing.ts";
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
  UsageCoverageNote,
} from "./ui.tsx";

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
  const tokens = tokensLine(inFlight.input, inFlight.cached, inFlight.output, inFlight.cacheWrite);
  const pct = fmtPct(cacheRatio(inFlight.cached, inFlight.promptTokens));
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
          {pct ? ` (${pct} cached)` : ' (cache rate unknown)'}
          {inFlight.modelCalls > 0 ? ` · ${inFlight.modelCalls} observation${inFlight.modelCalls > 1 ? 's' : ''}` : ''}
        </Text>
      ) : (
        <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12, fontStyle: "italic" }}>
          tokens & cost reported at turn end
        </Text>
      )}
      {inFlight.tokenScope !== 'turn' ? <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11 }}>
        {inFlight.tokenScope} snapshot, not current-turn usage. Excluded from totals.
      </Text> : null}
      {inFlight.effectiveCostUsd !== null ? (
        <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12, fontVariant: ["tabular-nums"] }}>
          {inFlight.costSource === 'reported' ? '' : '≈'}{fmtCost(inFlight.effectiveCostUsd)} {inFlight.partialCost ? 'partial estimate' : 'current turn'}
        </Text>
      ) : null}
      {inFlight.pricingWarning ? <Text style={{ color: theme.colors.statusWarning, fontSize: 11 }}>{inFlight.pricingWarning}</Text> : null}
      {ctx ? <CtxBar ctx={ctx} theme={theme} /> : null}
      {inFlight.usageGap ? <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11 }}>Connection interrupted · usage may be incomplete.</Text> : null}
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
    <View style={{ width: width.minWidth, alignItems: "flex-end" }}>
      <Text style={{ color: theme.colors.foreground, fontSize: 12, fontVariant: ["tabular-nums"] }}>{top}</Text>
      <Text style={{ maxWidth: width.minWidth, textAlign: 'right', color: theme.colors.foregroundMuted, fontSize: 10, fontVariant: ["tabular-nums"] }}>
        {bottom}
      </Text>
    </View>
  );
}

function RecordRow({ record, theme, dense }: { record: TurnRow; theme: PluginTheme; dense: boolean }) {
  const cols = turnColumns(dense);
  const hasUsage = record.input !== null || record.cached !== null || record.output !== null || record.cacheWrite != null;
  const split = record.costBreakdown;
  const pct = fmtPct(cacheRatio(record.cached, record.promptTokens));
  const cacheCost = split ? fmtCostSmall(split.cacheUsd) : "–";
  const costDetail = record.pricingWarning ? 'price config' :
    record.costSource === "override"
      ? "override"
      : record.costSource === "openrouter"
        ? "OR ref"
        : record.costSource === "builtin"
          ? "list"
          : record.tokenScope !== 'turn' ? 'not turn' : `runtime ${fmtResidual(split?.otherUsd ?? null).trim()}`;
  const seqWidth = dense ? 20 : 24;
  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: cols.gap,
        paddingVertical: 6,
        borderBottomWidth: 1,
        borderBottomColor: theme.colors.border,
      }}
    >
      <View style={{ flex: 1, minWidth: dense ? 72 : 88 }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
          <View style={{ width: 7, height: 7, borderRadius: 4, backgroundColor: statusColor(record.status, theme) }} />
          <Text
            style={{ color: theme.colors.foregroundMuted, fontSize: 12, fontVariant: ["tabular-nums"], minWidth: seqWidth }}
          >
            #{record.seq}
          </Text>
          <Text numberOfLines={1} style={{ color: theme.colors.foreground, fontSize: 12, fontVariant: ["tabular-nums"] }}>
            {fmtTime(record.endedAt)}
          </Text>
        </View>
        <Text
          numberOfLines={2}
          style={{
            color: theme.colors.foregroundMuted,
            fontSize: 10,
            fontVariant: ["tabular-nums"],
            // Align under the time text: dot(7) + gap(6) + seq col + gap(6).
            paddingLeft: 19 + seqWidth,
          }}
        >
          {fmtDuration(record.durationMs)}
            {record.tokenScope !== 'turn' ? ` · ${record.tokenScope} snapshot` : record.usageGap ? ' · gap' : record.incompleteUsage ? ' · incomplete' : ''}
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
          <View style={{ gap: 3 }}>
            <TurnCell
              top={fmtTokens(record.cached)}
              bottom={pct ? `${cacheCost}·${pct}` : `${cacheCost}·?`}
              width={cols.cache}
              theme={theme}
            />
            <TurnCell top={`${fmtTokens(record.cacheWrite ?? null)} write`}
              bottom={fmtCostSmall(split?.cacheWriteUsd ?? null)} width={cols.cache} theme={theme} />
          </View>
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
            minWidth: cols.in.minWidth + cols.cache.minWidth + cols.out.minWidth + cols.gap * 2,
            textAlign: "right",
          }}
        >
          usage unavailable
        </Text>
      )}
      <TurnCell
        top={`${record.costSource && record.costSource !== "reported" ? "≈" : ""}${fmtCost(record.effectiveCostUsd) ?? "–"}`}
        bottom={`${costDetail}${record.partialCost && record.effectiveCostUsd !== null ? ' partial' : ''}`}
        width={cols.cost}
        theme={theme}
      />
    </View>
  );
}

export function TokenLedgerPanel({ theme, layout, agentId }: PluginAgentPanelProps) {
  const { dense, setWidth } = useDenseLayout(layout.compact);
  const { data, error } = useLedger(agentId);
  const pricingWarnings = [...new Set(data?.records.flatMap((record) => record.pricingWarning ? [record.pricingWarning] : []) ?? [])];
  // Make the panel↔agent binding visible: which session is this ledger for?
  const agentLabel = useAgent(agentId, (agent) => {
    const name = agent.title ?? agentId.slice(0, 8);
    return agent.model ? `${name} · ${agent.model}` : name;
  });

  const styles = useMemo(
    () => ({
      screen: { flex: 1, backgroundColor: theme.colors.surface0 },
      content: { padding: dense ? 10 : 20, gap: 14 },
      sectionLabel: {
        color: theme.colors.foregroundMuted,
        fontSize: 11,
        fontWeight: "600" as const,
        letterSpacing: 0.6,
        textTransform: "uppercase" as const,
      },
      muted: { color: theme.colors.foregroundMuted, fontSize: 13 },
    }),
    [theme, dense],
  );

  return (
    <ScrollView
      style={styles.screen}
      contentContainerStyle={styles.content}
      onLayout={(e) => setWidth(e.nativeEvent.layout.width)}
    >
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
            <SummaryRow summary={data.summary} theme={theme} dense={dense} />
            <UsageCoverageNote theme={theme} />
            {pricingWarnings.map((warning) => <Text key={warning} style={{ color: theme.colors.statusWarning, fontSize: 11 }}>{warning}</Text>)}
            {!data.inFlight && data.ctx ? <CtxBar ctx={data.ctx} theme={theme} /> : null}
          </View>
          {data.usageSnapshot ? <View style={{ gap: 6, padding: 12, backgroundColor: theme.colors.surface1, borderRadius: 10 }}>
            <Text style={{ color: theme.colors.foreground, fontSize: 13, fontWeight: '600' }}>
              Latest {data.usageSnapshot.scope === 'session' ? 'session / branch' : 'unknown-scope'} snapshot
            </Text>
            <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>
              {tokensLine(data.usageSnapshot.input, data.usageSnapshot.cached, data.usageSnapshot.output, data.usageSnapshot.cacheWrite)}
            </Text>
            {data.usageSnapshot.reportedCostUsd !== null ? <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>
              Runtime-reported cost: {fmtCost(data.usageSnapshot.reportedCostUsd)} · not a verified bill
            </Text> : null}
            <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11 }}>
              Not per-turn usage; excluded from totals. Late updates refresh this snapshot, not closed turns.
              {data.usageSnapshot.observedAt ? ` Observed ${fmtTime(data.usageSnapshot.observedAt)}.` : ''}
            </Text>
          </View> : null}
          {data.inFlight ? <InFlightCard inFlight={data.inFlight} seq={data.summary.turns + 1} theme={theme} /> : null}
          <View style={{ gap: 2 }}>
            <TurnTableHeader theme={theme} dense={dense} />
            {data.records.length === 0 && !data.inFlight ? (
              <Text style={styles.muted}>
                No turns recorded yet. Usage is tracked per turn while this plugin is running.
              </Text>
            ) : (
              <>
                {data.records.map((record) => (
                  // Keyed by seq, not record.id: ids of records persisted before
                  // v0.1.x lack the endedAt component and collide across session
                  // restarts (turnId reuse), which made React render ghost rows.
                  <RecordRow key={record.seq} record={record} theme={theme} dense={dense} />
                ))}
                <Text style={{ color: theme.colors.foregroundMuted, fontSize: 10, paddingTop: 6 }}>
                  IN is uncached input; it may include unclassified writes. “?” means the cache-rate denominator is unknown.
                  Session/unknown snapshots are observations at settlement, not final turn totals.
                </Text>
                {data.records.some((record) => fmtResidual(record.costBreakdown?.otherUsd ?? null).trim() !== "") ? (
                  <Text style={{ color: theme.colors.foregroundMuted, fontSize: 10, paddingTop: 6 }}>
                    ± under COST: runtime-reported cost minus known component estimates. A residual does not identify missing tokens or actual charges.
                  </Text>
                ) : null}
                {data.records.some((record) => record.costSource && record.costSource !== "reported") ? (
                  <Text style={{ color: theme.colors.foregroundMuted, fontSize: 10, paddingTop: 4 }}>
                    ≈ estimated: override = local pricing.json · OR ref = OpenRouter reference · list = built-in prices.
                  </Text>
                ) : null}
                {data.records.some((record) => record.usageGap) ? (
                  <Text style={{ color: theme.colors.foregroundMuted, fontSize: 10, paddingTop: 4 }}>
                    gap: connection interrupted; usage may be incomplete. A missing turn outcome is recorded as unknown.
                  </Text>
                ) : null}
              </>
            )}
          </View>
        </>
      ) : (
        <Text style={styles.muted}>Loading…</Text>
      )}
    </ScrollView>
  );
}
