import { z } from 'zod';
import { TurnRowSchema } from './ledger.ts';

export const USAGE_TIMELINE_KIND = 'turn-usage';
export const UsageTimelineSchema = TurnRowSchema.pick({
  id: true, input: true, cached: true, output: true, effectiveCostUsd: true,
  costSource: true, quality: true, status: true, durationMs: true,
});
export type UsageTimeline = z.infer<typeof UsageTimelineSchema>;
