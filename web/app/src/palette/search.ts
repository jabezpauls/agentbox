import type { AgentStatus } from "@workbench/shared";
import type { LucideIcon } from "lucide-react";

export type PaletteKind =
  | "surface"
  | "agent"
  | "project"
  | "file"
  | "app"
  | "review"
  | "workspace"
  | "tab"
  | "pane"
  | "action";

export interface PaletteItem {
  id: string;
  kind: PaletteKind;
  label: string;
  /** A second, quieter line: a path, a folder, where it runs. */
  sub?: string | undefined;
  /** Words it should also be found by, that are not in the label. */
  keywords?: string;
  hint?: string;
  /** A shortcut, shown as a key chip. */
  keys?: string;
  status?: AgentStatus;
  icon?: LucideIcon;
  run(): void;
}

/**
 * Score a subsequence match of `query` against `label` (both lowercased).
 * Returns null when `query` is not a subsequence of `label`. Higher is better:
 * a match at the very start and contiguous runs are rewarded, gaps are
 * penalised, so an exact prefix beats a scattered match.
 */
function score(query: string, label: string): number | null {
  const q = query;
  const l = label;
  let qi = 0;
  let prev = -1;
  let s = 0;
  for (let li = 0; li < l.length && qi < q.length; li++) {
    if (l[li] !== q[qi]) continue;
    if (li === 0) s += 12; // matched at the very start
    else if (prev === li - 1) s += 6; // contiguous with the previous match
    else s -= Math.min(li - prev - 1, 4); // penalise the gap, capped
    if (qi === 0) s -= li; // an earlier first match is better
    prev = li;
    qi++;
  }
  return qi === q.length ? s : null;
}

/**
 * Fuzzy-filter and rank palette items. An empty (or whitespace) query returns
 * the items unchanged, preserving the caller's ordering. Sorting is stable, so
 * items with equal scores keep their original relative order. A match in the
 * keywords counts, below any match in the label.
 */
export function searchItems(query: string, items: PaletteItem[]): PaletteItem[] {
  const q = query.trim().toLowerCase();
  if (!q) return items;
  const scored: { item: PaletteItem; s: number; i: number }[] = [];
  items.forEach((item, i) => {
    let s = score(q, item.label.toLowerCase());
    if (s === null && item.keywords) {
      const k = score(q, item.keywords.toLowerCase());
      // Always below any match in a label.
      if (k !== null) s = k - 100;
    }
    if (s !== null) scored.push({ item, s, i });
  });
  scored.sort((a, b) => b.s - a.s || a.i - b.i);
  return scored.map((x) => x.item);
}
