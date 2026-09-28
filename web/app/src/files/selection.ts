/**
 * Selection in a file list, the way desktop file managers do it, keyed by
 * path so it survives the list refreshing under it:
 *
 *  - a click selects one; ⌘/Ctrl-click adds or removes one; Shift-click
 *    selects the range from the anchor;
 *  - ↑/↓ move the cursor and select what it lands on; with Shift they extend
 *    from the anchor;
 *  - the cursor is the row the keyboard is on, which is selected unless a
 *    toggle just took it out.
 */
export interface Selection {
  selected: ReadonlySet<string>;
  cursor: string | null;
  anchor: string | null;
}

export const EMPTY: Selection = { selected: new Set(), cursor: null, anchor: null };

function range(order: string[], a: string, b: string): string[] {
  const i = order.indexOf(a);
  const j = order.indexOf(b);
  if (i === -1 || j === -1) return [b];
  return order.slice(Math.min(i, j), Math.max(i, j) + 1);
}

export function click(sel: Selection, order: string[], path: string, mods: { toggle?: boolean; range?: boolean } = {}): Selection {
  if (mods.range && sel.anchor) {
    const span = range(order, sel.anchor, path);
    const selected = mods.toggle ? new Set([...sel.selected, ...span]) : new Set(span);
    return { selected, cursor: path, anchor: sel.anchor };
  }
  if (mods.toggle) {
    const selected = new Set(sel.selected);
    if (selected.has(path)) selected.delete(path);
    else selected.add(path);
    return { selected, cursor: path, anchor: path };
  }
  return { selected: new Set([path]), cursor: path, anchor: path };
}

/** Move the cursor `delta` rows (clamped); Shift extends from the anchor. */
export function move(sel: Selection, order: string[], delta: number, extend = false): Selection {
  if (order.length === 0) return sel;
  const at = sel.cursor ? order.indexOf(sel.cursor) : -1;
  const next = at === -1 ? (delta > 0 ? 0 : order.length - 1) : Math.min(order.length - 1, Math.max(0, at + delta));
  return to(sel, order, next, extend);
}

/** Jump to the first or last row. */
export function edge(sel: Selection, order: string[], where: "start" | "end", extend = false): Selection {
  if (order.length === 0) return sel;
  return to(sel, order, where === "start" ? 0 : order.length - 1, extend);
}

function to(sel: Selection, order: string[], index: number, extend: boolean): Selection {
  const path = order[index]!;
  if (extend) {
    const anchor = sel.anchor ?? sel.cursor ?? path;
    return { selected: new Set(range(order, anchor, path)), cursor: path, anchor };
  }
  return { selected: new Set([path]), cursor: path, anchor: path };
}

export function selectAll(order: string[]): Selection {
  return { selected: new Set(order), cursor: order[0] ?? null, anchor: order[0] ?? null };
}

/** Put the cursor on one row without selecting anything (focus follows the pointer, say). */
export function only(path: string): Selection {
  return { selected: new Set([path]), cursor: path, anchor: path };
}

/** Forget rows that are gone after a refresh. */
export function prune(sel: Selection, order: string[]): Selection {
  const present = new Set(order);
  const selected = new Set([...sel.selected].filter((p) => present.has(p)));
  const keep = (p: string | null) => (p && present.has(p) ? p : null);
  if (selected.size === sel.selected.size && keep(sel.cursor) === sel.cursor && keep(sel.anchor) === sel.anchor) return sel;
  return { selected, cursor: keep(sel.cursor), anchor: keep(sel.anchor) };
}

/** The selected paths in list order. */
export function ordered(sel: Selection, order: string[]): string[] {
  return order.filter((p) => sel.selected.has(p));
}
