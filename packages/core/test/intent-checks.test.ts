import { describe, expect, it } from 'vitest';
import { checksPassed, intentChecks, type CheckInputs, type Intent, type IntentRecord } from '../src/index';

const NOW = new Date('2026-10-11T10:30:00.000Z');
const heldAs = (s: string) => s.replace('/', '');

// A routine's draft: hold half the paper account in BTC/USD, as a market order.
const intent = (over: Partial<Intent> = {}): Intent => ({
  intent_version: 1,
  intent_id: '20261011T100000Z-abc123',
  created_at: '2026-10-11T10:00:00.000Z',
  expires_at: '2026-10-11T11:00:00.000Z',
  source: { kind: 'routine', routine: 'wf', tick: '2026-10-11T07:30:00.000Z' },
  instrument: { symbol: 'BTC/USD', asset_class: null, venue: 'alpaca' },
  side: 'buy',
  leg_of: null,
  sizing: { kind: 'target_share', share: 0.5 },
  entry: { kind: 'market' },
  exit: null,
  option: null,
  provenance: { thesis: 'wf', run_id: null, cited: [], generated: [], checks_passed: [], model: null, data_as_of: null },
  ...over,
});
const record = (i: Intent = intent(), state: IntentRecord['state'] = 'draft'): IntentRecord => ({ dir: '/j', intent: i, ready: null, checks: null, approval: null, finalChecks: null, orders: [], close: null, state });

// $100,000 of equity, 0.25 BTC held ($21,000) and $10,000 of a stock, within caps that let
// the order through.
const inputs = (over: Partial<CheckInputs> = {}): CheckInputs => ({
  record: record(),
  now: NOW,
  connection: { mode: 'paper', off: null, killSwitch: null, pending: [] },
  account: { status: 'ACTIVE', equity: 100_000, positions: [{ symbol: 'BTCUSD', qty: 0.25, marketValue: 21_000 }, { symbol: 'AAPL', qty: 40, marketValue: 10_000 }] },
  asset: { symbol: 'BTC/USD', assetClass: 'crypto', tradable: true, fractionable: true, minOrderSize: 0.0001, status: 'active' },
  caps: { maxNotional: 50_000, maxPositionShare: 0.6, symbols: ['BTC/USD'], maxOrdersPerDay: 5 },
  capsProblems: [],
  sentToday: 0,
  heldAs,
  ...over,
});
const failing = (over: Partial<CheckInputs>) =>
  intentChecks(inputs(over))
    .checks.filter((c) => !c.passed)
    .map((c) => `${c.check}: ${c.message}`);

describe('the pre-trade checks', () => {
  it('passes an intent within every limit, naming each check with its limit and figure, and computes the size from the account', () => {
    const result = intentChecks(inputs());
    expect(checksPassed(result)).toBe(true);
    expect(result.checks.map((c) => c.check)).toEqual(['state', 'expiry', 'entry', 'exits', 'option', 'mode', 'kill_switch', 'connection', 'pending', 'account', 'asset', 'size', 'symbols', 'max_notional', 'orders_today', 'position_share', 'total_exposure']);
    expect(result.computed).toEqual({ notional: 29000, quantity: null, price: 84000, price_at: null, equity: 100000, held: 0.25 });
    expect(result.checks.find((c) => c.check === 'max_notional')).toEqual({ check: 'max_notional', limit: 50000, value: 29000, passed: true, message: '$29,000.00 is within your cap of $50,000.00 an order' });
    expect(result.checks.find((c) => c.check === 'position_share')).toMatchObject({ limit: 0.6, value: 0.5, passed: true });
    expect(result.checks.find((c) => c.check === 'total_exposure')).toMatchObject({ limit: null, value: 0.6, passed: true, message: 'all positions would be 60% of equity; you set no cap on them together' });
  });

  it('refuses an intent that is stale, no longer a draft, or asks for what does not go yet', () => {
    expect(failing({ now: new Date('2026-10-11T11:00:01.000Z') })).toEqual(['expiry: it expired at 2026-10-11T11:00:00.000Z: a stale intent is never sent, and a new one is needed']);
    expect(failing({ record: record(intent(), 'approved') })).toEqual(['state: it is approved, and only a draft or a ready intent goes on']);
    expect(failing({ record: record(intent({ entry: { kind: 'limit', price: 80000 } })) })).toEqual(['entry: a limit order is not sent yet: market orders only, for now']);
    expect(failing({ record: record(intent({ exit: { stop: { kind: 'distance', share: 0.05 }, standing: true } })) })).toEqual(["exits: a crypto stop is a stop-limit order, and it needs your stop_limit_gap: how far below the stop its limit sits, in routine.yaml's exits"]);
  });

  it('never takes as a trigger a PreReason publication the catalogue marks as measuring a futures, swap or options market, nor any other', () => {
    const event = (source: string) => record(intent({ entry: { kind: 'trigger', condition: { kind: 'prereason_event', source } } }));
    // As the catalogue marks them: a briefing with derivatives: true, a metric with an instrument.
    const marks = { marked: new Set(['btc.momentum', 'cot-btc-net']), listed: new Set(['btc.momentum', 'cot-btc-net', 'macro.snapshot']) };
    for (const source of ['btc.momentum', 'cot-btc-net']) {
      expect(failing({ record: event(source), derivatives: marks })).toEqual([`entry: ${source} can never be a trigger: PreReason's catalogue marks it as measuring a futures, swap or options market`]);
    }
    expect(failing({ record: event('macro.snapshot'), derivatives: marks })).toEqual(['entry: macro.snapshot is not taken as a trigger: primerkit takes no PreReason publication as a trigger']);
    // An id the catalogue does not list (a draft, a retired one, a typo) carries no mark to
    // read, so it is refused as unknown, never taken for unmarked.
    expect(failing({ record: event('btc.momentun'), derivatives: marks })).toEqual([
      "entry: btc.momentun cannot be a trigger: PreReason's catalogue does not list it, so whether it measures a futures, swap or options market is not known",
    ]);
    // With the catalogue unread, every publication is refused, marked or not.
    for (const derivatives of [null, undefined]) {
      expect(failing({ record: event('macro.snapshot'), derivatives })).toEqual([
        "entry: macro.snapshot cannot be a trigger: PreReason's catalogue could not be read, so which publications measure a futures, swap or options market is not known, and no PreReason publication is taken as a trigger",
      ]);
    }
  });

  it('refuses on the connection: its mode, the kill switch, a stop, and an order with no outcome', () => {
    expect(failing({ connection: { mode: 'read', off: null, killSwitch: null, pending: [] } })).toEqual(['mode: mode read places no orders']);
    expect(failing({ connection: { mode: 'paper', off: null, killSwitch: '/home/.primerkit/broker/STOP', pending: [] } })).toEqual(['kill_switch: on: /home/.primerkit/broker/STOP is there, and no order goes while it is']);
    expect(failing({ connection: { mode: 'paper', off: '3 orders failed in a row', killSwitch: null, pending: [] } })).toEqual(['connection: off since a stop: 3 orders failed in a row. primerkit broker enable turns it back on']);
    expect(failing({ connection: { mode: 'paper', off: null, killSwitch: null, pending: ['primerkit-1'] } })).toEqual(['pending: an order primerkit sent has no outcome on record (primerkit-1): primerkit broker reconcile asks Alpaca for it']);
    // CONTROL: a dry run passes the mode check; it is shown and not sent.
    expect(failing({ connection: { mode: 'dry_run', off: null, killSwitch: null, pending: [] } })).toEqual([]);
  });

  it("reads the asset class from Alpaca's asset list, never from the symbol", () => {
    expect(failing({ asset: null })).toEqual(["asset: BTC/USD is not in Alpaca's asset list"]);
    expect(failing({ asset: { symbol: 'BTC/USD', assetClass: 'crypto', tradable: false, fractionable: true, minOrderSize: null, status: 'inactive' } })).toEqual(['asset: BTC/USD is not tradable at Alpaca now (inactive)']);
    expect(failing({ asset: { symbol: 'BTC/USD', assetClass: 'us_option', tradable: true, fractionable: false, minOrderSize: null, status: 'active' } })).toEqual(['asset: BTC/USD is us_option, and primerkit trades crypto and US stocks only']);
    expect(failing({ record: record(intent({ instrument: { symbol: 'BTC/USD', asset_class: 'us_equity', venue: 'alpaca' } })) })).toEqual(["asset: the intent says us_equity, and Alpaca's asset list says crypto"]);
  });

  it('holds the computed size to the caps, all positions together, and each group, and refuses what cannot be sized', () => {
    const caps = inputs().caps!;
    expect(failing({ caps: null })).toEqual(['caps: no caps are set: max notional, max position share, symbols and max orders a day, in config.yaml']);
    expect(failing({ caps, capsProblems: ['max_notional is "50"'] })).toEqual(['caps: your caps in config.yaml cannot be used: max_notional is "50"']);
    expect(failing({ caps: { ...caps, symbols: ['ETH/USD'] } })).toEqual(['symbols: BTC/USD is not in your symbols (ETH/USD)']);
    expect(failing({ caps: { ...caps, maxNotional: 25_000 } })).toEqual(['max_notional: $29,000.00 is over your cap of $25,000.00 an order']);
    expect(failing({ sentToday: 5 })).toEqual(['orders_today: 5 sent today, by UTC days; your cap is 5']);
    expect(failing({ caps: { ...caps, maxPositionShare: 0.4 } })).toEqual(['position_share: BTC/USD would be 50% of equity; your cap is 40%']);
    expect(failing({ caps: { ...caps, maxExposureShare: 0.55 } })).toEqual(['total_exposure: all positions would be 60% of equity; your cap is 55%']);
    expect(failing({ caps: { ...caps, groups: [{ name: 'risk', symbols: ['BTC/USD', 'AAPL'], maxShare: 0.5 }, { name: 'other', symbols: ['ETH/USD'], maxShare: 0.01 }] } })).toEqual(['group risk: risk (BTC/USD, AAPL) would be 60% of equity; your cap is 50%']);
    expect(failing({ account: null })).toEqual(['account: the account could not be read', 'size: the account could not be read, so nothing could be sized', 'max_notional: the order has no amount to hold to your cap']);
    // The account moved since the draft: the target is now passed, and the buy would be a sale.
    expect(failing({ account: { status: 'ACTIVE', equity: 100_000, positions: [{ symbol: 'BTCUSD', qty: 0.7, marketValue: 58_800 }] } })).toEqual(['size: the account has moved: the target now needs a sell, and the intent is a buy; a new intent is needed']);
  });

  // A sale of the 0.25 BTC held: all of it, by a target of none, or 0.15 of it, which leaves
  // 0.1 BTC, $8,400. The $10,000 of the stock stays.
  const sale = (sizing: Intent['sizing']) => record(intent({ side: 'sell', sizing }));
  const said = (over: Partial<CheckInputs>, ...names: string[]) =>
    intentChecks(inputs(over))
      .checks.filter((c) => names.includes(c.check))
      .map((c) => `${c.check}: ${c.message}`);

  it('states the share after a sale of all that is held: none', () => {
    const result = intentChecks(inputs({ record: sale({ kind: 'target_share', share: 0 }) }));
    expect(checksPassed(result)).toBe(true);
    expect(result.checks.find((c) => c.check === 'position_share')).toEqual({ check: 'position_share', limit: 0.6, value: 0, passed: true, message: 'BTC/USD would be 0% of equity after this sale; your cap is 60%' });
  });

  it('states the share a partial sale leaves', () => {
    const result = intentChecks(inputs({ record: sale({ kind: 'fixed_quantity', quantity: 0.15 }) }));
    expect(checksPassed(result)).toBe(true);
    expect(result.checks.find((c) => c.check === 'position_share')).toEqual({ check: 'position_share', limit: 0.6, value: 0.084, passed: true, message: 'BTC/USD would be 8.4% of equity after this sale; your cap is 60%' });
  });

  it('states all positions together, and each group, after a sale', () => {
    const caps = { ...inputs().caps!, maxExposureShare: 0.5, groups: [{ name: 'risk', symbols: ['BTC/USD', 'AAPL'], maxShare: 0.5 }] };
    expect(said({ caps, record: sale({ kind: 'target_share', share: 0 }) }, 'total_exposure', 'group risk')).toEqual([
      'total_exposure: all positions would be 10% of equity after this sale; your cap is 50%',
      'group risk: risk (BTC/USD, AAPL) would be 10% of equity after this sale; your cap is 50%',
    ]);
    const part = intentChecks(inputs({ record: sale({ kind: 'fixed_quantity', quantity: 0.15 }) }));
    expect(part.checks.find((c) => c.check === 'total_exposure')).toEqual({ check: 'total_exposure', limit: null, value: 0.184, passed: true, message: 'all positions would be 18.4% of equity after this sale; you set no cap on them together' });
  });

  it('never refuses a sale for a share it lowers, and still refuses a buy over the same caps', () => {
    // 21% of equity in BTC/USD and 31% together, over every cap here; the sale lowers each.
    const caps = { ...inputs().caps!, maxPositionShare: 0.05, maxExposureShare: 0.15, groups: [{ name: 'risk', symbols: ['BTC/USD', 'AAPL'], maxShare: 0.1 }] };
    expect(failing({ caps, record: sale({ kind: 'fixed_quantity', quantity: 0.15 }) })).toEqual([]);
    expect(said({ caps, record: sale({ kind: 'fixed_quantity', quantity: 0.15 }) }, 'position_share', 'total_exposure', 'group risk')).toEqual([
      'position_share: BTC/USD would be 8.4% of equity after this sale; your cap is 5%, and a sale that lowers this share passes this cap',
      'total_exposure: all positions would be 18.4% of equity after this sale; your cap is 15%, and a sale that lowers this share passes this cap',
      'group risk: risk (BTC/USD, AAPL) would be 18.4% of equity after this sale; your cap is 10%, and a sale that lowers this share passes this cap',
    ]);
    // CONTROL: the routine's buy adds to each, and the same caps refuse it.
    expect(failing({ caps })).toEqual([
      'position_share: BTC/USD would be 50% of equity; your cap is 5%',
      'total_exposure: all positions would be 60% of equity; your cap is 15%',
      'group risk: risk (BTC/USD, AAPL) would be 60% of equity; your cap is 10%',
    ]);
  });

  it("leaves a buy's shares as they were: what is held and the buy's dollars", () => {
    const caps = { ...inputs().caps!, maxExposureShare: 0.7, groups: [{ name: 'risk', symbols: ['BTC/USD', 'AAPL'], maxShare: 0.7 }] };
    expect(said({ caps }, 'position_share', 'total_exposure', 'group risk')).toEqual([
      'position_share: BTC/USD would be 50% of equity; your cap is 60%',
      'total_exposure: all positions would be 60% of equity; your cap is 70%',
      'group risk: risk (BTC/USD, AAPL) would be 60% of equity; your cap is 70%',
    ]);
  });

  it("holds a sale's quantity to what the asset allows", () => {
    const sale = record(intent({ side: 'sell', sizing: { kind: 'fixed_quantity', quantity: 0.00005 } }));
    expect(failing({ record: sale })).toEqual(["minimum: 0.00005 is under Alpaca's smallest order of 0.0001 BTC/USD"]);
    const stock = record(intent({ instrument: { symbol: 'AAPL', asset_class: null, venue: 'alpaca' }, side: 'sell', sizing: { kind: 'fixed_quantity', quantity: 2.5 } }));
    const asset = { symbol: 'AAPL', assetClass: 'us_equity', tradable: true, fractionable: false, minOrderSize: null, status: 'active' };
    expect(failing({ record: stock, asset, caps: { ...inputs().caps!, symbols: ['AAPL'] } })).toEqual(['fraction: AAPL is not fractionable at Alpaca, and 2.5 is a fraction']);
  });
});
