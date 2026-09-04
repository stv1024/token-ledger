import { useRpc, type PluginComposerPillProps } from "@getpaseo/plugin";
import { useEffect, useRef, useState } from "react";
import { Text, View } from "react-native";
import type { SyncResult } from "./ledger.shared";
import { ledgerSync } from "./ledger.shared";
import { fmtCost, fmtTokens } from "./ui.client";

const POLL_MS = 3000;

/**
 * Compact per-session usage pill rendered in each agent's composer, e.g.
 * "$0.43 · ctx 47%". Pressing it opens the TokenLedger panel for the agent
 * (wired via the contribution's onPress in index.ts).
 */
export function TokenLedgerPill({ theme, agentId }: PluginComposerPillProps) {
  const sync = useRpc(ledgerSync);
  const [data, setData] = useState<SyncResult | null>(null);
  const syncRef = useRef(sync);
  syncRef.current = sync;

  useEffect(() => {
    let disposed = false;
    const poll = () => {
      syncRef.current({ agentId, limit: 1 })
        .then((result) => {
          if (!disposed) setData(result);
        })
        .catch(() => undefined);
    };
    poll();
    const timer = setInterval(poll, POLL_MS);
    return () => {
      disposed = true;
      clearInterval(timer);
    };
  }, [agentId]);

  if (!data) {
    return <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11 }}>…</Text>;
  }

  const { summary, inFlight, ctx } = data;
  const totalTokens = summary.input + summary.cached + summary.output;
  const main = fmtCost(summary.costUsd) ?? (totalTokens > 0 ? `${fmtTokens(totalTokens)} tok` : "0 tok");
  const parts = [main];
  const liveCtx =
    inFlight && inFlight.ctxUsed !== null && inFlight.ctxMax !== null
      ? { used: inFlight.ctxUsed, max: inFlight.ctxMax }
      : ctx;
  if (liveCtx && liveCtx.max > 0) {
    parts.push(`ctx ${Math.round((liveCtx.used / liveCtx.max) * 100)}%`);
  }

  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 5 }}>
      {inFlight ? (
        <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: theme.colors.accent }} />
      ) : null}
      <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11, fontVariant: ["tabular-nums"] }}>
        {parts.join(" · ")}
      </Text>
    </View>
  );
}
