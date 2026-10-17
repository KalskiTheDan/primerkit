// Alpaca's official Trading API, paper first. The keys go in Alpaca's own two headers,
// to Alpaca only. Live trading is not part of primerkit: a live base is refused, and a
// paper key cannot place a live order in any case.

export const PAPER_BASE = 'https://paper-api.alpaca.markets';

export type BrokerMode = 'off' | 'read' | 'dry_run' | 'paper';
export const BROKER_MODES: readonly BrokerMode[] = ['off', 'read', 'dry_run', 'paper'];

// What is wrong with a mode as config.yaml gives it, or null. Only the four names are
// modes: any other value, such as "live", a misspelling or true, is refused by name
// rather than read as paper.
export function modeProblem(mode: unknown): string | null {
  if (typeof mode === 'string' && (BROKER_MODES as readonly string[]).includes(mode)) return null;
  return `mode ${mode === undefined || mode === null ? 'is missing' : `is ${JSON.stringify(mode)}`}, where it takes off, read, dry_run or paper`;
}

export interface OrderIntent {
  symbol: string; // "BTC/USD"; a symbol with no slash goes as a stock order, for the day
  side: 'buy' | 'sell';
  qty?: number;
  notional?: number; // in dollars
  // A market order unless it says otherwise: a standing exit rests as a limit sale (a target)
  // or a stop-limit sale (a stop), at prices in dollars.
  type?: 'market' | 'limit' | 'stop_limit';
  limitPrice?: number;
  stopPrice?: number;
}

export interface OrderBody {
  symbol: string;
  side: 'buy' | 'sell';
  type: 'market' | 'limit' | 'stop_limit';
  time_in_force: 'gtc' | 'day';
  qty?: string;
  notional?: string;
  limit_price?: string;
  stop_price?: string;
  client_order_id: string;
}

export interface Account {
  id: string;
  number: string;
  status: string; // "ACTIVE"
  equity: number;
  cash: number;
  buyingPower: number;
}

export interface Position {
  symbol: string; // as Alpaca names it: "BTCUSD" for crypto
  qty: number;
  marketValue: number;
  // Read for the positions screen where Alpaca's answer holds them: its average entry price,
  // and the asset's change today as a share. Never computed by primerkit.
  avgEntryPrice?: number;
  changeToday?: number;
}

export interface PlacedOrder {
  id: string;
  status: string;
}

// A symbol as Alpaca's own asset list holds it: what it is and how it may be traded. The
// class is read here, never guessed from the symbol.
export interface Asset {
  symbol: string; // as Alpaca names it: "BTC/USD", "AAPL"
  assetClass: string; // "crypto", "us_equity"
  tradable: boolean;
  fractionable: boolean;
  minOrderSize: number | null; // crypto's smallest order, in units
  status: string; // "active"
}

// An order as Alpaca records it later: its status, and how much of it has filled.
export interface OrderState {
  id: string;
  status: string; // "filled", "partially_filled", "accepted" and the rest of Alpaca's states
  filledQty: number;
  filledAvgPrice?: number | null; // the average price of what filled, where Alpaca gives it
}

// The states after which an order fills no more.
export const SETTLED = new Set(['filled', 'canceled', 'expired', 'rejected']);

// What went wrong with a call. refused: Alpaca answered, and the answer says no.
// no_answer: nothing readable came back (a dropped connection, a time limit, a server
// error), so whether Alpaca acted on the call is not known. unreadable: Alpaca answered
// yes in a form that cannot be read.
export type BrokerFailure = 'refused' | 'no_answer' | 'unreadable';

export class BrokerError extends Error {
  constructor(
    message: string,
    readonly status: number | null = null,
    readonly kind: BrokerFailure = 'refused',
  ) {
    super(message);
  }
}

// How long one call may take before primerkit stops waiting for it.
export const CALL_TIMEOUT_MS = 30_000;

export interface AlpacaOptions {
  keyId: string;
  secret: string;
  base?: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

export const isCrypto = (symbol: string) => symbol.includes('/');
// A quantity as Alpaca reads it: plain digits, never "5e-7", to its nine decimals.
const quantity = (qty: number): string => (Number.isInteger(qty) ? String(qty) : qty.toFixed(9).replace(/\.?0+$/, ''));
// A number as Alpaca writes it: a number, or a string that holds one. An empty string, a
// boolean or a missing field is not a number, so the checks that need one refuse.
const money = (v: unknown): number => (typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN);

// Crypto positions come back without the slash: BTC/USD is held as BTCUSD.
export const heldAs = (symbol: string) => symbol.replace('/', '');

export class AlpacaBroker {
  readonly id = 'alpaca';
  readonly name = 'Alpaca';
  private readonly base: string;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: AlpacaOptions) {
    const base = (options.base ?? PAPER_BASE).replace(/\/+$/, '');
    if (!/^https:\/\/paper-api\.alpaca\.markets$/.test(base) && !/^http:\/\/127\.0\.0\.1:\d+$/.test(base)) {
      throw new BrokerError(`primerkit trades on Alpaca's paper API only, not ${base}.`);
    }
    this.base = base;
    this.fetchImpl = options.fetch ?? fetch;
  }

  // One call to the paper API. A redirect is never followed: the keys and an order go to
  // the one address above and nowhere a server points them. Each call has a time limit.
  private async call(path: string, init: { method?: string; body?: object } = {}): Promise<unknown> {
    let res: Response;
    let text: string;
    try {
      res = await this.fetchImpl(`${this.base}${path}`, {
        method: init.method ?? 'GET',
        headers: {
          'APCA-API-KEY-ID': this.options.keyId,
          'APCA-API-SECRET-KEY': this.options.secret,
          Accept: 'application/json',
          ...(init.body ? { 'Content-Type': 'application/json' } : {}),
        },
        ...(init.body ? { body: JSON.stringify(init.body) } : {}),
        redirect: 'manual',
        signal: AbortSignal.timeout(this.options.timeoutMs ?? CALL_TIMEOUT_MS),
      });
      text = await res.text();
    } catch (error) {
      const timedOut = error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError');
      throw new BrokerError(timedOut ? 'Alpaca did not answer in time' : `Alpaca could not be reached: ${(error as Error).message}`, null, 'no_answer');
    }
    if (res.status >= 300 && res.status < 400) throw new BrokerError(`Alpaca answered with a redirect (${res.status}), which primerkit does not follow`, res.status, 'no_answer');
    if (!res.ok) {
      let message = `Alpaca answered ${res.status}`;
      try {
        const body = JSON.parse(text) as { message?: string };
        if (body.message) message = `Alpaca: ${body.message}`;
      } catch {
        // not JSON
      }
      // 401 is always the keys, and so is a 403 that says no more than "forbidden". Any
      // other 403 is Alpaca refusing the order itself (buying power, shares held for an open
      // order), and its own words say why.
      if (res.status === 401 || (res.status === 403 && /^(Alpaca answered 403|Alpaca: forbidden\.?)$/i.test(message))) message = 'Alpaca did not accept the keys. Paper keys work only against the paper API.';
      throw new BrokerError(message, res.status, res.status >= 500 ? 'no_answer' : 'refused');
    }
    if (!text) return null;
    try {
      return JSON.parse(text);
    } catch {
      throw new BrokerError("Alpaca's answer could not be read", res.status, 'unreadable');
    }
  }

  async account(): Promise<Account> {
    const a = ((await this.call('/v2/account')) ?? {}) as Record<string, unknown>;
    return { id: String(a.id ?? ''), number: String(a.account_number ?? ''), status: String(a.status ?? ''), equity: money(a.equity), cash: money(a.cash), buyingPower: money(a.buying_power) };
  }

  async positions(): Promise<Position[]> {
    const list = await this.call('/v2/positions');
    if (!Array.isArray(list)) throw new BrokerError("Alpaca's answer for the positions is not a list", 200, 'unreadable');
    return (list as Array<Record<string, unknown>>).map((p) => ({
      symbol: String(p.symbol ?? ''),
      qty: money(p.qty),
      marketValue: money(p.market_value),
      ...(p.avg_entry_price !== undefined && Number.isFinite(money(p.avg_entry_price)) ? { avgEntryPrice: money(p.avg_entry_price) } : {}),
      ...(p.change_today !== undefined && Number.isFinite(money(p.change_today)) ? { changeToday: money(p.change_today) } : {}),
    }));
  }

  // A symbol from Alpaca's asset list, or null where Alpaca holds none (its own "not found").
  // BTCUSD and BTC/USD are both found, as the one crypto asset BTC/USD.
  async asset(symbol: string): Promise<Asset | null> {
    try {
      const a = ((await this.call(`/v2/assets/${encodeURIComponent(symbol)}`)) ?? {}) as Record<string, unknown>;
      if (typeof a.symbol !== 'string' || !a.symbol) throw new BrokerError("Alpaca's answer names no asset", 200, 'unreadable');
      const min = money(a.min_order_size);
      return { symbol: a.symbol, assetClass: String(a.class ?? ''), tradable: a.tradable === true, fractionable: a.fractionable === true, minOrderSize: Number.isFinite(min) && min > 0 ? min : null, status: String(a.status ?? '') };
    } catch (error) {
      if (error instanceof BrokerError && error.status === 404) return null;
      throw error;
    }
  }

  // The order exactly as it would be sent: a market order, good till cancelled for
  // crypto and for the day for a stock, sized by quantity or by dollars.
  orderBody(intent: OrderIntent, clientOrderId: string): OrderBody {
    if (!intent.qty === !intent.notional) throw new BrokerError('An order is sized by quantity or by dollars, one of the two.');
    const size = intent.qty ?? intent.notional ?? 0;
    if (!(size > 0)) throw new BrokerError('An order size must be above zero.');
    if (intent.qty && quantity(intent.qty) === '0') throw new BrokerError(`A quantity goes to Alpaca with at most nine decimals, and ${intent.qty} is less than that.`);
    const type = intent.type ?? 'market';
    const price = (p: number | undefined) => (p !== undefined && Number.isFinite(p) && p > 0 ? p.toFixed(2) : null);
    if (type !== 'market') {
      // A resting order is a sale of a quantity, never of dollars, at prices of its own.
      if (intent.side !== 'sell' || !intent.qty) throw new BrokerError('A limit or stop-limit order here is a sale by quantity: a standing exit.');
      if (!price(intent.limitPrice)) throw new BrokerError(`A ${type} order needs a limit price above zero.`);
      if (type === 'stop_limit' && !price(intent.stopPrice)) throw new BrokerError('A stop-limit order needs a stop price above zero.');
    }
    return {
      symbol: intent.symbol,
      side: intent.side,
      type,
      time_in_force: isCrypto(intent.symbol) ? 'gtc' : 'day',
      ...(intent.qty ? { qty: quantity(intent.qty) } : { notional: intent.notional!.toFixed(2) }),
      ...(type !== 'market' ? { limit_price: price(intent.limitPrice)! } : {}),
      ...(type === 'stop_limit' ? { stop_price: price(intent.stopPrice)! } : {}),
      client_order_id: clientOrderId,
    };
  }

  // An order Alpaca refuses throws with kind refused. Any other failure, and an answer
  // that names no order, leaves the order's outcome unknown.
  async place(body: OrderBody): Promise<PlacedOrder> {
    const placed = (await this.call('/v2/orders', { method: 'POST', body })) as Record<string, unknown> | null;
    const id = typeof placed?.id === 'string' ? placed.id : '';
    if (!id) throw new BrokerError("Alpaca's answer names no order", 200, 'unreadable');
    return { id, status: String(placed?.status ?? '') };
  }

  // An order placed before, read again: an order in dollars learns its quantity here.
  async order(id: string): Promise<OrderState> {
    const o = ((await this.call(`/v2/orders/${encodeURIComponent(id)}`)) ?? {}) as Record<string, unknown>;
    const avg = money(o.filled_avg_price);
    return { id: String(o.id ?? id), status: String(o.status ?? ''), filledQty: money(o.filled_qty), filledAvgPrice: Number.isFinite(avg) ? avg : null };
  }

  // Asks Alpaca to cancel an order that has not filled. Alpaca answers at once and cancels
  // when it can; an order already filled is refused by Alpaca, in its own words.
  async cancel(id: string): Promise<void> {
    await this.call(`/v2/orders/${encodeURIComponent(id)}`, { method: 'DELETE' });
  }

  // An order by the id primerkit gave it as it was sent, or null where Alpaca holds none:
  // how an order whose answer was lost is found again. Only Alpaca's own "not found" (404)
  // says it holds none; an answer that names no order cannot be read, and throws.
  async orderByClientId(clientOrderId: string): Promise<OrderState | null> {
    try {
      const o = ((await this.call(`/v2/orders:by_client_order_id?client_order_id=${encodeURIComponent(clientOrderId)}`)) ?? {}) as Record<string, unknown>;
      if (typeof o.id !== 'string' || !o.id) throw new BrokerError("Alpaca's answer names no order", 200, 'unreadable');
      return { id: o.id, status: String(o.status ?? ''), filledQty: money(o.filled_qty) };
    } catch (error) {
      if (error instanceof BrokerError && error.status === 404) return null;
      throw error;
    }
  }
}
