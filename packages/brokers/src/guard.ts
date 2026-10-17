import { randomUUID } from 'node:crypto';
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, statSync, writeSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { BrokerError, heldAs, isCrypto, modeProblem, SETTLED, type Account, type AlpacaBroker, type BrokerMode, type OrderBody, type OrderIntent, type PlacedOrder, type Position } from './alpaca';

// Every order goes through the guard: the person's own caps, the broker's order body
// shown in full, a yes for each order, and stop conditions that turn the connection off
// until the person turns it back on by hand. Every event is appended to a local log.

export interface Caps {
  maxNotional: number; // dollars an order may carry, above 0
  maxPositionShare: number; // of equity one symbol may reach after the fill, above 0 and at most 1
  symbols: string[]; // the only symbols an order may name
  maxOrdersPerDay: number; // a whole number above 0
  maxExposureShare?: number; // optional: of equity all positions together may reach after a buy
  groups?: Array<{ name: string; symbols: string[]; maxShare: number }>; // optional: symbols that move together, and the share of equity they may reach
}

const shown = (v: unknown): string => (v === undefined || v === null ? 'is missing' : `is ${JSON.stringify(v)}`);
const positive = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v > 0;

// What makes a caps block unusable, named as config.yaml names it. A cap that is missing
// or not a number compares false, which would let every order through, so the guard
// refuses every order until all four are usable.
export function capsProblems(caps: { [K in keyof Caps]?: unknown }): string[] {
  const problems: string[] = [];
  if (!positive(caps.maxNotional)) problems.push(`max_notional ${shown(caps.maxNotional)}, where it takes the dollars an order may carry, above 0`);
  if (!positive(caps.maxPositionShare) || caps.maxPositionShare > 1) problems.push(`max_position_share ${shown(caps.maxPositionShare)}, where it takes the share of equity one symbol may reach, above 0 and at most 1`);
  const symbols = caps.symbols;
  if (!Array.isArray(symbols) || !symbols.length || !symbols.every((s) => typeof s === 'string' && s.trim() !== '')) problems.push(`symbols ${shown(symbols)}, where it takes a list such as [BTC/USD]`);
  if (!positive(caps.maxOrdersPerDay) || !Number.isInteger(caps.maxOrdersPerDay)) problems.push(`max_orders_per_day ${shown(caps.maxOrdersPerDay)}, where it takes a whole number above 0`);
  // The two optional caps, where given, must be usable too.
  if (caps.maxExposureShare !== undefined && (!positive(caps.maxExposureShare) || caps.maxExposureShare > 1)) problems.push(`max_exposure_share ${shown(caps.maxExposureShare)}, where it takes the share of equity all positions together may reach, above 0 and at most 1`);
  if (caps.groups !== undefined) {
    const groups = caps.groups;
    const usable = Array.isArray(groups) && groups.every((g) => g && typeof g === 'object' && typeof (g as { name?: unknown }).name === 'string' && Array.isArray((g as { symbols?: unknown }).symbols) && (g as { symbols: unknown[] }).symbols.length > 0 && (g as { symbols: unknown[] }).symbols.every((s) => typeof s === 'string' && s.trim() !== '') && positive((g as { maxShare?: unknown }).maxShare) && (g as { maxShare: number }).maxShare <= 1);
    if (!usable) problems.push(`groups ${shown(groups)}, where each takes a name, its symbols, and the share of equity they may reach together, above 0 and at most 1`);
  }
  return problems;
}

export interface StopRules {
  failures: number; // failed orders in a row that turn the connection off
  driftShare: number; // how far the log's record may differ from the broker's, 0 to 1
}

export const STOP_RULES: StopRules = { failures: 3, driftShare: 0.05 };

// Alpaca's fee on a crypto purchase, up to 0.25% of what fills. Alpaca takes it in the coin,
// so a little less is held than filled: a $10 paper purchase of BTC/USD filled 0.000117715
// and left 0.00011742 held. No answer primerkit reads names the fee: the order gives what
// filled and the position what is held. So a crypto purchase that leaves less held than it
// filled, by no more than this share of the fill, is counted as the fee, not as drift.
export const CRYPTO_FEE_SHARE = 0.0025;
// A quantity is counted in Alpaca's nine decimals, and the fee to the ninth, rounded up:
// that purchase's was 0.000000295, where 0.25% of its fill is 0.000000294288.
const NINTHS = 1e9;

// A lock left by a run that died is taken over once it is older than any order takes.
export const LOCK_STALE_MS = 5 * 60_000;
// How far ahead of this clock a lock's time may be and still be a fresh lock.
export const LOCK_AHEAD_MS = 60_000;

export interface Drift {
  symbol: string; // as Alpaca names it: "BTCUSD"
  expected: number;
  held: number;
  // A crypto purchase that left less held than the log expects: by how much, and whether
  // that is within Alpaca's fee on what it filled. Within it, the difference is the fee.
  short?: { by: number; withinFee: boolean };
}

// An order is logged as it is sent (sending, with what was held of its symbol just
// before), and again with its outcome: placed, failed (Alpaca said no), or unknown (no
// readable answer came, so Alpaca may hold it). For an order by quantity, placed keeps
// what should be held after it (expected); an order in dollars has no expected quantity
// until Alpaca says how much filled, so its expected is null. withdrawn closes a sending
// line whose order never went: another run's order or a stop came in before it.
export type LogEvent =
  | { event: 'checked'; intent: OrderIntent; body: OrderBody | null; refused: string[] }
  | { event: 'dry_run'; body: OrderBody }
  | { event: 'declined'; body: OrderBody }
  | { event: 'sending'; body: OrderBody; before: number }
  | { event: 'withdrawn'; body: OrderBody; reason: string }
  | { event: 'placed'; body: OrderBody; order: PlacedOrder; expected: number | null; before?: number }
  | { event: 'failed'; body: OrderBody; error: string }
  | { event: 'unknown'; body: OrderBody; error: string }
  | { event: 'reconciled'; drift: Drift[]; waiting?: string[] }
  | { event: 'disabled'; reason: string }
  | { event: 'enabled' };

type Logged<E extends LogEvent['event']> = Extract<LogEvent, { event: E }> & { at: string };

// The append only log: one JSON object a line, never rewritten.
export class BrokerLog {
  constructor(readonly path: string) {}

  append(event: LogEvent, at = new Date()): void {
    mkdirSync(dirname(this.path), { recursive: true });
    appendFileSync(this.path, `${JSON.stringify({ at: at.toISOString(), ...event })}\n`);
  }

  read(): Array<LogEvent & { at: string }> {
    if (!existsSync(this.path)) return [];
    return readFileSync(this.path, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l) as LogEvent & { at: string });
  }

  // Off after a stop condition, until turned back on by hand.
  disabled(): string | null {
    let reason: string | null = null;
    for (const e of this.read()) {
      if (e.event === 'disabled') reason = e.reason;
      if (e.event === 'enabled') reason = null;
    }
    return reason;
  }

  // Orders that were sent and whose outcome the log does not hold: Alpaca may have taken
  // them. Each stays here until the log says placed or failed for it, or that it never went.
  pending(): Array<Logged<'sending'>> {
    const open = new Map<string, Logged<'sending'>>();
    for (const e of this.read()) {
      if (e.event === 'sending') open.set(e.body.client_order_id, e);
      if (e.event === 'placed' || e.event === 'failed' || e.event === 'withdrawn') open.delete(e.body.client_order_id);
    }
    return [...open.values()];
  }

  // The orders that went to Alpaca on a UTC day and that Alpaca did not refuse: one whose
  // outcome is unknown counts, since it may stand. An order counts on the day it was sent,
  // once, though its outcome may be written the next day.
  sentOn(day: string): number {
    const sent = new Map<string, string>();
    const refused = new Set<string>();
    for (const e of this.read()) {
      if ((e.event === 'sending' || e.event === 'placed') && !sent.has(e.body.client_order_id)) sent.set(e.body.client_order_id, e.at.slice(0, 10));
      if (e.event === 'failed' || e.event === 'withdrawn') refused.add(e.body.client_order_id);
    }
    return [...sent].filter(([id, on]) => on === day && !refused.has(id)).length;
  }

  // Orders Alpaca refused in a row, since the connection was last turned on by hand.
  failedInARow(): number {
    let failures = 0;
    for (const e of this.read()) {
      if (e.event === 'enabled' || e.event === 'placed') failures = 0;
      if (e.event === 'failed') failures += 1;
    }
    return failures;
  }

  // What other runs wrote from a line of the log on that an order checked before that line
  // could not have counted: another order sent (and not withdrawn), or a stop. null: none.
  cameIn(from: number, own: string): string | null {
    const lines = this.read().slice(from);
    const withdrawn = new Set<string>();
    for (const e of lines) if (e.event === 'withdrawn') withdrawn.add(e.body.client_order_id);
    for (const e of lines) {
      if (e.event === 'sending' && e.body.client_order_id !== own && !withdrawn.has(e.body.client_order_id)) return `another primerkit run sent an order (${e.body.client_order_id}) while this one was being checked`;
      if (e.event === 'disabled') return `the connection was turned off while this order was being checked (${e.reason})`;
    }
    return null;
  }

  get lockPath(): string {
    return `${this.path}.lock`;
  }

  // The kill switch: a file named STOP beside the log. While it is there, no order goes, a
  // dry run included. The person, or any program of theirs, makes it; deleting it lets
  // orders go again.
  get stopPath(): string {
    return join(dirname(this.path), 'STOP');
  }

  killSwitch(): string | null {
    return existsSync(this.stopPath) ? this.stopPath : null;
  }

  // Held by a run for the instant it takes a dead run's lock away.
  get takeoverPath(): string {
    return `${this.lockPath}.takeover`;
  }

  // Whether what is at a path was left by a dead run; null where nothing can be read
  // there. Fresh: made within the last five minutes. A file's time is finer than the clock
  // read here, and two clocks can differ a little, so a time up to a minute ahead is a
  // fresh one; only one dated further ahead than that is a dead run's.
  private dead(path: string): boolean | null {
    let age: number;
    try {
      age = Date.now() - statSync(path).mtimeMs;
    } catch {
      return null;
    }
    return !(age > -LOCK_AHEAD_MS && age < LOCK_STALE_MS);
  }

  // One order at a time: a file beside the log that only one run can make. The run that
  // made it gets the function that takes it away; any other gets null. Each lock holds
  // its maker's own token, and a run takes away only a lock that still holds its own.
  //
  // A lock a dead run left (older than any order takes, or dated more than a minute ahead)
  // is taken away by one run at a time: the run that makes the takeover file, which then
  // looks at the lock again and removes it only if it is still a dead run's. Looking and
  // removing with nothing between them would let a second run remove the lock the first
  // had just made in the dead one's place, and both would hold it.
  lock(): (() => void) | null {
    mkdirSync(dirname(this.path), { recursive: true });
    const token = `${process.pid} ${randomUUID()} ${new Date().toISOString()}\n`;
    // true: made, and this run's. false: it is there already. null: it cannot be made (a
    // folder with no access, a full disk), and the order waits, rather than fail after the yes.
    const make = (path: string): boolean | null => {
      try {
        const fd = openSync(path, 'wx');
        try {
          writeSync(fd, token);
        } finally {
          closeSync(fd);
        }
        return true;
      } catch (error) {
        return (error as NodeJS.ErrnoException).code === 'EEXIST' ? false : null;
      }
    };
    const takeAway = (path: string) => {
      try {
        if (readFileSync(path, 'utf8') === token) rmSync(path, { force: true });
      } catch {
        // gone, or not a file this run made: nothing of ours to take away
      }
    };
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const made = make(this.lockPath);
      if (made) return () => takeAway(this.lockPath);
      if (made === null) return null;
      const dead = this.dead(this.lockPath);
      if (dead === null) continue; // it went away in between: try once more
      if (!dead) return null;
      const taking = make(this.takeoverPath);
      if (!taking) {
        // Another run is taking the lock away this instant, and the lock is that run's to
        // make. A takeover file is held for an instant, so one as old as a dead lock was
        // left by a run that died in that instant: it is removed, for the next run.
        try {
          if (taking === false && this.dead(this.takeoverPath)) rmSync(this.takeoverPath, { recursive: true, force: true });
        } catch {
          // it cannot be removed: the refusal names the lock, and this file is beside it
        }
        return null;
      }
      try {
        if (this.dead(this.lockPath)) rmSync(this.lockPath, { recursive: true, force: true });
      } catch {
        return null; // it cannot be removed, so it stays, and it is named to the person
      } finally {
        takeAway(this.takeoverPath);
      }
    }
    return null;
  }
}

export interface Checked {
  body: OrderBody | null;
  estimate: number | null; // the order's dollars, as far as they can be known
  refused: string[]; // why it may not go; empty when it may
}

export interface GuardOptions {
  broker: Pick<AlpacaBroker, 'account' | 'positions' | 'orderBody' | 'place' | 'order' | 'orderByClientId'>;
  mode: BrokerMode;
  caps: Caps | null; // null until the person sets their own
  log: BrokerLog;
  stop?: StopRules;
  now?: () => Date;
}

export type Outcome = 'refused' | 'dry_run' | 'declined' | 'placed' | 'failed' | 'unknown';

export class OrderGuard {
  constructor(private readonly o: GuardOptions) {}

  private now(): Date {
    return this.o.now?.() ?? new Date();
  }

  // What would be sent, and every reason it may not go. A buy is sized in dollars, so the
  // dollar caps hold at any price. A sell takes dollars or a quantity, never more than is
  // held, and a quantity is valued at the price Alpaca's own figures give. Before each
  // order the log's record is compared with the broker's holdings, so drift stops the
  // order it would come before.
  async check(intent: OrderIntent): Promise<{ checked: Checked; account: Account | null; positions: Position[] }> {
    const refused: string[] = [];
    const mode = modeProblem(this.o.mode);
    if (mode) refused.push(`${mode}, so no order goes`);
    const killed = this.o.log.killSwitch();
    if (killed) refused.push(`the kill switch is on: ${killed} is there, and no order goes while it is. Delete it to let orders go again`);
    const off = this.o.log.disabled();
    if (off) refused.push(`the connection is off since a stop condition: ${off}. primerkit broker enable turns it back on`);
    if (this.o.mode === 'off' || this.o.mode === 'read') refused.push(`the connection is in ${this.o.mode} mode, which places no orders`);
    const pending = this.o.log.pending();
    if (pending.length) refused.push(`an order primerkit sent has no outcome on record (${pending.map((e) => e.body.client_order_id).join(', ')}): primerkit broker reconcile asks Alpaca for it`);
    let body: OrderBody | null = null;
    try {
      body = this.o.broker.orderBody(intent, `primerkit-${this.now().getTime().toString(36)}-${randomUUID().slice(0, 8)}`);
    } catch (error) {
      refused.push((error as Error).message);
    }
    let account: Account | null = null;
    let positions: Position[] = [];
    try {
      [account, positions] = await Promise.all([this.o.broker.account(), this.o.broker.positions()]);
    } catch (error) {
      refused.push(`the account could not be read: ${(error as Error).message}`);
    }
    if (account && account.status !== 'ACTIVE') refused.push(`the account is ${account.status}, not ACTIVE`);
    const equity = account && Number.isFinite(account.equity) && account.equity > 0 ? account.equity : null;
    if (account && equity === null) refused.push(`the account's equity ${Number.isFinite(account.equity) ? `is $${account.equity.toFixed(2)}` : "is not in Alpaca's answer"}, so the share of equity an order reaches cannot be checked`);
    // A placed order keeps what was held of its symbol before it, so that must be known.
    const holding = positions.find((p) => heldAs(p.symbol) === heldAs(intent.symbol));
    const unread = Boolean(holding) && !Number.isFinite(holding?.qty);
    if (unread) refused.push(`Alpaca's answer gives no quantity for the ${intent.symbol} held, so the record after this order could not be kept`);

    let estimate: number | null = null;
    if (intent.side === 'buy') {
      if (intent.qty !== undefined) refused.push('a buy is sized in dollars, so your caps hold at any price: give its dollars; a quantity is for selling what you hold');
      else estimate = intent.notional ?? null;
    } else if (account && !unread) {
      const heldQty = holding?.qty ?? 0;
      const heldValue = holding?.marketValue ?? 0;
      if (!(heldQty > 0)) refused.push(`no ${intent.symbol} is held, and primerkit sells only what is held`);
      else if (!(heldValue > 0)) refused.push(`Alpaca's answer gives no value for the ${intent.symbol} held, so the dollars of a sale cannot be checked`);
      else if (intent.qty !== undefined) {
        if (intent.qty > heldQty) refused.push(`${intent.qty} ${intent.symbol} is more than the ${heldQty} held, and primerkit sells only what is held`);
        estimate = intent.qty * (heldValue / heldQty);
      } else if (intent.notional !== undefined) {
        if (intent.notional > heldValue) refused.push(`$${intent.notional.toFixed(2)} is more than the $${heldValue.toFixed(2)} of ${intent.symbol} held, and primerkit sells only what is held`);
        estimate = intent.notional;
      }
    }

    if (account && !off) {
      try {
        const compared = await this.compare(positions);
        if (compared.off.length) refused.push(`the connection is now off: ${this.o.log.disabled()}. primerkit broker reconcile shows the record, and primerkit broker enable turns it back on`);
        else if (compared.waiting.includes(heldAs(intent.symbol))) refused.push(`the last ${intent.symbol} order has not settled at Alpaca, so what is held cannot be compared with the record yet: try again once it has (primerkit broker reconcile shows it)`);
      } catch (error) {
        refused.push(`the log's record could not be compared with Alpaca's: ${(error as Error).message}`);
      }
    }
    const caps = this.o.caps;
    const unusable = caps ? capsProblems(caps) : [];
    if (!caps) refused.push('no caps are set: max notional, max position share, symbols and max orders a day, in config.yaml');
    else if (unusable.length) refused.push(`your caps in config.yaml cannot be used, so no order goes: ${unusable.join('; ')}`);
    else {
      if (!caps.symbols.includes(intent.symbol)) refused.push(`${intent.symbol} is not in your symbols (${caps.symbols.join(', ') || 'none'})`);
      if (estimate !== null && estimate > caps.maxNotional) refused.push(`$${estimate.toFixed(2)} is over your cap of $${caps.maxNotional.toFixed(2)} an order`);
      const sent = this.o.log.sentOn(this.now().toISOString().slice(0, 10));
      if (sent >= caps.maxOrdersPerDay) refused.push(`${sent} orders were sent today, your cap is ${caps.maxOrdersPerDay} (a day is a UTC day)`);
      if (equity !== null && estimate !== null && intent.side === 'buy') {
        const held = holding?.marketValue ?? 0;
        const share = (held + estimate) / equity;
        if (!Number.isFinite(share)) refused.push(`Alpaca's answer gives no value for the ${intent.symbol} held, so the share of equity an order reaches cannot be checked`);
        else if (share > caps.maxPositionShare) refused.push(`${intent.symbol} would be ${(share * 100).toFixed(1)}% of equity, over your cap of ${(caps.maxPositionShare * 100).toFixed(1)}%`);
        // The optional caps: all positions together, and each group the symbol is in.
        const value = (list: Position[]) => list.reduce((s, p) => s + Math.abs(p.marketValue), 0);
        if (caps.maxExposureShare !== undefined) {
          const total = (value(positions) + estimate) / equity;
          if (!Number.isFinite(total)) refused.push("Alpaca's answer gives no value for a position held, so the share of equity all positions reach cannot be checked");
          else if (total > caps.maxExposureShare) refused.push(`all positions would be ${(total * 100).toFixed(1)}% of equity, over your cap of ${(caps.maxExposureShare * 100).toFixed(1)}% together`);
        }
        for (const g of caps.groups ?? []) {
          if (!g.symbols.some((s) => heldAs(s) === heldAs(intent.symbol))) continue;
          const together = (value(positions.filter((p) => g.symbols.some((s) => heldAs(s) === heldAs(p.symbol)))) + estimate) / equity;
          if (!Number.isFinite(together)) refused.push(`Alpaca's answer gives no value for a position in ${g.name}, so its share of equity cannot be checked`);
          else if (together > g.maxShare) refused.push(`${g.name} (${g.symbols.join(', ')}) would be ${(together * 100).toFixed(1)}% of equity, over your cap of ${(g.maxShare * 100).toFixed(1)}% for it`);
        }
      }
    }
    this.o.log.append({ event: 'checked', intent, body, refused }, this.now());
    return { checked: { body, estimate, refused }, account, positions };
  }

  // A dry run logs the body and sends nothing. A paper order goes only in paper mode, and
  // only after the person says yes to the body shown. After the yes, one order goes at a
  // time, and every check runs once more: the person may have taken a while, and another
  // run or a stop may have come in between. The order is logged before it is sent, and the
  // log then decides, whatever the lock did: the order goes only if no other run wrote an
  // order or a stop to the log since this one's last check began. Alpaca refusing it is a
  // failure, and failures in a row turn the connection off. No readable answer leaves its
  // outcome unknown, which turns the connection off at once.
  async submit(intent: OrderIntent, confirm: (body: OrderBody, checked: Checked) => Promise<boolean>): Promise<{ outcome: Outcome; checked: Checked; order?: PlacedOrder; error?: string }> {
    const { checked } = await this.check(intent);
    if (checked.refused.length || !checked.body) return { outcome: 'refused', checked };
    const body = checked.body;
    if (this.o.mode === 'dry_run') {
      this.o.log.append({ event: 'dry_run', body }, this.now());
      return { outcome: 'dry_run', checked };
    }
    if (this.o.mode !== 'paper') return { outcome: 'refused', checked: { ...checked, refused: [`the connection is in ${String(this.o.mode)} mode, which places no orders`] } };
    if (!(await confirm(body, checked))) {
      this.o.log.append({ event: 'declined', body }, this.now());
      return { outcome: 'declined', checked };
    }
    const release = this.o.log.lock();
    if (!release) {
      const refused = [`another primerkit order is going through right now (${this.o.log.lockPath}): try again when it is done. Where no order is running, a run ended without taking its lock away, and the lock clears itself five minutes after it was made`];
      this.o.log.append({ event: 'checked', intent, body, refused }, this.now());
      return { outcome: 'refused', checked: { ...checked, refused } };
    }
    try {
      const from = this.o.log.read().length;
      const again = await this.check(intent);
      if (again.checked.refused.length) return { outcome: 'refused', checked: { ...again.checked, body } };
      const before = again.positions.find((p) => heldAs(p.symbol) === heldAs(intent.symbol))?.qty ?? 0;
      this.o.log.append({ event: 'sending', body, before }, this.now());
      // Two runs that both hold the lock (a run still going when its lock reached five
      // minutes, a clock moved under it) both write their line here, and both read the
      // other's: neither sends. The line of an order that never went is closed as
      // withdrawn, which is no failure and counts toward no stop.
      const cameIn = this.o.log.cameIn(from, body.client_order_id);
      if (cameIn) {
        this.o.log.append({ event: 'withdrawn', body, reason: cameIn }, this.now());
        return { outcome: 'refused', checked: { ...checked, refused: [`${cameIn}, so this order was not sent: try again`] } };
      }
      try {
        const order = await this.o.broker.place(body);
        const expected = intent.qty !== undefined ? before + (intent.side === 'buy' ? intent.qty : -intent.qty) : null;
        this.o.log.append({ event: 'placed', body, order, expected, before }, this.now());
        return { outcome: 'placed', checked, order };
      } catch (error) {
        const message = (error as Error).message;
        if (!(error instanceof BrokerError) || error.kind !== 'refused') {
          this.o.log.append({ event: 'unknown', body, error: message }, this.now());
          this.o.log.append({ event: 'disabled', reason: `an order was sent and no readable answer came back (${message}), so Alpaca may hold order ${body.client_order_id}` }, this.now());
          return { outcome: 'unknown', checked, error: message };
        }
        this.o.log.append({ event: 'failed', body, error: message }, this.now());
        const stop = this.o.stop ?? STOP_RULES;
        const failures = this.o.log.failedInARow();
        if (failures >= stop.failures) this.o.log.append({ event: 'disabled', reason: `${failures} orders failed in a row` }, this.now());
        return { outcome: 'failed', checked, error: message };
      }
    } finally {
      release();
    }
  }

  // The log's record of each symbol it placed an order for, against the broker's holdings.
  // Drift past the rule turns the connection off. Runs before every order, and on demand.
  // On demand it first asks Alpaca for every order sent with no outcome on record.
  // busy: an order is going through in another run right now, so the orders with no
  // outcome were left alone this time.
  async reconcile(): Promise<{ drift: Drift[]; waiting: string[]; resolved?: Array<{ clientOrderId: string; taken: boolean }>; busy?: true }> {
    const resolved = await this.resolve();
    const { drift, waiting } = await this.compare(await this.o.broker.positions());
    return { drift, waiting, ...(resolved === null ? { busy: true } : resolved.length ? { resolved } : {}) };
  }

  // Each order sent with no outcome on record, asked for at Alpaca by the id primerkit
  // gave it: Alpaca holds it, and the log now says placed; or Alpaca says it holds none
  // (its own "not found", nothing less), and the log says failed. It runs under the lock an
  // order holds from before it is sent until its outcome is written, so an order still on
  // its way is never asked for and written off; where the lock is held it does nothing and
  // gives null.
  private async resolve(): Promise<Array<{ clientOrderId: string; taken: boolean }> | null> {
    if (!this.o.log.pending().length) return [];
    const release = this.o.log.lock();
    if (!release) return null;
    try {
      const resolved: Array<{ clientOrderId: string; taken: boolean }> = [];
      for (const e of this.o.log.pending()) {
        const found = await this.o.broker.orderByClientId(e.body.client_order_id);
        if (found) {
          const qty = e.body.qty === undefined ? null : Number(e.body.qty);
          const expected = qty === null ? null : e.before + (e.body.side === 'buy' ? qty : -qty);
          this.o.log.append({ event: 'placed', body: e.body, order: { id: found.id, status: found.status }, expected, before: e.before }, this.now());
        } else {
          this.o.log.append({ event: 'failed', body: e.body, error: 'Alpaca holds no order under this id, so it was not taken' }, this.now());
        }
        resolved.push({ clientOrderId: e.body.client_order_id, taken: Boolean(found) });
      }
      return resolved;
    } finally {
      release();
    }
  }

  // What each symbol's last placed order leaves expected: what was held before it, and
  // what Alpaca says filled, once Alpaca says the order is settled. Until then it waits, an
  // order by quantity as well as one in dollars: a stock sold out of market hours is taken
  // and not yet filled, and an order Alpaca takes can still be rejected, cancelled or
  // expire with nothing filled. A log line written before the holding before an order was
  // kept has only the quantity it expected, which is used as it is. A holding with no
  // quantity in the broker's answer counts as drift. A crypto purchase leaves Alpaca's fee
  // out of what is held: a shortfall within that fee is named as the fee and is no drift.
  // Turning the connection back on by hand takes the holdings as they stand: the record
  // starts again there, from the next order, or the stop would return at once.
  private async compare(positions: Position[]): Promise<{ drift: Drift[]; waiting: string[]; off: Drift[] }> {
    const last = new Map<string, Extract<LogEvent, { event: 'placed' }>>();
    for (const e of this.o.log.read()) {
      if (e.event === 'enabled') last.clear();
      if (e.event === 'placed') last.set(heldAs(e.body.symbol), e);
    }
    const drift: Drift[] = [];
    const waiting: string[] = [];
    for (const [symbol, e] of last) {
      let expected = typeof e.expected === 'number' && Number.isFinite(e.expected) ? e.expected : null;
      let filled: number | null = null;
      if (typeof e.before === 'number' && Number.isFinite(e.before)) {
        const order = await this.o.broker.order(e.order.id);
        if (!SETTLED.has(order.status)) {
          waiting.push(symbol);
          continue;
        }
        if (!Number.isFinite(order.filledQty)) throw new BrokerError(`Alpaca's answer for order ${e.order.id} gives no filled quantity`);
        expected = e.before + (e.body.side === 'buy' ? order.filledQty : -order.filledQty);
        filled = order.filledQty;
      }
      if (expected === null) {
        waiting.push(symbol);
        continue;
      }
      const held = positions.find((p) => heldAs(p.symbol) === symbol)?.qty ?? 0;
      // What a crypto purchase left short, in Alpaca's ninths: within its fee on the fill, or more.
      const by = Math.round((expected - held) * NINTHS);
      const short = filled !== null && e.body.side === 'buy' && isCrypto(e.body.symbol) && by > 0 ? { by: by / NINTHS, withinFee: by <= Math.ceil(CRYPTO_FEE_SHARE * filled * NINTHS) } : null;
      drift.push({ symbol, expected, held, ...(short ? { short } : {}) });
    }
    const rule = (this.o.stop ?? STOP_RULES).driftShare;
    const off = drift.filter((d) => !Number.isFinite(d.held) || (!d.short?.withinFee && Math.abs(d.held - d.expected) > rule * Math.max(Math.abs(d.expected), Math.abs(d.held), 1e-12)));
    if (drift.length || waiting.length) this.o.log.append({ event: 'reconciled', drift, ...(waiting.length ? { waiting } : {}) }, this.now());
    if (off.length) this.o.log.append({ event: 'disabled', reason: `the broker holds ${off.map((d) => (Number.isFinite(d.held) ? `${d.held} ${d.symbol}` : `${d.symbol} with no quantity in its answer`)).join(', ')} where the log expects ${off.map((d) => `${d.expected}`).join(', ')}` }, this.now());
    return { drift, waiting, off };
  }
}
