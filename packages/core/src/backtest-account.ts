import type { Close } from './routine';

// The simulated account a backtest trades: cash and BTC/USD units in a notional $10,000,
// long or flat. All code, no model. A label becomes a target share of the account through
// the person's routine.yaml, the order is the difference from what is held, and it fills
// at the next day's close with the person's fee taken off. No leverage, nothing short.

export const START_EQUITY = 10_000;

export interface Holdings {
  cash: number;
  units: number;
  entry: { date: string; price: number } | null; // when it went long from flat, and at what
}

export const startHoldings = (): Holdings => ({ cash: START_EQUITY, units: 0, entry: null });

export const equityOf = (h: Holdings, price: number): number => h.cash + h.units * price;

export interface Fill {
  date: string;
  price: number;
  fromShare: number;
  toShare: number;
  units: number; // bought, or sold when negative
  fee: number; // in the account's dollars
}

// The holdings moved to a target share of the account at a price, the fee taken off so
// that the share held after it is the target. Buying, the fee is f(sE - H)/(1 + fs), and
// selling f(H - sE)/(1 - fs), where E is the account, H what is held and s the target: at
// a target of 1 the cash comes to exactly nothing. A target within a hair of what is
// held places no order.
export function fillTo(h: Holdings, share: number, price: number, feeRate: number, date: string): { holdings: Holdings; fill: Fill | null } {
  const equity = equityOf(h, price);
  const held = h.units * price;
  const want = share * equity;
  if (equity <= 0 || Math.abs(want - held) <= equity * 1e-9) return { holdings: h, fill: null };
  const fee = want > held ? (feeRate * (want - held)) / (1 + feeRate * share) : (feeRate * (held - want)) / (1 - feeRate * share);
  const units = (share * (equity - fee)) / price;
  const bought = units - h.units;
  const cash = h.cash - bought * price - fee;
  const entry = units <= 0 ? null : h.units > 0 ? h.entry : { date, price };
  return {
    holdings: { cash: Math.abs(cash) < 1e-9 ? 0 : cash, units, entry },
    fill: { date, price, fromShare: held / equity, toShare: share, units: bought, fee },
  };
}

// The account at each day's close, and the share of it held.
export interface Mark {
  date: string;
  equity: number;
  share: number;
}

// The account marked at every close from `from` to `to`, each change of holdings applied
// on the day it filled. Days between ticks are marked too, so a weekly routine still has
// a daily line.
export function curveOf(closes: Close[], changes: Array<{ date: string; holdings: Holdings }>, from: string, to: string): Mark[] {
  const ordered = [...changes].sort((a, b) => a.date.localeCompare(b.date));
  let held = startHoldings();
  let next = 0;
  const marks: Mark[] = [];
  for (const c of closes) {
    if (c.date < from || c.date > to) continue;
    while (next < ordered.length && (ordered[next] as { date: string }).date <= c.date) held = (ordered[next++] as { holdings: Holdings }).holdings;
    const equity = equityOf(held, c.price);
    marks.push({ date: c.date, equity, share: equity > 0 ? (held.units * c.price) / equity : 0 });
  }
  return marks;
}

export interface ArmStats {
  return: number; // the account at the end against its start, as a share: 0.12 is +12%
  maxDrawdown: number; // the largest fall from a high, as a share
  trades: number;
  daysInMarket: number;
  days: number;
  fees: number; // every fee paid, as a share of the starting account
  failedTicks: number;
}

export function statsOf(curve: Mark[], fills: Fill[], failedTicks: number): ArmStats {
  let peak = START_EQUITY;
  let maxDrawdown = 0;
  for (const m of curve) {
    peak = Math.max(peak, m.equity);
    maxDrawdown = Math.max(maxDrawdown, (peak - m.equity) / peak);
  }
  const end = curve.at(-1)?.equity ?? START_EQUITY;
  return {
    return: end / START_EQUITY - 1,
    maxDrawdown,
    trades: fills.length,
    daysInMarket: curve.filter((m) => m.share > 0).length,
    days: curve.length,
    fees: fills.reduce((s, f) => s + f.fee, 0) / START_EQUITY,
    failedTicks,
  };
}
