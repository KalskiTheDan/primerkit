import type { IntentChecks, IntentRecord, RiskCheck } from './intent';
import { sizeOf, type Sized } from './intent-draft';
import { exitProblem, exitWords } from './intent-exits';

// The pre-trade checks an order intent passes before any yes: code, with no model, each
// named with its limit, the figure it found and whether it passed. They read only what the
// broker gave and the person's own caps; nothing here calls anything.

export interface CheckCaps {
  maxNotional: number;
  maxPositionShare: number;
  symbols: string[];
  maxOrdersPerDay: number;
  maxExposureShare?: number | null; // every position together, after the order
  groups?: Array<{ name: string; symbols: string[]; maxShare: number }>; // symbols that move together
}

export interface CheckInputs {
  record: IntentRecord;
  now: Date;
  // The connection: its mode, the stop that turned it off, the kill switch's file where it
  // is there, and the orders sent with no outcome on record.
  connection: { mode: string; off: string | null; killSwitch: string | null; pending: string[] };
  account: { status: string; equity: number; positions: Array<{ symbol: string; qty: number; marketValue: number }> } | null;
  // The symbol as the broker's own asset list holds it; null where it holds none.
  asset: { symbol: string; assetClass: string; tradable: boolean; fractionable: boolean; minOrderSize: number | null; status: string } | null;
  caps: CheckCaps | null;
  capsProblems: string[];
  sentToday: number;
  // Crypto is held without its slash: BTC/USD as BTCUSD.
  heldAs: (symbol: string) => string;
  // The checks run again after the yes, when the intent is approved, not a draft.
  afterYes?: boolean;
  // The briefings and metrics PreReason's catalogue marks as measuring a futures, swap or
  // options market, and every id it lists, read from it for a PreReason publication trigger;
  // null where it could not be read.
  derivatives?: { marked: ReadonlySet<string>; listed: ReadonlySet<string> } | null;
}

const usd = (n: number): string => `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const pct = (share: number): string => `${Number((share * 100).toFixed(2))}%`;

// A PreReason publication is never a trigger where PreReason's catalogue marks its briefing
// or metric as measuring a futures, swap or options market: that list is read from the
// catalogue, never typed here. Unread, or for an id it does not list, it refuses as unknown.
// No other publication is taken as a trigger either.
function eventTrigger(source: string, marks: CheckInputs['derivatives']): string {
  if (!marks) return `${source} cannot be a trigger: PreReason's catalogue could not be read, so which publications measure a futures, swap or options market is not known, and no PreReason publication is taken as a trigger`;
  if (marks.marked.has(source)) return `${source} can never be a trigger: PreReason's catalogue marks it as measuring a futures, swap or options market`;
  if (!marks.listed.has(source)) return `${source} cannot be a trigger: PreReason's catalogue does not list it, so whether it measures a futures, swap or options market is not known`;
  return `${source} is not taken as a trigger: primerkit takes no PreReason publication as a trigger`;
}

export function intentChecks(i: CheckInputs): IntentChecks & { sized: Sized | null } {
  const { intent, state } = i.record;
  const checks: RiskCheck[] = [];
  const add = (check: string, passed: boolean, message: string, limit: RiskCheck['limit'] = null, value: RiskCheck['value'] = null) => checks.push({ check, limit, value, passed, message });

  const going = i.afterYes ? state === 'approved' : state === 'draft' || state === 'ready';
  add('state', going, going ? `it is ${state}` : i.afterYes ? `it is ${state}, where your yes left it approved` : `it is ${state}, and only a draft or a ready intent goes on`, i.afterYes ? 'approved' : 'draft or ready', state);
  const expired = i.now.getTime() > Date.parse(intent.expires_at);
  add('expiry', !expired, expired ? `it expired at ${intent.expires_at}: a stale intent is never sent, and a new one is needed` : `it stands until ${intent.expires_at}`, intent.expires_at, i.now.toISOString());

  // What sends today: a market order. A trigger only makes an intent ready, and its kinds
  // come in later steps.
  const e = intent.entry;
  const entry =
    e.kind === 'market'
      ? null
      : e.kind === 'limit'
        ? 'a limit order is not sent yet: market orders only, for now'
        : e.condition.kind === 'prereason_event'
          ? eventTrigger(e.condition.source, i.derivatives)
          : e.condition.kind === 'price'
            ? "a price trigger is read from the broker's quotes, which come in a later step"
            : 'a webhook trigger is not taken yet';
  add('entry', entry === null, entry ?? 'a market order', 'market', e.kind);
  const exitIssue = exitProblem(intent.exit, intent.side, i.asset?.assetClass ?? null);
  add('exits', exitIssue === null, exitIssue ?? (intent.exit ? `${exitWords(intent.exit)}, resting at Alpaca once it fills` : 'no exits'), null, intent.exit ? 'standing' : 'none');
  add('option', intent.option === null, intent.option === null ? 'no options leg' : 'options are refused');

  const c = i.connection;
  const sends = c.mode === 'paper' || c.mode === 'dry_run';
  add('mode', sends, sends ? (c.mode === 'paper' ? 'paper: it goes on paper after your yes' : 'dry_run: it is shown and not sent') : `mode ${c.mode} places no orders`, 'paper or dry_run', c.mode);
  add('kill_switch', c.killSwitch === null, c.killSwitch === null ? 'off' : `on: ${c.killSwitch} is there, and no order goes while it is`);
  add('connection', c.off === null, c.off === null ? 'on' : `off since a stop: ${c.off}. primerkit broker enable turns it back on`);
  add('pending', !c.pending.length, c.pending.length ? `an order primerkit sent has no outcome on record (${c.pending.join(', ')}): primerkit broker reconcile asks Alpaca for it` : 'no order waits for its outcome');

  const a = i.account;
  const equity = a && Number.isFinite(a.equity) && a.equity > 0 ? a.equity : null;
  add('account', Boolean(a && a.status === 'ACTIVE' && equity !== null), !a ? 'the account could not be read' : a.status !== 'ACTIVE' ? `the account is ${a.status}, not ACTIVE` : equity === null ? "the account's equity is not in Alpaca's answer" : `ACTIVE, equity ${usd(equity)}`, 'ACTIVE', a?.status ?? null);

  const symbol = intent.instrument.symbol;
  const asset = i.asset;
  const assetClass = asset?.assetClass ?? null;
  const assetProblem = !asset
    ? `${symbol} is not in Alpaca's asset list`
    : !asset.tradable || asset.status !== 'active'
      ? `${asset.symbol} is not tradable at Alpaca now (${asset.status})`
      : assetClass !== 'crypto' && assetClass !== 'us_equity'
        ? `${asset.symbol} is ${assetClass}, and primerkit trades crypto and US stocks only`
        : intent.instrument.asset_class !== null && intent.instrument.asset_class !== assetClass
          ? `the intent says ${intent.instrument.asset_class}, and Alpaca's asset list says ${assetClass}`
          : null;
  add('asset', assetProblem === null, assetProblem ?? `${asset!.symbol}, ${assetClass}, from Alpaca's asset list`, 'crypto or us_equity', assetClass);

  const held = a?.positions.find((p) => i.heldAs(p.symbol) === i.heldAs(symbol));
  const figures = { equity: equity ?? Number.NaN, heldQty: held?.qty ?? 0, heldValue: held?.marketValue ?? 0 };
  let sized: Sized | null = null;
  if (a) {
    sized = sizeOf(intent.side, intent.sizing, figures);
    const turned = sized.kind === 'order' && intent.sizing.kind === 'target_share' && sized.side !== intent.side;
    add('size', sized.kind === 'order' && !turned, sized.kind === 'none' ? sized.why : turned ? `the account has moved: the target now needs a ${sized.side}, and the intent is a ${intent.side}; a new intent is needed` : sized.says);
  } else add('size', false, 'the account could not be read, so nothing could be sized');

  const order = sized?.kind === 'order' ? sized : null;
  const priceHeld = figures.heldQty > 0 ? figures.heldValue / figures.heldQty : null;
  const dollars = order ? (order.notional ?? (order.quantity !== null && priceHeld !== null ? order.quantity * priceHeld : null)) : null;
  if (order && order.quantity !== null && asset) {
    if (!Number.isInteger(order.quantity) && !asset.fractionable) add('fraction', false, `${asset.symbol} is not fractionable at Alpaca, and ${order.quantity} is a fraction`);
    if (asset.minOrderSize !== null && order.quantity < asset.minOrderSize) add('minimum', false, `${order.quantity} is under Alpaca's smallest order of ${asset.minOrderSize} ${asset.symbol}`, asset.minOrderSize, order.quantity);
  }

  const caps = i.caps;
  if (!caps) add('caps', false, 'no caps are set: max notional, max position share, symbols and max orders a day, in config.yaml');
  else if (i.capsProblems.length) add('caps', false, `your caps in config.yaml cannot be used: ${i.capsProblems.join('; ')}`);
  else {
    add('symbols', caps.symbols.includes(symbol), caps.symbols.includes(symbol) ? `${symbol} is among your symbols` : `${symbol} is not in your symbols (${caps.symbols.join(', ')})`, caps.symbols.join(', '), symbol);
    add('max_notional', dollars !== null && dollars <= caps.maxNotional, dollars === null ? 'the order has no amount to hold to your cap' : `${usd(dollars)} ${dollars <= caps.maxNotional ? 'is within' : 'is over'} your cap of ${usd(caps.maxNotional)} an order`, caps.maxNotional, dollars);
    add('orders_today', i.sentToday < caps.maxOrdersPerDay, `${i.sentToday} sent today, by UTC days; your cap is ${caps.maxOrdersPerDay}`, caps.maxOrdersPerDay, i.sentToday);
    // Each share is the one after the order. A buy adds its dollars to what is held; a sale
    // leaves what it does not sell, and none where it sells all that is held. A sale only
    // takes away, so it is never refused for a share it lowers: the caps hold a buy.
    const selling = order?.side === 'sell';
    const before = held?.marketValue ?? 0;
    const after = !order || dollars === null ? before : !selling ? before + dollars : order.quantity !== null && order.quantity >= figures.heldQty ? 0 : Math.max(0, before - dollars);
    const change = after - before;
    const within = (share: number, was: number, cap: number): boolean => share <= cap || (selling && share <= was);
    const afterThis = selling ? ' after this sale' : '';
    const capWords = (share: number, cap: number): string => `your cap is ${pct(cap)}${selling && share > cap ? ', and a sale that lowers this share passes this cap' : ''}`;
    if (equity !== null && a) {
      const share = after / equity;
      add('position_share', within(share, before / equity, caps.maxPositionShare), `${symbol} would be ${pct(share)} of equity${afterThis}; ${capWords(share, caps.maxPositionShare)}`, caps.maxPositionShare, Number(share.toFixed(6)));
      const allHeld = a.positions.reduce((s, p) => s + Math.abs(p.marketValue), 0);
      const total = (allHeld + change) / equity;
      if (caps.maxExposureShare !== undefined && caps.maxExposureShare !== null) {
        add('total_exposure', within(total, allHeld / equity, caps.maxExposureShare), `all positions would be ${pct(total)} of equity${afterThis}; ${capWords(total, caps.maxExposureShare)}`, caps.maxExposureShare, Number(total.toFixed(6)));
      } else add('total_exposure', true, `all positions would be ${pct(total)} of equity${afterThis}; you set no cap on them together`, null, Number(total.toFixed(6)));
      for (const g of caps.groups ?? []) {
        if (!g.symbols.some((s) => i.heldAs(s) === i.heldAs(symbol))) continue;
        const inGroup = a.positions.filter((p) => g.symbols.some((s) => i.heldAs(s) === i.heldAs(p.symbol))).reduce((s, p) => s + Math.abs(p.marketValue), 0);
        const together = (inGroup + change) / equity;
        add(`group ${g.name}`, within(together, inGroup / equity, g.maxShare), `${g.name} (${g.symbols.join(', ')}) would be ${pct(together)} of equity${afterThis}; ${capWords(together, g.maxShare)}`, g.maxShare, Number(together.toFixed(6)));
      }
    }
  }
  return {
    at: i.now.toISOString(),
    computed: { notional: order?.notional ?? null, quantity: order?.quantity ?? null, price: priceHeld, price_at: null, equity, held: figures.heldQty },
    checks,
    sized,
  };
}

export const checksPassed = (c: Pick<IntentChecks, 'checks'>): boolean => c.checks.every((x) => x.passed);
