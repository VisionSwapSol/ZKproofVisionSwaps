// The activity history in groups: by kind (the filter chips) and by day (Today, Yesterday, a date),
// a page at a time. Pure, so the tests can pin it down.
import type { Activity } from "./engine";

export type ActivityFilter = "all" | "moves" | "trades" | "sends";
export type ActivityGroup = Exclude<ActivityFilter, "all">;

/** Which chip an item belongs under: SOL moving in or out of the private balance, a trade, or a payment. */
export function activityGroup(kind: Activity["kind"]): ActivityGroup {
  switch (kind) {
    case "buy":
    case "sell":
      return "trades";
    case "send":
      return "sends";
    case "shield":
    case "sweep":
    case "merge":
    case "refund":
      return "moves";
  }
}

const dayStart = (t: number) => {
  const d = new Date(t);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
};

/** "Today", "Yesterday" or "Mon, Oct 12" (local time), for the day `t` falls on, seen from `now`. */
export function dayLabel(t: number, now: number): string {
  const day = dayStart(t);
  const today = dayStart(now);
  if (day === today) return "Today";
  // (a day before today's midnight: 23 or 25 hours across a clock change, so by the date, not by 24 hours)
  const y = new Date(today);
  y.setDate(y.getDate() - 1);
  if (day === y.getTime()) return "Yesterday";
  return new Date(t).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
}

/** Items (newest first) in one group per day, in the order given. */
export function groupByDay<T extends { t: number }>(items: readonly T[], now: number): { label: string; items: T[] }[] {
  const out: { label: string; items: T[] }[] = [];
  for (const a of items) {
    const label = dayLabel(a.t, now);
    const last = out[out.length - 1];
    if (last && last.label === label) last.items.push(a);
    else out.push({ label, items: [a] });
  }
  return out;
}

/** The first `n` items under a filter, and whether there are more. */
export function pageOf<T extends { kind: Activity["kind"] }>(items: readonly T[], filter: ActivityFilter, n: number): { items: T[]; more: boolean } {
  const all = filter === "all" ? [...items] : items.filter((a) => activityGroup(a.kind) === filter);
  return { items: all.slice(0, Math.max(0, n)), more: all.length > n };
}
