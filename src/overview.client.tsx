import { useRpc, type PluginSurfaceProps, type PluginTheme } from "@getpaseo/plugin";
import { useEffect, useMemo, useRef, useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import type { AgentUsageRow, OverviewResult } from "./ledger.shared";
import { ledgerOverview } from "./ledger.shared";
import { fmtCost, fmtTime, fmtTokens, SummaryRow } from "./ui.client";

const POLL_MS = 3000;

function agentStatusColor(row: AgentUsageRow, theme: PluginTheme): string {
  if (row.active) return theme.colors.accent;
  if (row.status === "error") return theme.colors.statusDanger;
  if (row.status === null || row.status === "closed") return theme.colors.border;
  return theme.colors.statusSuccess;
}

function AgentRow({
  row,
  theme,
  onOpen,
}: {
  row: AgentUsageRow;
  theme: PluginTheme;
  onOpen: (() => void) | null;
}) {
  const cost = fmtCost(row.summary.costUsd);
  const totalTokens = row.summary.input + row.summary.cached + row.summary.output;
  const name = row.title ?? row.agentId.slice(0, 8);
  const meta = [row.model ?? row.provider, row.lastActivityAt ? fmtTime(row.lastActivityAt) : null]
    .filter(Boolean)
    .join(" · ");
  return (
    <Pressable
      disabled={!onOpen}
      onPress={onOpen ?? undefined}
      style={({ pressed }) => ({
        flexDirection: "row",
        alignItems: "center",
        gap: 10,
        paddingVertical: 9,
        paddingHorizontal: 4,
        borderBottomWidth: 1,
        borderBottomColor: theme.colors.border,
        backgroundColor: pressed ? theme.colors.surface1 : "transparent",
      })}
    >
      <View style={{ width: 7, height: 7, borderRadius: 4, backgroundColor: agentStatusColor(row, theme) }} />
      <View style={{ flex: 1, gap: 2 }}>
        <Text numberOfLines={1} style={{ color: theme.colors.foreground, fontSize: 13 }}>
          {name}
        </Text>
        {meta ? (
          <Text numberOfLines={1} style={{ color: theme.colors.foregroundMuted, fontSize: 11 }}>
            {meta}
          </Text>
        ) : null}
      </View>
      <View style={{ alignItems: "flex-end", gap: 2 }}>
        <Text style={{ color: theme.colors.foreground, fontSize: 13, fontVariant: ["tabular-nums"] }}>
          {cost ?? `${fmtTokens(totalTokens)} tok`}
        </Text>
        <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11, fontVariant: ["tabular-nums"] }}>
          {row.summary.turns} turn{row.summary.turns === 1 ? "" : "s"}
        </Text>
      </View>
    </Pressable>
  );
}

export function TokenLedgerOverview({ theme, layout, navigation }: PluginSurfaceProps) {
  const overview = useRpc(ledgerOverview);
  const [data, setData] = useState<OverviewResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const overviewRef = useRef(overview);
  overviewRef.current = overview;

  useEffect(() => {
    let disposed = false;
    const poll = () => {
      overviewRef.current({})
        .then((result) => {
          if (disposed) return;
          setData(result);
          setError(null);
        })
        .catch((err) => {
          if (!disposed) setError(String(err));
        });
    };
    poll();
    const timer = setInterval(poll, POLL_MS);
    return () => {
      disposed = true;
      clearInterval(timer);
    };
  }, []);

  const styles = useMemo(
    () => ({
      screen: { flex: 1, backgroundColor: theme.colors.surface0 },
      content: { padding: layout.compact ? 12 : 20, gap: 16 },
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
      <Text style={{ color: theme.colors.foreground, fontSize: 17, fontWeight: "600" }}>TokenLedger</Text>
      {error ? <Text style={{ color: theme.colors.statusDanger, fontSize: 13 }}>{error}</Text> : null}
      {data ? (
        <>
          <View style={{ gap: 8 }}>
            <Text style={styles.sectionLabel}>All sessions</Text>
            <SummaryRow summary={data.totals} theme={theme} />
          </View>
          {data.groups.length === 0 ? (
            <Text style={styles.muted}>No usage recorded yet.</Text>
          ) : (
            data.groups.map((group) => (
              <View key={group.workspaceId ?? "__none__"} style={{ gap: 4 }}>
                <Text style={styles.sectionLabel}>
                  {group.workspaceName ?? (group.workspaceId ? group.workspaceId.slice(0, 8) : "Other sessions")}
                </Text>
                {group.agents.map((row) => (
                  <AgentRow
                    key={row.agentId}
                    row={row}
                    theme={theme}
                    onOpen={navigation ? () => navigation.openAgent({ agentId: row.agentId }) : null}
                  />
                ))}
              </View>
            ))
          )}
        </>
      ) : (
        <Text style={styles.muted}>Loading…</Text>
      )}
    </ScrollView>
  );
}
