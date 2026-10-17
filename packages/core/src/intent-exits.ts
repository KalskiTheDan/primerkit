import type { IntentExit, IntentLevel } from './intent';

// The standing exits of answer B to the order intent design: a stop or a target the person set, shown at the
// entry's yes, which rests at the broker once the entry fills and closes the position at
// paper without a second yes. Its price is the person's own, from the fill and the broker's
// quotes; a PreReason event is never an exit. For crypto, Alpaca rests one exit at a time, as
// a resting sell holds the quantity it sells: a stop, as a stop-limit order, or a target, as
// a limit order. A US stock's pair of exits comes in a later step.

const pct = (share: number): string => `${Number((share * 100).toFixed(2))}%`;
const usd = (n: number): string => `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const level = (l: IntentLevel, way: 'below' | 'above'): string => (l.kind === 'price' ? `at ${usd(l.price)}` : `${pct(l.share)} ${way} the fill price`);

// The exit in words, as the person sees it at the yes.
export function exitWords(exit: IntentExit): string {
  if (exit.stop) return `a stop ${level(exit.stop, 'below')}, sent as a stop-limit order${exit.stop_limit_gap !== undefined ? ` with its limit ${pct(exit.stop_limit_gap)} below the stop` : ''}`;
  if (exit.target) return `a target ${level(exit.target, 'above')}, sent as a limit order`;
  return exit.rule ? `the routine's exit label ${exit.rule}` : exit.time ? 'a time to close' : 'no exit';
}

// Why an intent's exit cannot stand as it is, or null where it can.
export function exitProblem(exit: IntentExit | null, side: string, assetClass: string | null): string | null {
  if (!exit) return null;
  if (!exit.standing || exit.rule || exit.time) return 'only a standing stop or target is placed for now; an exit by a rule or a time comes later';
  if (side !== 'buy') return 'a standing exit goes with a buy, to close what it bought';
  if (assetClass !== 'crypto') return `standing exits on ${assetClass ?? 'this asset'} come in a later step; crypto's come now`;
  if (exit.stop && exit.target) return 'Alpaca rests one exit at a time for crypto, as each holds the quantity it sells: a stop or a target, not both';
  if (exit.stop && exit.stop_limit_gap === undefined) return "a crypto stop is a stop-limit order, and it needs your stop_limit_gap: how far below the stop its limit sits, in routine.yaml's exits";
  return null;
}

const cents = (n: number): number => Math.round(n * 100) / 100;

export type ExitOrder = { type: 'stop_limit'; stopPrice: number; limitPrice: number } | { type: 'limit'; limitPrice: number };

// The resting order for the exit, from the price the entry filled at: a stop below it, as a
// stop-limit, or a target above it, as a limit. null where its prices would not be a sale.
export function exitOrder(exit: IntentExit, fillPrice: number): ExitOrder | null {
  if (!(Number.isFinite(fillPrice) && fillPrice > 0)) return null;
  if (exit.stop) {
    const stopPrice = cents(exit.stop.kind === 'price' ? exit.stop.price : fillPrice * (1 - exit.stop.share));
    const limitPrice = cents(stopPrice * (1 - (exit.stop_limit_gap ?? 0)));
    return stopPrice > 0 && stopPrice < fillPrice && limitPrice > 0 && limitPrice <= stopPrice ? { type: 'stop_limit', stopPrice, limitPrice } : null;
  }
  if (exit.target) {
    const limitPrice = cents(exit.target.kind === 'price' ? exit.target.price : fillPrice * (1 + exit.target.share));
    return limitPrice > fillPrice ? { type: 'limit', limitPrice } : null;
  }
  return null;
}
