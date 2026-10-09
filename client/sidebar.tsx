import type { PluginSidebarItemProps } from "@getpaseo/plugin/client";
import { SidebarRow } from "@getpaseo/plugin/client/ui";
import { Text } from "react-native";
import { useOverview } from "./data.ts";
import { OVERVIEW_SCREEN, useRangeStart } from "./range.ts";
import { costOrTokens } from "./ui.tsx";

/** Today's usage at a glance. The row opens the overview on the same range. */
export function LedgerSidebarItem({ theme, currentScreen, openScreen }: PluginSidebarItemProps) {
  const { data } = useOverview(useRangeStart("today"));
  const working = !!data?.groups.some((group) => group.agents.some((agent) => agent.active));
  const label = !data ? null : data.totals.turns === 0 ? "$0.00" : costOrTokens(data.totals);
  return (
    <SidebarRow
      icon={working ? "Activity" : "Coins"}
      active={currentScreen?.screenId === OVERVIEW_SCREEN}
      onPress={() => openScreen({ screenId: OVERVIEW_SCREEN, params: { range: "today" } })}
      trailing={label === null ? null : (
        <Text
          accessibilityLabel={`Today ${label}`}
          style={{ color: theme.colors.foregroundMuted, fontSize: 12, fontVariant: ["tabular-nums"] }}
        >
          {label}
        </Text>
      )}
    />
  );
}
