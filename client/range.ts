import { useEffect, useMemo, useState } from "react";

export const OVERVIEW_SCREEN = "ledger-overview";
export const RANGES = ["today", "7d", "30d", "all"] as const;
export type Range = (typeof RANGES)[number];
export const RANGE_LABELS: Record<Range, string> = {
  today: "Today",
  "7d": "Last 7 days",
  "30d": "Last 30 days",
  all: "All time",
};
const RANGE_DAYS: Record<Exclude<Range, "all">, number> = { today: 1, "7d": 7, "30d": 30 };

/** Screen params come from the URL. Unknown or absent values mean all time. */
export function parseRange(value: string | undefined): Range {
  return (RANGES as readonly string[]).includes(value ?? "") ? value as Range : "all";
}

/** Local midnight that opens the range, as ISO. Day ranges include today. */
export function rangeStart(range: Range, now = new Date()): string | null {
  if (range === "all") return null;
  return new Date(now.getFullYear(), now.getMonth(), now.getDate() - (RANGE_DAYS[range] - 1)).toISOString();
}

/** Rolls over at local midnight. A minute poll also survives sleep and DST changes. */
export function useRangeStart(range: Range): string | null {
  const [day, setDay] = useState(() => new Date().toDateString());
  useEffect(() => {
    const timer = setInterval(() => setDay(new Date().toDateString()), 60_000);
    return () => clearInterval(timer);
  }, []);
  return useMemo(() => rangeStart(range), [range, day]);
}
