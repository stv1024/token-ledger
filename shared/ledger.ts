import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

export const TurnRecordSchema = z.object({
  v: z.literal(1),
  id: z.string(),
  agentId: z.string(),
  turnId: z.string().nullable(),
  provider: z.string().nullable(),
  model: z.string().nullable(),
  /** Provider session identity, when observed; optional for pre-0.8 records. */
  sessionId: z.string().nullable().optional(),
  startedAt: z.string().nullable(),
  endedAt: z.string(),
  durationMs: z.number().nullable(),
  status: z.enum(["completed", "failed", "canceled"]),
  /**
   * Turn token totals. On disk these are exactly as reported upstream (some
   * providers count cache reads inside input — see semantics.ts); rows served
   * over RPC are normalized so input is always fresh uncached tokens.
   * Null when the provider reported nothing.
   */
  input: z.number().nullable(),
  cached: z.number().nullable(),
  output: z.number().nullable(),
  /** Cost attributed to this turn (delta of a cumulative session cost when detected). */
  costUsd: z.number().nullable(),
  /** Raw cost value reported at turn end, before any delta interpretation. */
  sessionCostUsd: z.number().nullable(),
  /** Explicit cost interpretation; absent on historical records. */
  costScope: z.enum(['session', 'unknown']).optional(),
  /** Raw per-request observations, when the harness contract is verified. */
  requests: z.array(z.object({
    input: z.number().nullable(), cached: z.number().nullable(), output: z.number().nullable(),
  })).optional(),
  /** Number of distinct token-bearing usage observations during the turn. */
  modelCalls: z.number(),
  quality: z.enum(["exact", "partial", "unavailable"]),
  /** How the token totals were derived: turn_usage | summed_observations | last_observation | none */
  source: z.string(),
});
export type TurnRecord = z.infer<typeof TurnRecordSchema>;

export const CostSourceSchema = z.enum(["reported", "override", "openrouter", "builtin"]);
export type CostSource = z.infer<typeof CostSourceSchema>;

export const CostBreakdownSchema = z.object({
  inUsd: z.number(),
  cacheUsd: z.number(),
  outUsd: z.number(),
  otherUsd: z.number().nullable(),
});

/** A record enriched at read time. The JSONL remains untouched and contains only upstream facts. */
export const TurnRowSchema = TurnRecordSchema.extend({
  seq: z.number().int().positive(),
  effectiveCostUsd: z.number().nullable(),
  costSource: CostSourceSchema.nullable(),
  costBreakdown: CostBreakdownSchema.nullable(),
});
export type TurnRow = z.infer<typeof TurnRowSchema>;

export const InFlightSchema = z.object({
  turnId: z.string().nullable(),
  startedAt: z.string(),
  modelCalls: z.number(),
  input: z.number().nullable(),
  cached: z.number().nullable(),
  output: z.number().nullable(),
  /** Current turn estimate from the same server-side pricing path as settled rows. */
  effectiveCostUsd: z.number().nullable(),
  costSource: CostSourceSchema.nullable(),
  ctxUsed: z.number().nullable(),
  ctxMax: z.number().nullable(),
});
export type InFlight = z.infer<typeof InFlightSchema>;

export const SummarySchema = z.object({
  turns: z.number(),
  input: z.number(),
  cached: z.number(),
  output: z.number(),
  costUsd: z.number().nullable(),
  /** Reported + estimated costs for priced turns. */
  effectiveCostUsd: z.number().nullable(),
  estimatedTurns: z.number().int().nonnegative(),
  unpricedTurns: z.number().int().nonnegative(),
});
export type Summary = z.infer<typeof SummarySchema>;

export const CtxSchema = z.object({
  used: z.number(),
  max: z.number(),
});
export type Ctx = z.infer<typeof CtxSchema>;

const SyncOutputSchema = z.object({
  recordsRevision: z.string(),
  inFlight: InFlightSchema.nullable(),
  records: z.array(TurnRowSchema),
  summary: SummarySchema,
  /** Last known context-window usage for the agent, in or out of a turn. */
  ctx: CtxSchema.nullable(),
});
export type SyncResult = z.infer<typeof SyncOutputSchema>;

export const ledgerSync = defineRpc({
  name: "ledger.sync",
  input: z.object({
    agentId: z.string(),
    knownRecordsRevision: z.string().optional(),
    limit: z.number().int().positive().max(200).optional(),
  }),
  output: SyncOutputSchema,
});

export const AgentUsageRowSchema = z.object({
  agentId: z.string(),
  /** Agent metadata as last reported by the daemon; null when the agent is gone. */
  title: z.string().nullable(),
  provider: z.string().nullable(),
  model: z.string().nullable(),
  status: z.string().nullable(),
  /** True while a turn is in flight. */
  active: z.boolean(),
  lastActivityAt: z.string().nullable(),
  summary: SummarySchema,
});
export type AgentUsageRow = z.infer<typeof AgentUsageRowSchema>;

export const OverviewGroupSchema = z.object({
  workspaceId: z.string().nullable(),
  workspaceName: z.string().nullable(),
  agents: z.array(AgentUsageRowSchema),
});
export type OverviewGroup = z.infer<typeof OverviewGroupSchema>;

const OverviewOutputSchema = z.object({
  groups: z.array(OverviewGroupSchema),
  totals: SummarySchema,
});
export type OverviewResult = z.infer<typeof OverviewOutputSchema>;

export const ledgerOverview = defineRpc({
  name: "ledger.overview",
  input: z.object({}),
  output: OverviewOutputSchema,
});

export const ledgerEnsure = defineRpc({
  name: "ledger.ensure",
  input: z.object({}),
  output: z.object({ tracking: z.boolean() }),
});
