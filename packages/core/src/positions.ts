import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { readIntent, type IntentRecord, type IntentSizing } from './intent';
import { listLiveIntents } from './live-intent';

// Every order intent in the journal, read back for the positions screen: Alpaca paper intents
// (drafted from a routine's label, an answer or by hand) and Robinhood live intents (recorded by
// the trade skill). Read only: nothing here sends, approves or changes an intent.

export interface IntentRow {
  id: string;
  broker: 'Alpaca paper' | 'Robinhood live';
  symbol: string;
  side: string;
  quantity: string; // as the intent sizes it: "2", "$25", "5% of equity"
  from: string; // "an order you typed", "rules: my-rules", "routine btc-rules"
  recorded_at: string;
  approved_at: string | null;
  state: string;
}

const percent = (share: number) => `${Number((share * 100).toFixed(2))}%`;

export function sizingText(s: IntentSizing): string {
  if (s.kind === 'fixed_quantity') return String(s.quantity);
  if (s.kind === 'fixed_notional') return `$${s.dollars.toLocaleString('en-US')}`;
  if (s.kind === 'percent_of_equity') return `${percent(s.share)} of equity`;
  if (s.kind === 'target_share') return `to ${percent(s.share)} of equity`;
  return `risk ${percent(s.risk_share)}`;
}

function alpacaRow(r: IntentRecord): IntentRow {
  const i = r.intent;
  const from = i.source.kind === 'routine' ? `routine ${i.source.routine}` : i.source.kind === 'ask' ? 'an answer you asked for' : i.source.kind === 'webhook' ? `webhook ${i.source.name}` : 'an order you typed';
  return { id: i.intent_id, broker: 'Alpaca paper', symbol: i.instrument.symbol, side: i.side, quantity: sizingText(i.sizing), from, recorded_at: i.created_at, approved_at: r.approval?.at ?? null, state: r.state };
}

const dirs = (path: string): string[] => {
  try {
    return readdirSync(path).filter((d) => statSync(join(path, d)).isDirectory());
  } catch {
    return [];
  }
};

// Newest first, both brokers together.
export function intentRows(root: string, now = new Date()): IntentRow[] {
  const rows: IntentRow[] = [];
  for (const day of dirs(root)) {
    const folder = join(root, day, 'intent');
    for (const id of existsSync(folder) ? dirs(folder) : []) {
      try {
        rows.push(alpacaRow(readIntent(join(folder, id), now)));
      } catch {
        // An intent folder still being written is not listed.
      }
    }
  }
  for (const r of listLiveIntents(root, now)) {
    const i = r.intent;
    rows.push({
      id: i.intent_id,
      broker: 'Robinhood live',
      symbol: i.symbol,
      side: i.side,
      quantity: `${i.quantity}${i.order_type === 'limit' ? ` at $${i.limit_price}` : ''}`,
      from: i.source.kind === 'typed' ? 'an order you typed' : `rules: ${i.source.rules}`,
      recorded_at: i.created_at,
      approved_at: r.approval?.approved_at ?? null,
      state: r.state,
    });
  }
  return rows.sort((a, b) => b.recorded_at.localeCompare(a.recorded_at));
}

