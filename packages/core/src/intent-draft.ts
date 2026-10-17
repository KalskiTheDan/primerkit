import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { CheckResult } from './checks/index';
import { claimsOf } from './checks/shape';
import type { ForwardEntry } from './forward';
import { newIntentId, type Intent, type IntentExit, type IntentProvenance, type IntentSizing } from './intent';
import type { Routine } from './routine';

// From a routine's label to an order intent, and the person's sizing rule to an amount. The
// amount is computed here, by code, from the broker's own figures; the model only ever picks
// the label, and the label's target is the person's own, in routine.yaml.

// What the paper account holds now, as the broker gives it: its equity, and the quantity and
// dollars held of the intent's symbol.
export interface AccountFigures {
  equity: number;
  heldQty: number;
  heldValue: number;
}

export type Sized =
  | { kind: 'order'; side: 'buy' | 'sell'; notional: number | null; quantity: number | null; says: string }
  | { kind: 'none'; why: string };

// An order of less than a dollar is not made: a target already reached, give or take.
export const MIN_ORDER_DOLLARS = 1;

const cents = (n: number): number => Math.floor(n * 100) / 100;
// Alpaca takes a quantity to nine decimals; a sale never rounds up past what is held.
const nine = (n: number): number => Math.floor(n * 1e9) / 1e9;
const usd = (n: number): string => `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const pct = (share: number): string => `${Number((share * 100).toFixed(2))}%`;

// The amount the person's rule gives on the account as it stands. A buy is sized in dollars,
// so the person's caps hold at any price; a sale is sized in what is held. A target share
// buys or sells the difference, and a target of none sells all that is held.
export function sizeOf(side: 'buy' | 'sell' | 'hedge', sizing: IntentSizing, a: AccountFigures): Sized {
  if (!(Number.isFinite(a.equity) && a.equity > 0)) return { kind: 'none', why: `the account's equity is ${Number.isFinite(a.equity) ? usd(a.equity) : 'not known'}, so no share of it can be sized` };
  if (!(Number.isFinite(a.heldQty) && a.heldQty >= 0 && Number.isFinite(a.heldValue) && a.heldValue >= 0)) return { kind: 'none', why: 'what is held cannot be read from the account, so nothing can be sized' };
  if (side === 'hedge') return { kind: 'none', why: 'a hedge is sized with its own leg, which comes later' };
  const priceHeld = a.heldQty > 0 ? a.heldValue / a.heldQty : null;
  const sellDollars = (dollars: number, says: string): Sized => {
    if (!(a.heldQty > 0) || priceHeld === null) return { kind: 'none', why: 'nothing is held, and primerkit sells only what is held' };
    const quantity = dollars >= a.heldValue ? a.heldQty : nine(dollars / priceHeld);
    return quantity > 0 ? { kind: 'order', side: 'sell', notional: null, quantity, says } : { kind: 'none', why: `${usd(dollars)} is less than the smallest quantity Alpaca takes` };
  };
  switch (sizing.kind) {
    case 'fixed_notional': {
      const dollars = cents(sizing.dollars);
      return side === 'buy' ? { kind: 'order', side, notional: dollars, quantity: null, says: `${usd(dollars)}, your fixed amount` } : sellDollars(dollars, `${usd(dollars)} of what is held, your fixed amount`);
    }
    case 'fixed_quantity': {
      if (side !== 'sell') return { kind: 'none', why: 'a fixed quantity sells what is held only' };
      if (!(a.heldQty > 0)) return { kind: 'none', why: 'nothing is held, and primerkit sells only what is held' };
      const quantity = Math.min(sizing.quantity, a.heldQty);
      return { kind: 'order', side, notional: null, quantity, says: quantity < sizing.quantity ? `${quantity}, all that is held, where your rule says ${sizing.quantity}` : `${quantity}, your fixed quantity` };
    }
    case 'percent_of_equity': {
      const dollars = cents(sizing.share * a.equity);
      const says = `${usd(dollars)}, ${pct(sizing.share)} of equity of ${usd(a.equity)}`;
      return side === 'buy' ? { kind: 'order', side, notional: dollars, quantity: null, says } : sellDollars(dollars, says);
    }
    case 'risk_based': {
      if (side !== 'buy') return { kind: 'none', why: 'a size by risk to the stop buys only' };
      const dollars = cents((sizing.risk_share * a.equity) / sizing.stop_distance);
      return { kind: 'order', side, notional: dollars, quantity: null, says: `${usd(dollars)}: ${pct(sizing.risk_share)} of equity at risk, with the stop ${pct(sizing.stop_distance)} away` };
    }
    case 'target_share': {
      const target = sizing.share * a.equity;
      const gap = target - a.heldValue;
      const where = `${pct(sizing.share)} of equity of ${usd(a.equity)} is ${usd(target)}, and ${usd(a.heldValue)} is held`;
      if (sizing.share === 0) {
        return a.heldQty > 0 ? { kind: 'order', side: 'sell', notional: null, quantity: a.heldQty, says: `all ${a.heldQty} held, as your target is none` } : { kind: 'none', why: 'nothing is held, and the target is to hold none' };
      }
      if (Math.abs(gap) < MIN_ORDER_DOLLARS) return { kind: 'none', why: `the target is reached: ${where}` };
      return gap > 0 ? { kind: 'order', side: 'buy', notional: cents(gap), quantity: null, says: `${usd(cents(gap))} to buy: ${where}` } : sellDollars(-gap, `${usd(-gap)} to sell: ${where}`);
    }
  }
}

// What a routine's run kept in the journal, read for the intent's record: the lines its
// passing claims cited, and each check with its result. A claim the checks took out cites
// nothing here.
export function runRecord(dir: string): Pick<IntentProvenance, 'cited' | 'checks_passed'> {
  const read = <T>(name: string): T | null => (existsSync(join(dir, name)) ? (JSON.parse(readFileSync(join(dir, name), 'utf8')) as T) : null);
  const checks = read<CheckResult[]>('checks.json') ?? [];
  const reply = read<{ text?: string }>('response.repair.json') ?? read<{ text?: string }>('response.json');
  let parsed: unknown = null;
  try {
    parsed = reply?.text ? JSON.parse(reply.text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')) : null;
  } catch {
    parsed = null;
  }
  const failing = new Set(checks.flatMap((c) => c.failures.flatMap((f) => (f.claim === undefined ? [] : [f.claim]))));
  const cited = claimsOf(parsed)
    .filter((_, i) => !failing.has(i))
    .flatMap((c) => c.citations)
    .filter((c) => c.block && Number.isInteger(c.line) && c.line >= 1);
  return { cited, checks_passed: checks.map((c) => ({ check: c.id, passed: c.failures.length === 0 })) };
}

// How long a drafted intent stands before it expires, unless the caller says otherwise.
export const INTENT_MINUTES = 60;

export type Drafted = { kind: 'intent'; intent: Intent; sized: Sized } | { kind: 'none'; why: string };

// An intent from the routine's newest label, sized on the account as it stands. A label
// that keeps what is held, an answer that gave no label, a label older than the routine's
// own step, or a size of nothing drafts no intent, and says why. The symbol's asset class is
// left for the checks to read from the broker's own asset list.
export function draftFromRoutine(o: { routine: Routine; entry: ForwardEntry; run: Pick<IntentProvenance, 'cited' | 'checks_passed'> | null; account: AccountFigures; now: Date; venue: string; minutes?: number }): Drafted {
  const { routine, entry } = o;
  const name = routine.spec.name;
  if (entry.label === null) return { kind: 'none', why: `${name}'s last run, at ${entry.at}, gave no label: its answer failed its checks twice` };
  if (entry.target === null) return { kind: 'none', why: `${name}'s label ${entry.label} keeps what is held, so there is no order to draft` };
  const step = routine.spec.every === 'week' ? 7 * 86_400_000 : 86_400_000;
  if (o.now.getTime() - Date.parse(entry.at) > step) return { kind: 'none', why: `${name}'s newest label, ${entry.label}, is from ${entry.at}, older than its ${routine.spec.every}: primerkit routine ${name} track runs it again` };
  const sizing: IntentSizing = { kind: 'target_share', share: entry.target };
  const sized = sizeOf('buy', sizing, o.account);
  if (sized.kind === 'none') return { kind: 'none', why: sized.why };
  // The routine's standing exit, the person's own, goes with a buy: it closes what the buy got.
  const re = routine.spec.exit;
  const exit: IntentExit | null =
    re && sized.side === 'buy'
      ? re.kind === 'stop'
        ? { stop: { kind: 'distance', share: re.share }, ...(re.gap !== null ? { stop_limit_gap: re.gap } : {}), standing: true }
        : { target: { kind: 'distance', share: re.share }, standing: true }
      : null;
  const created = o.now.toISOString();
  const intent: Intent = {
    intent_version: 1,
    intent_id: newIntentId(o.now),
    created_at: created,
    expires_at: new Date(o.now.getTime() + (o.minutes ?? INTENT_MINUTES) * 60_000).toISOString(),
    source: { kind: 'routine', routine: name, tick: entry.at },
    instrument: { symbol: routine.spec.symbol, asset_class: null, venue: o.venue },
    side: sized.side,
    leg_of: null,
    sizing,
    entry: { kind: 'market' },
    exit,
    option: null,
    provenance: {
      thesis: `${name}, rules ${entry.rulesHash.slice(0, 12)}, label ${entry.label}`,
      run_id: entry.runId,
      cited: o.run?.cited ?? [],
      generated: entry.reads.flatMap((r) => (r.generatedAt ? [r.generatedAt] : [])),
      checks_passed: o.run?.checks_passed ?? [],
      model: entry.model,
      data_as_of: entry.close.date,
    },
  };
  return { kind: 'intent', intent, sized };
}
