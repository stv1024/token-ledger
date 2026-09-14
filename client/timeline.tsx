import type { PluginTimelineItemProps } from '@getpaseo/plugin/client';
import { Text, View } from 'react-native';
import type { UsageTimeline } from '../shared/timeline.ts';
import { fmtCost, fmtDuration, tokensLine, statusColor } from './ui.tsx';

/** A final, passive summary. It does not subscribe or poll while scrolling. */
export function UsageTimelineRow({ item, theme }: PluginTimelineItemProps<UsageTimeline>) {
  const row = item.data;
  const cost = fmtCost(row.effectiveCostUsd);
  const tokens = tokensLine(row.input, row.cached, row.output);
  const details = [row.status === 'completed' ? null : row.status,
    tokens ? `${row.quality === 'partial' ? '≈ ' : ''}${tokens}` : 'usage unavailable',
    cost ? `${row.costSource !== 'reported' ? '≈' : ''}${cost}` : null,
    row.durationMs === null ? null : fmtDuration(row.durationMs),
  ].filter(Boolean).join(' · ');
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 7, paddingVertical: 4 }}>
      <View style={{ width: 5, height: 5, borderRadius: 3, backgroundColor: statusColor(row.status, theme) }} />
      <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11, flexShrink: 1, fontVariant: ['tabular-nums'] }}>
        {details}
      </Text>
    </View>
  );
}
