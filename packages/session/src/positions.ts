import type { IntentRow } from '@primerkit/core';
import type { Line, Maker } from '@primerkit/ui';

// /positions: the Alpaca paper account's holdings, read in its read mode or above, and every
// order intent in the journal. Read only: nothing on this screen sends or approves an order;
// a paper order is placed with primerkit intent <id> place, and a live intent approved with
// primerkit intent approve <id>, each at a terminal.

export interface Holding {
  symbol: string;
  qty: number;
  avgEntryPrice?: number;
  marketValue: number;
  changeToday?: number; // the asset's change today, as a share, as Alpaca reports it
}

export type HoldingsView =
  | { kind: 'held'; mode: string; rows: Holding[]; readAt: string }
  | { kind: 'note'; text: string }; // off, no keys, or the account could not be read: one line

export interface PositionsView {
  holdings: HoldingsView;
  intents: IntentRow[];
}

const money = (n: number) => `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const qtyText = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(6).replace(/\.?0+$/, ''));
const when = (iso: string | null) => (iso ? `${iso.slice(5, 10)} ${iso.slice(11, 16)}` : '-');

// The rows as plain text, for the command line and for the screen's own cells.
export function holdingCells(h: Holding): string[] {
  const change = h.changeToday === undefined ? '' : `${h.changeToday >= 0 ? '+' : ''}${(h.changeToday * 100).toFixed(2)}%`;
  return [h.symbol, qtyText(h.qty), h.avgEntryPrice === undefined ? '-' : money(h.avgEntryPrice), money(h.marketValue), change];
}

export function intentCells(i: IntentRow): string[] {
  return [i.symbol, i.side, i.quantity, i.broker, i.state, i.from, when(i.recorded_at), when(i.approved_at)];
}

const pad = (cells: string[], widths: number[]) => cells.map((c, j) => (j === cells.length - 1 ? c : c.padEnd(widths[j] ?? 0))).join('  ');
function widthsOf(rows: string[][], head: string[]): number[] {
  return head.map((h, j) => Math.max(h.length, ...rows.map((r) => (r[j] ?? '').length)));
}

export const HOLDING_HEAD = ['symbol', 'qty', 'avg cost', 'value', 'today'];
export const INTENT_HEAD = ['symbol', 'side', 'qty', 'broker', 'state', 'from', 'recorded', 'approved'];
export const POSITIONS_FOOT = 'Nothing here sends an order. Paper: primerkit intent <id> place. Live: primerkit intent approve <id>. Each at a terminal.';

export function positionsText(v: PositionsView): string[] {
  const out: string[] = [];
  if (v.holdings.kind === 'note') out.push(`Alpaca paper: ${v.holdings.text}`);
  else {
    out.push(`Alpaca paper holdings, read ${v.holdings.readAt.slice(11, 16)} UTC (mode ${v.holdings.mode.replace('_', ' ')}):`);
    if (!v.holdings.rows.length) out.push('  none held');
    const rows = v.holdings.rows.map(holdingCells);
    const w = widthsOf(rows, HOLDING_HEAD);
    out.push(`  ${pad(HOLDING_HEAD, w)}`, ...rows.map((r) => `  ${pad(r, w)}`));
  }
  out.push('', `Order intents (${v.intents.length}), newest at the top:`);
  if (!v.intents.length) out.push('  none yet');
  else {
    const rows = v.intents.map(intentCells);
    const w = widthsOf(rows, INTENT_HEAD);
    out.push(`  ${pad(INTENT_HEAD, w)}`, ...rows.map((r) => `  ${pad(r, w)}`));
  }
  out.push('', POSITIONS_FOOT);
  return out;
}

// The screen's body: the same tables, the day's change green or red by its sign.
export function positionsLines(t: Maker, v: PositionsView, room: number): Line[] {
  const lines: Line[] = [[t('dim', 'Alpaca paper holdings')]];
  if (v.holdings.kind === 'note') lines.push([t('muted', v.holdings.text.slice(0, room))]);
  else {
    const rows = v.holdings.rows.map(holdingCells);
    const w = widthsOf(rows, HOLDING_HEAD);
    lines.push([t('dim', pad(HOLDING_HEAD, w).slice(0, room))]);
    if (!rows.length) lines.push([t('muted', 'none held')]);
    v.holdings.rows.forEach((h, i) => {
      const cells = rows[i] ?? [];
      const head = pad(cells.slice(0, 4), w.slice(0, 4));
      const change = cells[4] ?? '';
      lines.push([t('fg', `${head}  `.slice(0, room)), ...(change ? [t((h.changeToday ?? 0) >= 0 ? 'up' : 'down', change)] : [])]);
    });
  }
  lines.push([], [t('dim', `order intents, ${v.intents.length}, newest at the top`)]);
  if (!v.intents.length) lines.push([t('muted', 'none yet')]);
  else {
    // Narrow windows keep the columns that say what each intent is.
    const cols = room >= 96 ? 8 : room >= 64 ? 6 : 4;
    const rows = v.intents.map((i) => intentCells(i).slice(0, cols));
    const w = widthsOf(rows, INTENT_HEAD.slice(0, cols));
    lines.push([t('dim', pad(INTENT_HEAD.slice(0, cols), w).slice(0, room))]);
    for (const r of rows) lines.push([t('fg', pad(r, w).slice(0, room))]);
  }
  return lines;
}
