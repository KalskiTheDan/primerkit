import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { Journal, JournalRun } from './journal';
import { RUN_ID, newRunId } from './packet';

// A live order intent, for an order an AI app would place through a broker's own server, such
// as Robinhood's. primerkit itself sends no order to that broker: it keeps the intent in the
// journal as pending, and only the person's yes, typed at a terminal (primerkit intent approve
// <id>), marks it approved. The trade skill places nothing until the intent reads approved,
// and the broker's own trade approvals ask again in its app. Each intent is one order, from an
// order the person typed or rules the person wrote; never one the model proposed.

export const LIVE_INTENT_OPERATION = 'live-intent';
export const LIVE_BROKERS = ['robinhood'] as const;
export type LiveBroker = (typeof LIVE_BROKERS)[number];
// How long an intent waits for the yes, and how long an approved one stands.
export const LIVE_INTENT_MINUTES = 60;

export interface LiveIntent {
  intent_id: string;
  version: 1;
  broker: LiveBroker;
  created_at: string;
  expires_at: string;
  symbol: string;
  side: 'buy' | 'sell';
  quantity: number;
  order_type: 'market' | 'limit';
  limit_price: number | null;
  // Where the order came from: an order the person typed, or rules the person wrote, named.
  // Nothing else: an intent carries no link to a PreReason answer, so no answer stands as an
  // order's reason, even in the local journal.
  source: { kind: 'typed' } | { kind: 'rules'; rules: string };
}

export interface LiveApproval {
  approved_at: string;
  by: 'a yes typed at a terminal';
}

export type LiveIntentState = 'pending' | 'approved' | 'expired';

export interface LiveIntentRecord {
  intent: LiveIntent;
  state: LiveIntentState;
  approval: LiveApproval | null;
  dir: string;
}

export class LiveIntentError extends Error {}

const SYMBOL = /^[A-Z][A-Z0-9.]{0,9}$/;

export interface LiveIntentInput {
  broker?: string;
  symbol?: unknown;
  side?: unknown;
  quantity?: unknown;
  order_type?: unknown;
  limit_price?: unknown;
  source?: unknown; // 'typed' or 'rules'
  rules?: unknown; // the rules' name, where source is rules
}

// The problems with an intent as given, in words; none means it can be kept.
export function liveIntentProblems(input: LiveIntentInput): string[] {
  const problems: string[] = [];
  if ((input.broker ?? 'robinhood') !== 'robinhood') problems.push('broker: robinhood is the one live broker primerkit keeps intents for');
  if (typeof input.symbol !== 'string' || !SYMBOL.test(input.symbol.trim().toUpperCase())) problems.push('symbol: a ticker such as AAPL');
  if (input.side !== 'buy' && input.side !== 'sell') problems.push('side: buy or sell');
  const q = input.quantity;
  if (typeof q !== 'number' || !Number.isFinite(q) || q <= 0 || Math.round(q * 1e6) !== q * 1e6) problems.push('quantity: a number of shares above 0, to at most six decimals');
  const type = input.order_type ?? 'market';
  if (type !== 'market' && type !== 'limit') problems.push('order_type: market or limit');
  if (type === 'limit' && (typeof input.limit_price !== 'number' || !Number.isFinite(input.limit_price) || input.limit_price <= 0)) problems.push('limit_price: a price above 0, for a limit order');
  if (type === 'market' && input.limit_price !== undefined && input.limit_price !== null) problems.push('limit_price: for a limit order, not a market order');
  if (input.source !== 'typed' && input.source !== 'rules') problems.push('source: typed, for an order the person typed, or rules, for one from rules the person wrote');
  if (input.source === 'rules' && (typeof input.rules !== 'string' || !input.rules.trim())) problems.push('rules: the name of the rules the order came from');
  return problems;
}

// Keeps the intent as pending, and returns it with its folder.
export function recordLiveIntent(journal: Journal, input: LiveIntentInput, now = new Date()): LiveIntentRecord {
  const problems = liveIntentProblems(input);
  if (problems.length) throw new LiveIntentError(`The intent was not kept: ${problems.join('; ')}.`);
  const id = newRunId(now);
  const type = (input.order_type ?? 'market') as LiveIntent['order_type'];
  const intent: LiveIntent = {
    intent_id: id,
    version: 1,
    broker: 'robinhood',
    created_at: now.toISOString(),
    expires_at: new Date(now.getTime() + LIVE_INTENT_MINUTES * 60_000).toISOString(),
    symbol: (input.symbol as string).trim().toUpperCase(),
    side: input.side as LiveIntent['side'],
    quantity: input.quantity as number,
    order_type: type,
    limit_price: type === 'limit' ? (input.limit_price as number) : null,
    source: input.source === 'rules' ? { kind: 'rules', rules: (input.rules as string).trim() } : { kind: 'typed' },
  };
  const run = journal.open(LIVE_INTENT_OPERATION, id, now);
  run.write('intent.json', intent);
  return { intent, state: 'pending', approval: null, dir: run.dir };
}

// The intent's folder, looked for in every day of the journal; null where there is none.
export function findLiveIntent(root: string, id: string): string | null {
  if (!RUN_ID.test(id)) return null;
  const days = (() => {
    try {
      return daysIn(root);
    } catch {
      return [];
    }
  })();
  for (const day of days) {
    const dir = join(root, day, LIVE_INTENT_OPERATION, id);
    if (existsSync(join(dir, 'intent.json'))) return dir;
  }
  return null;
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const daysIn = (root: string): string[] => readdirSync(root).filter((d) => DAY.test(d)).sort().reverse();

export function readLiveIntent(dir: string, now = new Date()): LiveIntentRecord {
  const intent = JSON.parse(readFileSync(join(dir, 'intent.json'), 'utf8')) as LiveIntent;
  const approvalFile = join(dir, 'approval.json');
  const approval = existsSync(approvalFile) ? (JSON.parse(readFileSync(approvalFile, 'utf8')) as LiveApproval) : null;
  const expired = now.getTime() >= Date.parse(intent.expires_at);
  return { intent, state: expired ? 'expired' : approval ? 'approved' : 'pending', approval, dir };
}

// The person's yes, kept beside the intent. Called only after a yes typed at a terminal; an
// expired intent, or one approved already, is refused, and the file is never written over.
export function approveLiveIntent(dir: string, now = new Date()): LiveIntentRecord {
  const record = readLiveIntent(dir, now);
  if (record.state === 'expired') throw new LiveIntentError(`The intent ${record.intent.intent_id} expired at ${record.intent.expires_at.slice(11, 16)} UTC. Record the order again.`);
  if (record.state === 'approved') throw new LiveIntentError(`The intent ${record.intent.intent_id} is approved already.`);
  new JournalRun(dir).write('approval.json', { approved_at: now.toISOString(), by: 'a yes typed at a terminal' } satisfies LiveApproval);
  return readLiveIntent(dir, now);
}

// Every live intent in the journal, newest first.
export function listLiveIntents(root: string, now = new Date()): LiveIntentRecord[] {
  let days: string[];
  try {
    days = daysIn(root);
  } catch {
    return [];
  }
  const out: LiveIntentRecord[] = [];
  for (const day of days) {
    const folder = join(root, day, LIVE_INTENT_OPERATION);
    let ids: string[];
    try {
      ids = idsIn(folder);
    } catch {
      continue;
    }
    for (const id of ids.sort().reverse()) {
      try {
        out.push(readLiveIntent(join(folder, id), now));
      } catch {
        // An intent that cannot be read is not listed.
      }
    }
  }
  return out;
}

const idsIn = (folder: string): string[] => readdirSync(folder).filter((id) => RUN_ID.test(id) && existsSync(join(folder, id, 'intent.json')));

// One intent in words, as the person reads it before the yes.
export function liveIntentLines(r: LiveIntentRecord): string[] {
  const i = r.intent;
  const price = i.order_type === 'limit' ? `a limit order at $${i.limit_price}` : 'a market order';
  return [
    `Intent ${i.intent_id}: ${i.side} ${i.quantity} ${i.symbol}, ${price}, through Robinhood's own server, in its separate agent account.`,
    `From: ${i.source.kind === 'typed' ? 'an order you typed' : `your rules, ${i.source.rules}`}.`,
    `State: ${r.state}${r.approval ? `, approved ${r.approval.approved_at.slice(0, 16).replace('T', ' ')} UTC` : ''}. It expires ${i.expires_at.slice(0, 16).replace('T', ' ')} UTC.`,
  ];
}
