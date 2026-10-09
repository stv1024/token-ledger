import { useDenseLayout } from "./layout.ts";
import type { PluginTheme } from "@getpaseo/plugin";
import { type PluginScreenProps } from "@getpaseo/plugin/client";
import { ScrollView } from "@getpaseo/plugin/client/react-native";
import { useMemo } from "react";
import { useOverview } from "./data.ts";
import { Pressable, Text, View } from "react-native";
import type { AgentUsageRow } from "../shared/ledger.ts";
import { costOrTokens, fmtTime, SummaryRow, UsageCoverageNote } from "./ui.tsx";
import { parseRange, RANGE_LABELS, RANGES, useRangeStart, type Range } from "./range.ts";


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
          {costOrTokens(row.summary)}
        </Text>
        <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11, fontVariant: ["tabular-nums"] }}>
          {row.summary.turns} turn{row.summary.turns === 1 ? "" : "s"}
        </Text>
      </View>
    </Pressable>
  );
}

function RangePicker({ range, theme, onRange }: { range: Range; theme: PluginTheme; onRange: (range: Range) => void }) {
  return (
    <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
      {RANGES.map((option) => {
        const selected = option === range;
        return (
          <Pressable
            key={option}
            disabled={selected}
            accessibilityRole="button"
            accessibilityState={{ selected }}
            onPress={() => onRange(option)}
            style={({ pressed }) => ({
              paddingVertical: 4,
              paddingHorizontal: 10,
              borderRadius: 6,
              borderWidth: 1,
              borderColor: selected ? theme.colors.accent : theme.colors.border,
              backgroundColor: selected ? theme.colors.surface2 : pressed ? theme.colors.surface1 : "transparent",
            })}
          >
            <Text style={{ color: selected ? theme.colors.foreground : theme.colors.foregroundMuted, fontSize: 12 }}>
              {RANGE_LABELS[option]}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

/** The range lives in the screen params, so the header title and deep links follow it. */
export function TokenLedgerOverview({
  theme,
  layout,
  navigation,
  params,
  onRange,
}: PluginScreenProps & { onRange: (range: Range) => void }) {
  const range = parseRange(params.range);
  const { data, error } = useOverview(useRangeStart(range));
  const { dense, setWidth } = useDenseLayout(layout.compact);

  const styles = useMemo(
    () => ({
      screen: { flex: 1, backgroundColor: theme.colors.surface0 },
      content: { padding: dense ? 12 : 20, gap: 16 },
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
    <ScrollView style={styles.screen} contentContainerStyle={styles.content} onLayout={(event) => setWidth(event.nativeEvent.layout.width)}>
      <RangePicker range={range} theme={theme} onRange={onRange} />
      {error ? <Text style={{ color: theme.colors.statusDanger, fontSize: 13 }}>{String(error)}</Text> : null}
      {data ? (
        <>
          <View style={{ gap: 8 }}>
            <Text style={styles.sectionLabel}>All sessions</Text>
            <SummaryRow summary={data.totals} theme={theme} dense={dense} />
            <UsageCoverageNote theme={theme} />
          </View>
          {data.groups.length === 0 ? (
            <Text style={styles.muted}>{range === "all" ? "No usage recorded yet." : "No usage in this range."}</Text>
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
