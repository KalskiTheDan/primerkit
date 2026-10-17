import { randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AlpacaBroker, BrokerError, BrokerLog, capsProblems, keychainProgram, keyRunner, LOCK_STALE_MS, modeProblem, OrderGuard, osKeychain, type BrokerMode, type Caps, type KeyRunner, type LogEvent } from '../src/index';

// A fake of Alpaca's paper Trading API: the account, the orders it takes and what it then
// holds. An order fills at once at a fixed price unless fills are held back, and the
// positions follow the fills unless a test sets them itself. It can also take an order
// and lose the answer, answer in a form that cannot be read, never answer, or redirect.
interface Seen {
  method: string;
  path: string;
  headers: IncomingMessage['headers'];
  body: string;
}
const PRICE: Record<string, number> = { BTCUSD: 84_000, ETHUSD: 2_000, XMPL: 100 };
const seen: Seen[] = [];
const elsewhere: Seen[] = [];
const holdings = new Map<string, number>();
const orders = new Map<string, { status: string; filled_qty: string; client_order_id: string }>();
let positions: Array<{ symbol: string; qty?: string; market_value?: string }> | null = null;
let status = 'ACTIVE';
let equity: string | null = '100000';
let failOrders = 0;
let refuseWith: [number, unknown] | null = null; // how a failed order is refused: a 422 unless set
let fills = true;
// How the fake answers an order: ok; taken, and the connection dropped before the answer;
// dropped before it is taken; taken, and answered in words; taken, and answered with no
// id; never answered; a server error.
let orderAnswer: 'ok' | 'taken-then-dropped' | 'dropped' | 'words' | 'no-id' | 'never' | 'error-500' | 'redirect' = 'ok';
let redirect = false;
let lookupNamesNoOrder = false; // the lookup by client order id answers 200 with an empty object
let server: Server;
let other: Server;
let base = '';
let otherBase = '';

beforeAll(async () => {
  other = createServer((req, res) => {
    let body = '';
    req.on('data', (c: Buffer) => (body += c.toString()));
    req.on('end', () => {
      elsewhere.push({ method: req.method ?? '', path: req.url ?? '', headers: req.headers, body });
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ id: 'order-elsewhere', status: 'accepted' }));
    });
  });
  await new Promise<void>((r) => other.listen(0, '127.0.0.1', () => r()));
  otherBase = `http://127.0.0.1:${(other.address() as AddressInfo).port}`;
  server = createServer((req, res) => {
    let body = '';
    req.on('data', (c: Buffer) => (body += c.toString()));
    req.on('end', () => {
      seen.push({ method: req.method ?? '', path: req.url ?? '', headers: req.headers, body });
      const json = (code: number, value: unknown) => res.writeHead(code, { 'Content-Type': 'application/json' }).end(JSON.stringify(value));
      if (redirect) return void res.writeHead(307, { Location: `${otherBase}${req.url}` }).end();
      if (req.headers['apca-api-key-id'] !== 'PKTEST' || req.headers['apca-api-secret-key'] !== 'test-secret') return json(403, { message: 'forbidden' });
      if (req.url === '/v2/account') return json(200, { id: 'a1', account_number: 'PA1234', status, ...(equity === null ? {} : { equity }), cash: '100000', buying_power: '200000' });
      if (req.url === '/v2/positions') {
        const held = [...holdings].filter(([, qty]) => qty !== 0).map(([symbol, qty]) => ({ symbol, qty: String(qty), market_value: String(qty * (PRICE[symbol] ?? 1)) }));
        return json(200, positions ?? held);
      }
      if (req.url === '/v2/orders' && req.method === 'POST') {
        if (failOrders > 0) {
          failOrders -= 1;
          return json(refuseWith?.[0] ?? 422, refuseWith?.[1] ?? { message: 'insufficient balance for BTC' });
        }
        if (orderAnswer === 'never') return;
        if (orderAnswer === 'dropped') return void req.socket.destroy();
        if (orderAnswer === 'error-500') return json(500, { message: 'internal error' });
        if (orderAnswer === 'redirect') return void res.writeHead(307, { Location: `${otherBase}/v2/orders` }).end();
        const o = JSON.parse(body) as { symbol: string; side: string; qty?: string; notional?: string; client_order_id: string };
        const symbol = o.symbol.replace('/', '');
        const qty = o.qty ? Number(o.qty) : Number(o.notional) / (PRICE[symbol] ?? 1);
        const id = `o${seen.length}`;
        if (fills) holdings.set(symbol, (holdings.get(symbol) ?? 0) + (o.side === 'buy' ? qty : -qty));
        orders.set(id, { ...(fills ? { status: 'filled', filled_qty: String(qty) } : { status: 'accepted', filled_qty: '0' }), client_order_id: o.client_order_id });
        if (orderAnswer === 'taken-then-dropped') return void req.socket.destroy();
        if (orderAnswer === 'words') return void res.writeHead(200, { 'Content-Type': 'text/plain' }).end('accepted');
        if (orderAnswer === 'no-id') return json(200, { status: 'accepted' });
        return json(200, { id, status: 'accepted' });
      }
      const byClient = /^\/v2\/orders:by_client_order_id\?client_order_id=([^&]+)$/.exec(req.url ?? '');
      if (byClient && req.method === 'GET') {
        if (lookupNamesNoOrder) return json(200, {});
        const found = [...orders].find(([, o]) => o.client_order_id === decodeURIComponent(byClient[1]!));
        return found ? json(200, { id: found[0], ...found[1] }) : json(404, { message: 'order not found' });
      }
      const one = /^\/v2\/orders\/([^/?]+)$/.exec(req.url ?? '');
      if (one && req.method === 'GET') {
        const o = orders.get(one[1]!);
        return o ? json(200, { id: one[1], ...o }) : json(404, { message: 'order not found' });
      }
      // Alpaca's asset list: BTC/USD under either spelling, and one stock.
      const asset = /^\/v2\/assets\/([^/?]+)$/.exec(req.url ?? '');
      if (asset && req.method === 'GET') {
        const name = decodeURIComponent(asset[1]!);
        if (name === 'BTC/USD' || name === 'BTCUSD') return json(200, { id: 'x1', class: 'crypto', exchange: 'CRYPTO', symbol: 'BTC/USD', status: 'active', tradable: true, fractionable: true, min_order_size: '0.0001' });
        if (name === 'XMPL') return json(200, { id: 'x2', class: 'us_equity', exchange: 'NASDAQ', symbol: 'XMPL', status: 'active', tradable: true, fractionable: false });
        return json(404, { message: 'asset not found' });
      }
      json(404, { message: 'not found' });
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => {
  server.closeAllConnections();
  server.close();
  other.close();
});
beforeEach(() => {
  seen.length = 0;
  elsewhere.length = 0;
  holdings.clear();
  orders.clear();
  positions = null;
  status = 'ACTIVE';
  equity = '100000';
  failOrders = 0;
  refuseWith = null;
  fills = true;
  orderAnswer = 'ok';
  redirect = false;
  lookupNamesNoOrder = false;
});

const broker = (timeoutMs?: number) => new AlpacaBroker({ keyId: 'PKTEST', secret: 'test-secret', base, ...(timeoutMs ? { timeoutMs } : {}) });
const CAPS: Caps = { maxNotional: 100, maxPositionShare: 0.1, symbols: ['BTC/USD', 'ETH/USD'], maxOrdersPerDay: 2 };
const MANY: Caps = { ...CAPS, maxOrdersPerDay: 10 };
const newLog = () => new BrokerLog(join(mkdtempSync(join(tmpdir(), 'pk-broker-')), 'alpaca.jsonl'));
const guard = (mode: BrokerMode, caps: Caps | null = CAPS, log = newLog(), timeoutMs?: number) => ({
  log,
  guard: new OrderGuard({ broker: broker(timeoutMs), mode, caps, log, now: () => new Date('2026-09-27T12:00:00Z') }),
});
const posts = () => seen.filter((s) => s.method === 'POST');
const yes = async () => true;
const events = (log: BrokerLog) => log.read().map((e) => e.event);

describe('Alpaca, paper only', () => {
  it("sends the keys in Alpaca's two headers, to Alpaca only, and reads the account and positions", async () => {
    positions = [{ symbol: 'BTCUSD', qty: '0.001', market_value: '84.46' }];
    const b = broker();
    expect(await b.account()).toEqual({ id: 'a1', number: 'PA1234', status: 'ACTIVE', equity: 100000, cash: 100000, buyingPower: 200000 });
    expect(await b.positions()).toEqual([{ symbol: 'BTCUSD', qty: 0.001, marketValue: 84.46 }]);
    expect(seen[0]?.headers.authorization).toBeUndefined();
  });

  it('refuses a live base, and says so when the keys are wrong', async () => {
    expect(() => new AlpacaBroker({ keyId: 'x', secret: 'y', base: 'https://api.alpaca.markets' })).toThrow("primerkit trades on Alpaca's paper API only");
    await expect(new AlpacaBroker({ keyId: 'x', secret: 'y', base }).account()).rejects.toThrow('Alpaca did not accept the keys');
  });

  it('builds the order as it would be sent: good till cancelled for crypto, for the day for any other symbol', () => {
    const b = broker();
    expect(b.orderBody({ symbol: 'BTC/USD', side: 'buy', notional: 25 }, 'c1')).toEqual({ symbol: 'BTC/USD', side: 'buy', type: 'market', time_in_force: 'gtc', notional: '25.00', client_order_id: 'c1' });
    expect(b.orderBody({ symbol: 'XMPL', side: 'sell', qty: 2 }, 'c2')).toMatchObject({ time_in_force: 'day', qty: '2' });
    expect(() => b.orderBody({ symbol: 'ETH/USD', side: 'buy', qty: 1, notional: 5 }, 'c3')).toThrow('one of the two');
  });

  it('writes a quantity in plain digits, never in exponent form, and refuses one below nine decimals', () => {
    const b = broker();
    expect(b.orderBody({ symbol: 'BTC/USD', side: 'sell', qty: 5e-7 }, 'q1').qty).toBe('0.0000005');
    expect(b.orderBody({ symbol: 'BTC/USD', side: 'sell', qty: 0.1 + 0.2 }, 'q2').qty).toBe('0.3');
    expect(b.orderBody({ symbol: 'XMPL', side: 'sell', qty: 2 }, 'q3').qty).toBe('2');
    expect(() => b.orderBody({ symbol: 'BTC/USD', side: 'sell', qty: 1e-10 }, 'q4')).toThrow('at most nine decimals');
  });

  it("gives Alpaca's own words for an order it refuses with 403, and names the keys only when they are what was refused", async () => {
    const b = broker();
    const body = () => b.orderBody({ symbol: 'BTC/USD', side: 'buy', notional: 25 }, `c-${Math.random()}`);
    failOrders = 1;
    refuseWith = [403, { code: 40310000, message: 'insufficient buying power' }];
    const refused = await b.place(body()).catch((e: unknown) => e);
    expect(refused).toBeInstanceOf(BrokerError);
    expect((refused as BrokerError).message).toBe('Alpaca: insufficient buying power');
    expect((refused as BrokerError).kind).toBe('refused');
    // The keys: a 401, or a 403 that says no more than forbidden.
    failOrders = 1;
    refuseWith = [401, { code: 40110000, message: 'request is not authorized' }];
    await expect(b.place(body())).rejects.toThrow('Alpaca did not accept the keys');
    await expect(new AlpacaBroker({ keyId: 'x', secret: 'y', base }).account()).rejects.toThrow('Alpaca did not accept the keys');
    failOrders = 1;
    refuseWith = [403, {}];
    await expect(b.place(body())).rejects.toThrow('Alpaca did not accept the keys');
  });

  it('reads an order again, with how much of it filled, and finds one by the id primerkit gave it', async () => {
    const b = broker();
    const placed = await b.place(b.orderBody({ symbol: 'BTC/USD', side: 'buy', notional: 84 }, 'c4'));
    // The fake gives no average price, so none is read.
    expect(await b.order(placed.id)).toEqual({ id: placed.id, status: 'filled', filledQty: 0.001, filledAvgPrice: null });
    expect(await b.orderByClientId('c4')).toEqual({ id: placed.id, status: 'filled', filledQty: 0.001 });
    expect(await b.orderByClientId('never-sent')).toBeNull();
  });

  it('never follows a redirect: the keys and the order go to the paper address and nowhere a server points them', async () => {
    redirect = true;
    const b = broker();
    await expect(b.place(b.orderBody({ symbol: 'BTC/USD', side: 'buy', notional: 25 }, 'c5'))).rejects.toThrow('Alpaca answered with a redirect (307), which primerkit does not follow');
    await expect(b.account()).rejects.toThrow('redirect (307)');
    expect(elsewhere).toEqual([]);
    // CONTROL: the other server does answer, so a followed redirect would have reached it.
    expect((await fetch(`${otherBase}/v2/orders`, { method: 'POST', body: '{}' })).status).toBe(200);
    expect(elsewhere).toHaveLength(1);
  });

  it('says which way a call went wrong: refused by Alpaca, no answer, or an answer that cannot be read', async () => {
    const b = broker(300);
    const body = () => b.orderBody({ symbol: 'BTC/USD', side: 'buy', notional: 25 }, `c-${Math.random()}`);
    const kindOf = async (answer: typeof orderAnswer) => {
      orderAnswer = answer;
      const error = await b.place(body()).then(
        () => null,
        (e: unknown) => e,
      );
      return error instanceof BrokerError ? error.kind : 'no error';
    };
    failOrders = 1;
    expect(await kindOf('ok')).toBe('refused');
    expect(await kindOf('dropped')).toBe('no_answer');
    expect(await kindOf('taken-then-dropped')).toBe('no_answer');
    expect(await kindOf('never')).toBe('no_answer');
    expect(await kindOf('error-500')).toBe('no_answer');
    expect(await kindOf('redirect')).toBe('no_answer');
    expect(await kindOf('words')).toBe('unreadable');
    expect(await kindOf('no-id')).toBe('unreadable');
    expect(await kindOf('ok')).toBe('no error');
  });

  it('reads a number only from a number or a string that holds one', async () => {
    positions = [{ symbol: 'BTCUSD', qty: '', market_value: '' }];
    const [p] = await broker().positions();
    expect(Number.isNaN(p!.qty)).toBe(true);
    expect(Number.isNaN(p!.marketValue)).toBe(true);
  });
});

describe('the caps', () => {
  it('are usable only with all four set, as numbers, above zero, the share at most 1 and the orders a day whole', () => {
    expect(capsProblems(CAPS)).toEqual([]);
    expect(capsProblems({ symbols: ['BTC/USD'] })).toEqual([
      'max_notional is missing, where it takes the dollars an order may carry, above 0',
      'max_position_share is missing, where it takes the share of equity one symbol may reach, above 0 and at most 1',
      'max_orders_per_day is missing, where it takes a whole number above 0',
    ]);
    expect(capsProblems({ ...CAPS, maxNotional: 'fifty' })).toEqual(['max_notional is "fifty", where it takes the dollars an order may carry, above 0']);
    for (const share of [0, -0.1, 1.5, Number.NaN, '0.05']) expect(capsProblems({ ...CAPS, maxPositionShare: share })).toHaveLength(1);
    for (const n of [0, 2.5, -1, Number.POSITIVE_INFINITY]) expect(capsProblems({ ...CAPS, maxOrdersPerDay: n })).toHaveLength(1);
    for (const symbols of [[], 'BTC/USD', [''], null]) expect(capsProblems({ ...CAPS, symbols })[0]).toMatch(/^symbols /);
  });
});

describe('the mode', () => {
  it('is one of four names, and anything else is named as wrong', () => {
    for (const mode of ['off', 'read', 'dry_run', 'paper']) expect(modeProblem(mode)).toBeNull();
    expect(modeProblem('live')).toBe('mode is "live", where it takes off, read, dry_run or paper');
    expect(modeProblem(true)).toBe('mode is true, where it takes off, read, dry_run or paper');
    expect(modeProblem(undefined)).toBe('mode is missing, where it takes off, read, dry_run or paper');
  });

  it('places nothing in a mode that is not one of the four, where it used to place as in paper mode', async () => {
    for (const mode of ['live', 'papr', 'PAPER', true, '']) {
      const { guard: g } = guard(mode as unknown as BrokerMode);
      const r = await g.submit({ symbol: 'BTC/USD', side: 'buy', notional: 25 }, yes);
      expect(r.outcome).toBe('refused');
      expect(r.checked.refused[0]).toBe(`mode is ${JSON.stringify(mode)}, where it takes off, read, dry_run or paper, so no order goes`);
    }
    expect(posts()).toHaveLength(0);
    // CONTROL: the same order in paper mode is placed.
    expect((await guard('paper').guard.submit({ symbol: 'BTC/USD', side: 'buy', notional: 25 }, yes)).outcome).toBe('placed');
  });
});

describe('the guard', () => {
  it('places nothing until the person sets their own caps', async () => {
    const { guard: g } = guard('paper', null);
    const r = await g.submit({ symbol: 'BTC/USD', side: 'buy', notional: 10 }, yes);
    expect(r.outcome).toBe('refused');
    expect(r.checked.refused.join(' ')).toContain('no caps are set');
    expect(posts()).toHaveLength(0);
  });

  it('places nothing while a cap is missing or not a number, since such a cap would compare as no limit', async () => {
    for (const caps of [{ symbols: ['BTC/USD'] }, { ...CAPS, maxNotional: 'fifty' }, { ...CAPS, maxOrdersPerDay: undefined }, { ...CAPS, maxPositionShare: Number.NaN }]) {
      const { guard: g } = guard('paper', caps as unknown as Caps);
      const r = await g.submit({ symbol: 'BTC/USD', side: 'buy', notional: 5000 }, yes);
      expect(r.outcome).toBe('refused');
      expect(r.checked.refused.join(' ')).toContain('your caps in config.yaml cannot be used, so no order goes');
    }
    expect(posts()).toHaveLength(0);
  });

  it('names every cap an order breaks', async () => {
    positions = [{ symbol: 'BTCUSD', qty: '0.1', market_value: '9990' }];
    const { guard: g } = guard('paper');
    const over = await g.check({ symbol: 'BTC/USD', side: 'buy', notional: 150 });
    expect(over.checked.refused).toEqual(['$150.00 is over your cap of $100.00 an order', 'BTC/USD would be 10.1% of equity, over your cap of 10.0%']);
    const other = await g.check({ symbol: 'SOL/USD', side: 'buy', notional: 10 });
    expect(other.checked.refused).toContain('SOL/USD is not in your symbols (BTC/USD, ETH/USD)');
    status = 'ACCOUNT_CLOSED';
    expect((await g.check({ symbol: 'ETH/USD', side: 'buy', notional: 10 })).checked.refused).toContain('the account is ACCOUNT_CLOSED, not ACTIVE');
  });

  it('counts a holding toward the share cap whether Alpaca names it with the slash or without', async () => {
    const { guard: g } = guard('paper');
    for (const symbol of ['BTCUSD', 'BTC/USD']) {
      positions = [{ symbol, qty: '0.1', market_value: '9990' }];
      expect((await g.check({ symbol: 'BTC/USD', side: 'buy', notional: 50 })).checked.refused).toEqual(['BTC/USD would be 10.0% of equity, over your cap of 10.0%']);
    }
  });

  it("places nothing when the account answer carries no equity, or a holding's value is missing or empty, since the share cap could not be checked", async () => {
    const { guard: g } = guard('paper', { ...CAPS, maxPositionShare: 0.0001 });
    expect((await g.submit({ symbol: 'BTC/USD', side: 'buy', notional: 50 }, yes)).outcome).toBe('refused');
    equity = null;
    const noEquity = await g.submit({ symbol: 'BTC/USD', side: 'buy', notional: 50 }, yes);
    expect(noEquity.outcome).toBe('refused');
    expect(noEquity.checked.refused).toContain("the account's equity is not in Alpaca's answer, so the share of equity an order reaches cannot be checked");
    equity = '0';
    expect((await g.check({ symbol: 'BTC/USD', side: 'sell', notional: 50 })).checked.refused).toContain("the account's equity is $0.00, so the share of equity an order reaches cannot be checked");
    equity = '';
    expect((await g.check({ symbol: 'BTC/USD', side: 'buy', notional: 50 })).checked.refused).toContain("the account's equity is not in Alpaca's answer, so the share of equity an order reaches cannot be checked");
    equity = '100000';
    const { guard: g2 } = guard('paper');
    for (const holding of [{ symbol: 'BTCUSD', qty: '0.001' }, { symbol: 'BTCUSD', qty: '0.001', market_value: '' }]) {
      positions = [holding];
      expect((await g2.check({ symbol: 'BTC/USD', side: 'buy', notional: 50 })).checked.refused).toContain("Alpaca's answer gives no value for the BTC/USD held, so the share of equity an order reaches cannot be checked");
    }
    expect(posts()).toHaveLength(0);
  });

  it('sizes a buy in dollars only, so no price a person types can carry it past the dollar caps', async () => {
    const { guard: g } = guard('paper');
    const r = await g.submit({ symbol: 'BTC/USD', side: 'buy', qty: 5 }, yes);
    expect(r.outcome).toBe('refused');
    expect(r.checked.refused).toEqual(['a buy is sized in dollars, so your caps hold at any price: give its dollars; a quantity is for selling what you hold']);
    expect(posts()).toHaveLength(0);
  });

  it("sells only what is held, and values a sale by quantity at Alpaca's own figures", async () => {
    const { guard: g } = guard('paper', MANY);
    // Nothing held: no sale, in dollars or by quantity, for crypto or any other symbol.
    expect((await g.submit({ symbol: 'BTC/USD', side: 'sell', notional: 10 }, yes)).checked.refused).toEqual(['no BTC/USD is held, and primerkit sells only what is held']);
    const short = guard('paper', { ...MANY, symbols: ['XMPL'] });
    expect((await short.guard.submit({ symbol: 'XMPL', side: 'sell', qty: 10 }, yes)).checked.refused).toEqual(['no XMPL is held, and primerkit sells only what is held']);
    holdings.set('BTCUSD', 0.01); // $840 at the fake's price
    expect((await g.check({ symbol: 'BTC/USD', side: 'sell', qty: 0.02 })).checked.refused).toContain('0.02 BTC/USD is more than the 0.01 held, and primerkit sells only what is held');
    expect((await g.check({ symbol: 'BTC/USD', side: 'sell', notional: 900 })).checked.refused).toContain('$900.00 is more than the $840.00 of BTC/USD held, and primerkit sells only what is held');
    // Half of it is $420 by Alpaca's figures, over the $100 cap, whatever anyone types.
    expect((await g.check({ symbol: 'BTC/USD', side: 'sell', qty: 0.005 })).checked.refused).toEqual(['$420.00 is over your cap of $100.00 an order']);
    expect(posts()).toHaveLength(0);
    // CONTROL: a sale within what is held and within the cap is placed.
    expect((await g.submit({ symbol: 'BTC/USD', side: 'sell', qty: 0.001 }, yes)).outcome).toBe('placed');
    expect(JSON.parse(posts()[0]!.body)).toMatchObject({ symbol: 'BTC/USD', side: 'sell', qty: '0.001' });
  });

  it('sends nothing on a dry run, and logs the body it would have sent', async () => {
    const { guard: g, log } = guard('dry_run');
    const r = await g.submit({ symbol: 'BTC/USD', side: 'buy', notional: 25 }, yes);
    expect(r.outcome).toBe('dry_run');
    expect(posts()).toHaveLength(0);
    expect(events(log)).toEqual(['checked', 'dry_run']);
  });

  it('places a paper order only on a yes, exactly as shown, logs it before it is sent, and keeps to the orders a day', async () => {
    const { guard: g, log } = guard('paper');
    const no = await g.submit({ symbol: 'BTC/USD', side: 'buy', notional: 25 }, async () => false);
    expect(no.outcome).toBe('declined');
    expect(posts()).toHaveLength(0);
    let shown: unknown = null;
    const placed = await g.submit({ symbol: 'BTC/USD', side: 'buy', notional: 25 }, async (body) => {
      shown = body;
      return true;
    });
    expect(placed.outcome).toBe('placed');
    expect(JSON.parse(posts()[0]!.body)).toEqual(shown);
    expect(events(log).slice(-4)).toEqual(['checked', 'checked', 'sending', 'placed']);
    expect((await g.submit({ symbol: 'ETH/USD', side: 'buy', notional: 10 }, yes)).outcome).toBe('placed');
    const third = await g.submit({ symbol: 'ETH/USD', side: 'buy', notional: 10 }, yes);
    expect(third.checked.refused).toContain('2 orders were sent today, your cap is 2 (a day is a UTC day)');
    expect(log.read().filter((e) => e.event === 'placed')).toHaveLength(2);
    expect(log.disabled()).toBeNull();
    expect(existsSync(log.lockPath)).toBe(false);
  });

  it('turns the connection off after three failed orders in a row, until it is turned back on by hand', async () => {
    failOrders = 3;
    const { guard: g, log } = guard('paper', MANY);
    for (let i = 0; i < 3; i += 1) expect((await g.submit({ symbol: 'BTC/USD', side: 'buy', notional: 10 }, yes)).outcome).toBe('failed');
    expect(log.disabled()).toBe('3 orders failed in a row');
    const after = await g.submit({ symbol: 'BTC/USD', side: 'buy', notional: 10 }, yes);
    expect(after.checked.refused[0]).toMatch(/^the connection is off since a stop condition: 3 orders failed in a row/);
    // An order Alpaca refused is not one that went through, so it is not counted toward the day.
    expect(log.sentOn('2026-09-27')).toBe(0);
    log.append({ event: 'enabled' });
    expect(log.disabled()).toBeNull();
  });

  it('counts the failed orders in a row from the time the connection was turned back on by hand', async () => {
    failOrders = 4;
    const { guard: g, log } = guard('paper', MANY);
    for (let i = 0; i < 3; i += 1) await g.submit({ symbol: 'BTC/USD', side: 'buy', notional: 10 }, yes);
    expect(log.disabled()).toBe('3 orders failed in a row');
    log.append({ event: 'enabled' });
    // One refusal after the person turned it back on is one in a row, not four.
    expect((await g.submit({ symbol: 'BTC/USD', side: 'buy', notional: 10 }, yes)).outcome).toBe('failed');
    expect(log.disabled()).toBeNull();
    // CONTROL: three in a row after the enable turn it off again.
    failOrders = 2;
    for (let i = 0; i < 2; i += 1) await g.submit({ symbol: 'BTC/USD', side: 'buy', notional: 10 }, yes);
    expect(log.disabled()).toBe('3 orders failed in a row');
  });

  it('waits for an order by quantity to settle as well, so a sale Alpaca took and has not filled stops nothing', async () => {
    holdings.set('BTCUSD', 0.002);
    fills = false;
    const { guard: g, log } = guard('paper', MANY);
    expect((await g.submit({ symbol: 'BTC/USD', side: 'sell', qty: 0.001 }, yes)).outcome).toBe('placed');
    expect(await g.reconcile()).toEqual({ drift: [], waiting: ['BTCUSD'] });
    expect(log.disabled()).toBeNull();
    // Alpaca then rejects it with nothing filled: what was held before is what is expected.
    for (const [id, o] of orders) orders.set(id, { ...o, status: 'rejected', filled_qty: '0' });
    expect(await g.reconcile()).toEqual({ drift: [{ symbol: 'BTCUSD', expected: 0.002, held: 0.002 }], waiting: [] });
    expect(log.disabled()).toBeNull();
    // CONTROL: once it has settled, holdings that differ from the record still stop the connection.
    positions = [{ symbol: 'BTCUSD', qty: '0.02', market_value: '1680' }];
    await g.reconcile();
    expect(log.disabled()).toBe('the broker holds 0.02 BTCUSD where the log expects 0.002');
  });

  it("turns the connection off when the broker's holdings drift from the log's record", async () => {
    holdings.set('BTCUSD', 0.002);
    const { guard: g, log } = guard('paper');
    expect((await g.submit({ symbol: 'BTC/USD', side: 'sell', qty: 0.001 }, yes)).outcome).toBe('placed');
    expect(await g.reconcile()).toEqual({ drift: [{ symbol: 'BTCUSD', expected: 0.002 - 0.001, held: 0.002 - 0.001 }], waiting: [] });
    expect(log.disabled()).toBeNull();
    positions = [{ symbol: 'BTCUSD', qty: '0.002', market_value: '168' }];
    await g.reconcile();
    expect(log.disabled()).toContain(`the broker holds 0.002 BTCUSD where the log expects ${0.002 - 0.001}`);
  });

  it('checks an order in dollars by the quantity Alpaca says it filled, so holdings ten times too large turn the connection off', async () => {
    const { guard: g, log } = guard('paper');
    expect((await g.submit({ symbol: 'BTC/USD', side: 'buy', notional: 84 }, yes)).outcome).toBe('placed');
    expect(await g.reconcile()).toEqual({ drift: [{ symbol: 'BTCUSD', expected: 0.001, held: 0.001 }], waiting: [] });
    positions = [{ symbol: 'BTCUSD', qty: '0.01', market_value: '840' }];
    await g.reconcile();
    expect(log.disabled()).toBe('the broker holds 0.01 BTCUSD where the log expects 0.001');
  });

  it('takes the record from the last order, so an order in dollars after one by quantity raises no false stop', async () => {
    holdings.set('BTCUSD', 0.002);
    const { guard: g, log } = guard('paper');
    expect((await g.submit({ symbol: 'BTC/USD', side: 'sell', qty: 0.001 }, yes)).outcome).toBe('placed');
    expect((await g.submit({ symbol: 'BTC/USD', side: 'buy', notional: 84 }, yes)).outcome).toBe('placed');
    const after = 0.002 - 0.001 + 0.001;
    expect((await g.reconcile()).drift).toEqual([{ symbol: 'BTCUSD', expected: after, held: after }]);
    expect(log.disabled()).toBeNull();
  });

  it('waits for an order in dollars to settle before comparing it, and places no other order for that symbol while it waits', async () => {
    fills = false;
    const { guard: g, log } = guard('paper', MANY);
    expect((await g.submit({ symbol: 'BTC/USD', side: 'buy', notional: 84 }, yes)).outcome).toBe('placed');
    expect(await g.reconcile()).toEqual({ drift: [], waiting: ['BTCUSD'] });
    expect(log.disabled()).toBeNull();
    // Holdings ten times too large would go unseen while it waits, so the next order waits too.
    positions = [{ symbol: 'BTCUSD', qty: '0.01', market_value: '840' }];
    const next = await g.submit({ symbol: 'BTC/USD', side: 'buy', notional: 10 }, yes);
    expect(next.outcome).toBe('refused');
    expect(next.checked.refused).toEqual(['the last BTC/USD order has not settled at Alpaca, so what is held cannot be compared with the record yet: try again once it has (primerkit broker reconcile shows it)']);
    expect(posts()).toHaveLength(1);
    // CONTROL: another symbol, with no order waiting, still goes.
    expect((await g.submit({ symbol: 'ETH/USD', side: 'buy', notional: 10 }, yes)).outcome).toBe('placed');
    // Once Alpaca says the order filled, the holdings are compared, and the difference stops the connection.
    for (const [id, o] of orders) if (o.client_order_id === JSON.parse(posts()[0]!.body).client_order_id) orders.set(id, { ...o, status: 'filled', filled_qty: '0.001' });
    expect((await g.submit({ symbol: 'BTC/USD', side: 'buy', notional: 10 }, yes)).outcome).toBe('refused');
    expect(log.disabled()).toBe('the broker holds 0.01 BTCUSD where the log expects 0.001');
  });

  it('compares the record before every order, so a change made outside primerkit stops the next one', async () => {
    const { guard: g, log } = guard('paper');
    await g.submit({ symbol: 'BTC/USD', side: 'buy', notional: 84 }, yes);
    positions = [{ symbol: 'BTCUSD', qty: '0.005', market_value: '420' }];
    const next = await g.submit({ symbol: 'BTC/USD', side: 'buy', notional: 10 }, yes);
    expect(next.outcome).toBe('refused');
    expect(next.checked.refused).toContain('the connection is now off: the broker holds 0.005 BTCUSD where the log expects 0.001. primerkit broker reconcile shows the record, and primerkit broker enable turns it back on');
    expect(log.disabled()).toBe('the broker holds 0.005 BTCUSD where the log expects 0.001');
    expect(posts()).toHaveLength(1);
  });

  it('counts a holding with no quantity in the answer as drift', async () => {
    const { guard: g, log } = guard('paper');
    await g.submit({ symbol: 'BTC/USD', side: 'buy', notional: 84 }, yes);
    positions = [{ symbol: 'BTCUSD', market_value: '84' }];
    await g.reconcile();
    expect(log.disabled()).toBe('the broker holds BTCUSD with no quantity in its answer where the log expects 0.001');
  });

  it('starts the record again when the connection is turned back on by hand, so the next order goes and is the one compared', async () => {
    const { guard: g, log } = guard('paper', MANY);
    await g.submit({ symbol: 'BTC/USD', side: 'buy', notional: 84 }, yes);
    positions = [{ symbol: 'BTCUSD', qty: '0.005', market_value: '420' }];
    expect((await g.submit({ symbol: 'BTC/USD', side: 'buy', notional: 10 }, yes)).outcome).toBe('refused');
    expect(log.disabled()).toBe('the broker holds 0.005 BTCUSD where the log expects 0.001');
    // The person looks at the account and turns the connection back on: what Alpaca holds
    // then is where the record starts again, so the old order is compared no more.
    log.append({ event: 'enabled' });
    expect(await g.reconcile()).toEqual({ drift: [], waiting: [] });
    expect(log.disabled()).toBeNull();
    positions = null;
    holdings.set('BTCUSD', 0.005);
    expect((await g.submit({ symbol: 'BTC/USD', side: 'buy', notional: 84 }, yes)).outcome).toBe('placed');
    expect(log.disabled()).toBeNull();
    expect((await g.reconcile()).drift).toEqual([{ symbol: 'BTCUSD', expected: 0.005 + 0.001, held: 0.005 + 0.001 }]);
    // Drift after the new order turns it off again.
    positions = [{ symbol: 'BTCUSD', qty: '0.02', market_value: '1680' }];
    await g.reconcile();
    expect(log.disabled()).toBe(`the broker holds 0.02 BTCUSD where the log expects ${0.005 + 0.001}`);
  });

  it('places nothing for a symbol whose holding has no quantity in the answer, since the record after the order could not be kept', async () => {
    positions = [{ symbol: 'BTCUSD', market_value: '84' }];
    const { guard: g, log } = guard('paper');
    const r = await g.submit({ symbol: 'BTC/USD', side: 'buy', notional: 10 }, yes);
    expect(r.outcome).toBe('refused');
    expect(r.checked.refused).toEqual(["Alpaca's answer gives no quantity for the BTC/USD held, so the record after this order could not be kept"]);
    // Another symbol, held with its quantity or not held at all, still goes.
    expect((await g.submit({ symbol: 'ETH/USD', side: 'buy', notional: 10 }, yes)).outcome).toBe('placed');
    expect(log.disabled()).toBeNull();
    expect(posts()).toHaveLength(1);
  });

  it('only ever appends to its log', async () => {
    const { guard: g, log } = guard('dry_run');
    await g.submit({ symbol: 'BTC/USD', side: 'buy', notional: 25 }, yes);
    const first = readFileSync(log.path, 'utf8');
    await g.submit({ symbol: 'ETH/USD', side: 'buy', notional: 5 }, yes);
    expect(readFileSync(log.path, 'utf8').startsWith(first)).toBe(true);
    expect(readFileSync(log.path, 'utf8').length).toBeGreaterThan(first.length);
  });

  it('places nothing in read mode', async () => {
    const { guard: g } = guard('read');
    expect((await g.submit({ symbol: 'ETH/USD', side: 'buy', notional: 10 }, yes)).checked.refused).toContain('the connection is in read mode, which places no orders');
    expect(posts()).toHaveLength(0);
  });
});

describe('after the yes', () => {
  it('checks everything once more, so a stop written while the question waited stops the order', async () => {
    const { guard: g, log } = guard('paper');
    const r = await g.submit({ symbol: 'BTC/USD', side: 'buy', notional: 25 }, async () => {
      log.append({ event: 'disabled', reason: 'a stop from another run' });
      return true;
    });
    expect(r.outcome).toBe('refused');
    expect(r.checked.refused[0]).toMatch(/^the connection is off since a stop condition: a stop from another run/);
    expect(posts()).toHaveLength(0);
    expect(events(log)).not.toContain('sending');
  });

  it('lets one order through at a time, so two started together cannot both pass a cap of one a day', async () => {
    const log = newLog();
    const one = { ...CAPS, maxOrdersPerDay: 1 };
    let release: (v: boolean) => void = () => undefined;
    const gate = new Promise<boolean>((r) => (release = r));
    let asked = 0;
    const ask = () => {
      asked += 1;
      return gate;
    };
    const first = guard('paper', one, log).guard.submit({ symbol: 'BTC/USD', side: 'buy', notional: 25 }, ask);
    const second = guard('paper', one, log).guard.submit({ symbol: 'BTC/USD', side: 'buy', notional: 25 }, ask);
    while (asked < 2) await new Promise((r) => setTimeout(r, 10));
    release(true);
    const outcomes = [(await first).outcome, (await second).outcome].sort();
    expect(outcomes).toEqual(['placed', 'refused']);
    expect(posts()).toHaveLength(1);
    expect(log.read().filter((e) => e.event === 'placed')).toHaveLength(1);
    expect(existsSync(log.lockPath)).toBe(false);
  });

  it('refuses while another run holds the lock, and takes over a lock a dead run left behind', async () => {
    const { guard: g, log } = guard('paper', MANY);
    writeFileSync(log.lockPath, '1234 2026-09-27T12:00:00.000Z\n');
    const held = await g.submit({ symbol: 'BTC/USD', side: 'buy', notional: 25 }, yes);
    expect(held.outcome).toBe('refused');
    expect(held.checked.refused).toEqual([`another primerkit order is going through right now (${log.lockPath}): try again when it is done. Where no order is running, a run ended without taking its lock away, and the lock clears itself five minutes after it was made`]);
    expect(posts()).toHaveLength(0);
    expect(existsSync(log.lockPath)).toBe(true);
    // Older than any order takes, the lock is a dead run's, and the next order takes it over.
    const old = new Date(Date.now() - LOCK_STALE_MS - 60_000);
    utimesSync(log.lockPath, old, old);
    expect((await g.submit({ symbol: 'BTC/USD', side: 'buy', notional: 25 }, yes)).outcome).toBe('placed');
    expect(existsSync(log.lockPath)).toBe(false);
  });
});

// Two runs that both hold the lock: one still going when its lock reached five minutes, or
// a clock moved under it. The lock here is one every run gets, and another run's lines
// are written to the log just before this run writes that its order is being sent.
class SharedLog extends BrokerLog {
  between: LogEvent[] = [];
  override lock(): () => void {
    return () => undefined;
  }
  override append(event: LogEvent, at?: Date): void {
    if (event.event === 'sending') for (const other of this.between.splice(0)) super.append(other, at);
    super.append(event, at);
  }
}
const sharedLog = () => new SharedLog(join(mkdtempSync(join(tmpdir(), 'pk-broker-')), 'alpaca.jsonl'));
const otherBody = (id: string) => broker().orderBody({ symbol: 'ETH/USD', side: 'buy', notional: 5 }, id);

describe('where two runs both hold the lock, the log decides', () => {
  it("sends nothing where another run's order was written to the log since this one's last check began, and that is no failure", async () => {
    const log = sharedLog();
    const g = new OrderGuard({ broker: broker(), mode: 'paper', caps: { ...CAPS, maxOrdersPerDay: 1 }, log, stop: { failures: 1, driftShare: 0.05 }, now: () => new Date('2026-09-27T12:00:00Z') });
    log.between = [{ event: 'sending', body: otherBody('primerkit-other-run'), before: 0 }];
    const r = await g.submit({ symbol: 'BTC/USD', side: 'buy', notional: 25 }, yes);
    expect(r.outcome).toBe('refused');
    expect(r.checked.refused).toEqual(['another primerkit run sent an order (primerkit-other-run) while this one was being checked, so this order was not sent: try again']);
    expect(posts()).toHaveLength(0);
    expect(events(log).slice(-3)).toEqual(['sending', 'sending', 'withdrawn']);
    // Its own line is closed, so only the other run's order waits for its outcome, and
    // only that one counts toward the day. One failure would stop this connection, and
    // an order that never went is none.
    expect(log.pending().map((e) => e.body.client_order_id)).toEqual(['primerkit-other-run']);
    expect(log.sentOn('2026-09-27')).toBe(1);
    expect(log.disabled()).toBeNull();
  });

  it('sends nothing where the other order was placed in between, since the check counted neither it nor what it bought', async () => {
    const log = sharedLog();
    const g = new OrderGuard({ broker: broker(), mode: 'paper', caps: MANY, log, now: () => new Date('2026-09-27T12:00:00Z') });
    const body = otherBody('primerkit-other-run');
    log.between = [
      { event: 'sending', body, before: 0 },
      { event: 'placed', body, order: { id: 'o-other', status: 'accepted' }, expected: null, before: 0 },
    ];
    expect((await g.submit({ symbol: 'BTC/USD', side: 'buy', notional: 25 }, yes)).outcome).toBe('refused');
    expect(posts()).toHaveLength(0);
    expect(log.pending()).toEqual([]);
  });

  it('sends nothing where a stop was written in between', async () => {
    const log = sharedLog();
    const g = new OrderGuard({ broker: broker(), mode: 'paper', caps: MANY, log, now: () => new Date('2026-09-27T12:00:00Z') });
    log.between = [{ event: 'disabled', reason: 'a stop from another run' }];
    const r = await g.submit({ symbol: 'BTC/USD', side: 'buy', notional: 25 }, yes);
    expect(r.checked.refused).toEqual(['the connection was turned off while this order was being checked (a stop from another run), so this order was not sent: try again']);
    expect(posts()).toHaveLength(0);
    expect(log.pending()).toEqual([]);
  });

  it('CONTROL: sends where nothing came in between, and where the other run withdrew its own order', async () => {
    const log = sharedLog();
    const g = new OrderGuard({ broker: broker(), mode: 'paper', caps: MANY, log, now: () => new Date('2026-09-27T12:00:00Z') });
    expect((await g.submit({ symbol: 'BTC/USD', side: 'buy', notional: 25 }, yes)).outcome).toBe('placed');
    const body = otherBody('primerkit-other-run');
    log.between = [
      { event: 'sending', body, before: 0 },
      { event: 'withdrawn', body, reason: 'made up for the test' },
    ];
    expect((await g.submit({ symbol: 'BTC/USD', side: 'buy', notional: 25 }, yes)).outcome).toBe('placed');
    expect(posts()).toHaveLength(2);
    expect(log.sentOn('2026-09-27')).toBe(2);
  });
});

describe('the lock', () => {
  it("gives a dead run's lock to one run, and a run takes away only its own", () => {
    const log = newLog();
    const old = new Date(Date.now() - LOCK_STALE_MS - 60_000);
    writeFileSync(log.lockPath, 'a dead run\n');
    utimesSync(log.lockPath, old, old);
    const mine = log.lock();
    expect(mine).not.toBeNull();
    expect(log.lock()).toBeNull();
    // Another run's lock in its place is not this run's to take away.
    writeFileSync(log.lockPath, 'another run\n');
    mine!();
    expect(readFileSync(log.lockPath, 'utf8')).toBe('another run\n');
    // Nothing is left beside the log but the lock itself.
    expect(readdirSync(dirname(log.path))).toEqual(['alpaca.jsonl.lock']);
  });

  it("reads a lock dated ahead as a dead run's, where it used to block every order until removed by hand", () => {
    const log = newLog();
    const ahead = new Date(Date.now() + 3_600_000);
    writeFileSync(log.lockPath, 'a lock from a clock set ahead\n');
    utimesSync(log.lockPath, ahead, ahead);
    const taken = log.lock();
    expect(taken).not.toBeNull();
    taken!();
    expect(existsSync(log.lockPath)).toBe(false);
  });

  it('holds a lock whose time is a little ahead of the clock, as the time of a file made this instant can be', () => {
    const log = newLog();
    const mine = log.lock();
    expect(mine).not.toBeNull();
    // A file's time is finer than the clock's milliseconds, so a lock just made can read
    // as a fraction of a millisecond ahead. Two seconds ahead stands for that here.
    const ahead = new Date(Date.now() + 2_000);
    utimesSync(log.lockPath, ahead, ahead);
    expect(log.lock()).toBeNull();
    mine!();
    expect(existsSync(log.lockPath)).toBe(false);
  });

  it('refuses, rather than fail, where the lock cannot be made at all', async () => {
    const { guard: g, log } = guard('paper');
    mkdirSync(log.lockPath, { recursive: true });
    writeFileSync(join(log.lockPath, 'kept'), '');
    const r = await g.submit({ symbol: 'BTC/USD', side: 'buy', notional: 25 }, yes);
    expect(r.outcome).toBe('refused');
    expect(r.checked.refused[0]).toMatch(/^another primerkit order is going through right now/);
    expect(posts()).toHaveLength(0);
  });
});

describe('an order whose answer is lost', () => {
  for (const answer of ['taken-then-dropped', 'words', 'no-id'] as const) {
    it(`${answer}: is recorded as unknown, not failed, turns the connection off, counts toward the day, and is found again at Alpaca`, async () => {
      const { guard: g, log } = guard('paper', { ...CAPS, maxOrdersPerDay: 1 });
      orderAnswer = answer;
      const lost = await g.submit({ symbol: 'BTC/USD', side: 'buy', notional: 25 }, yes);
      expect(lost.outcome).toBe('unknown');
      expect(orders.size).toBe(1); // Alpaca took it
      expect(events(log).slice(-3)).toEqual(['sending', 'unknown', 'disabled']);
      expect(log.disabled()).toMatch(/^an order was sent and no readable answer came back \(.+\), so Alpaca may hold order primerkit-/);
      expect(log.sentOn('2026-09-27')).toBe(1);
      orderAnswer = 'ok';
      // No second order goes, turned back on or not: its outcome is asked for first.
      log.append({ event: 'enabled' });
      const next = await g.submit({ symbol: 'BTC/USD', side: 'buy', notional: 25 }, yes);
      expect(next.outcome).toBe('refused');
      expect(next.checked.refused[0]).toMatch(/^an order primerkit sent has no outcome on record \(primerkit-.+\): primerkit broker reconcile asks Alpaca for it$/);
      expect(orders.size).toBe(1);
      const id = lost.checked.body!.client_order_id;
      expect((await g.reconcile()).resolved).toEqual([{ clientOrderId: id, taken: true }]);
      expect(log.pending()).toEqual([]);
      expect(events(log).filter((e) => e === 'placed')).toHaveLength(1);
      // Found, it counts as the day's one order, and it is the record the holdings are compared with.
      expect((await g.check({ symbol: 'BTC/USD', side: 'buy', notional: 25 })).checked.refused).toEqual(['1 orders were sent today, your cap is 1 (a day is a UTC day)']);
      expect(orders.size).toBe(1);
    });
  }

  for (const answer of ['dropped', 'never', 'error-500', 'redirect'] as const) {
    it(`${answer}: an order Alpaca never took is also unknown until Alpaca is asked, and is then recorded as not taken`, async () => {
      const { guard: g, log } = guard('paper', { ...CAPS, maxOrdersPerDay: 1 }, newLog(), 300);
      orderAnswer = answer;
      const lost = await g.submit({ symbol: 'BTC/USD', side: 'buy', notional: 25 }, yes);
      expect(lost.outcome).toBe('unknown');
      expect(orders.size).toBe(0);
      expect(log.disabled()).not.toBeNull();
      orderAnswer = 'ok';
      expect((await g.reconcile()).resolved).toEqual([{ clientOrderId: lost.checked.body!.client_order_id, taken: false }]);
      expect(events(log).slice(-1)).toEqual(['failed']);
      expect(log.sentOn('2026-09-27')).toBe(0);
      log.append({ event: 'enabled' });
      expect((await g.submit({ symbol: 'BTC/USD', side: 'buy', notional: 25 }, yes)).outcome).toBe('placed');
    });
  }

  it('a run that died between sending an order and writing its outcome leaves the same mark, and the next order waits for it', async () => {
    const { guard: g, log } = guard('paper');
    const b = broker();
    const body = b.orderBody({ symbol: 'BTC/USD', side: 'buy', notional: 84 }, 'primerkit-died');
    log.append({ event: 'sending', body, before: 0 });
    await b.place(body); // Alpaca took it; the run died before it could write that down
    const next = await g.submit({ symbol: 'BTC/USD', side: 'buy', notional: 10 }, yes);
    expect(next.checked.refused).toEqual(['an order primerkit sent has no outcome on record (primerkit-died): primerkit broker reconcile asks Alpaca for it']);
    expect(await g.reconcile()).toEqual({ drift: [{ symbol: 'BTCUSD', expected: 0.001, held: 0.001 }], waiting: [], resolved: [{ clientOrderId: 'primerkit-died', taken: true }] });
    expect((await g.submit({ symbol: 'BTC/USD', side: 'buy', notional: 10 }, yes)).outcome).toBe('placed');
  });

  it("writes an order off only on Alpaca's own not found, never on an answer that names no order", async () => {
    const { guard: g, log } = guard('paper', { ...CAPS, maxOrdersPerDay: 1 });
    orderAnswer = 'taken-then-dropped';
    const lost = await g.submit({ symbol: 'BTC/USD', side: 'buy', notional: 25 }, yes);
    expect(lost.outcome).toBe('unknown');
    orderAnswer = 'ok';
    // Alpaca holds the order, and its lookup answers 200 with nothing in it.
    lookupNamesNoOrder = true;
    await expect(g.reconcile()).rejects.toThrow("Alpaca's answer names no order");
    expect(log.pending()).toHaveLength(1);
    expect(events(log)).not.toContain('failed');
    expect(log.sentOn('2026-09-27')).toBe(1);
    expect(existsSync(log.lockPath)).toBe(false);
    // CONTROL: answered as documented, the same order is found.
    lookupNamesNoOrder = false;
    expect((await g.reconcile()).resolved).toEqual([{ clientOrderId: lost.checked.body!.client_order_id, taken: true }]);
  });

  it('leaves an order alone while the run sending it holds the lock, so one still on its way is never written off', async () => {
    const { guard: g, log } = guard('paper');
    const body = broker().orderBody({ symbol: 'BTC/USD', side: 'buy', notional: 84 }, 'primerkit-on-its-way');
    const sending = log.lock()!; // the run that is sending it
    log.append({ event: 'sending', body, before: 0 });
    expect(await g.reconcile()).toEqual({ drift: [], waiting: [], busy: true });
    expect(log.pending()).toHaveLength(1);
    expect(events(log)).not.toContain('failed');
    expect(seen.filter((s) => s.path.startsWith('/v2/orders:by_client_order_id'))).toEqual([]);
    // CONTROL: once that run is done, the order is asked for, and Alpaca holds none.
    sending();
    expect((await g.reconcile()).resolved).toEqual([{ clientOrderId: 'primerkit-on-its-way', taken: false }]);
  });

  it('stops waiting for a call that never answers', async () => {
    orderAnswer = 'never';
    const b = broker(200);
    const started = Date.now();
    await expect(b.place(b.orderBody({ symbol: 'BTC/USD', side: 'buy', notional: 25 }, 'c9'))).rejects.toThrow('Alpaca did not answer in time');
    expect(Date.now() - started).toBeLessThan(5_000);
  });
});

describe('the keychain', () => {
  const calls: Array<{ command: string; args: string[]; input: string }> = [];
  let answer: { code: number | null; stdout: string; stderr: string } | null = null;
  const run: KeyRunner = async (command, args, input) => {
    calls.push({ command, args, input });
    return answer ?? { code: 0, stdout: input ? '' : 'stored-secret', stderr: '' };
  };
  beforeEach(() => {
    calls.length = 0;
    answer = null;
  });
  const decoded = () => Buffer.from(calls.at(-1)!.args.at(-1) ?? '', 'base64').toString('utf16le');

  for (const platform of ['win32', 'darwin', 'linux'] as const) {
    it(`passes the secret on stdin, never as an argument, on ${platform}`, async () => {
      const kc = osKeychain(platform, run);
      await kc.set('alpaca-paper-secret', 'test-secret-value');
      expect(calls[0]!.input).toContain('test-secret-value');
      const argv = calls[0]!.args.join(' ');
      expect(argv).not.toContain('test-secret-value');
      expect(Buffer.from(calls[0]!.args.at(-1) ?? '', 'base64').toString('utf16le')).not.toContain('test-secret-value');
      expect(await kc.get('alpaca-paper-secret')).toBe('stored-secret');
    });
  }

  it('starts its helper by its full path, never by a bare name the current folder could answer to', async () => {
    expect(keychainProgram('win32', { SystemRoot: 'C:\\Windows' })).toBe(join('C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'));
    expect(keychainProgram('win32', {})).toBe(join('C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'));
    // A SystemRoot that is no full path with its drive would point under the current folder.
    for (const root of ['.', 'Windows', '\\Windows', '']) expect(keychainProgram('win32', { SystemRoot: root, windir: root })).toBe(join('C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'));
    expect(keychainProgram('win32', { SystemRoot: '.', windir: 'D:\\Win' })).toBe(join('D:\\Win', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'));
    expect(keychainProgram('darwin')).toBe('/usr/bin/security');
    expect(keychainProgram('linux', {}, (p) => p === '/usr/bin/secret-tool')).toBe('/usr/bin/secret-tool');
    await osKeychain('win32', run).get('alpaca-paper-secret');
    await osKeychain('darwin', run).get('alpaca-paper-secret');
    expect(calls[0]!.command).toMatch(/[\\/]System32[\\/]WindowsPowerShell[\\/]v1\.0[\\/]powershell\.exe$/);
    expect(calls[0]!.command).not.toBe('powershell.exe');
    expect(calls[1]!.command).toBe('/usr/bin/security');
  });

  it('takes only an entry name of lower case letters, digits and hyphens, so no name can end the script it is written into', async () => {
    const kc = osKeychain('win32', run);
    for (const name of ["x'; Write-Output INJECTED; '", 'a b', 'A', 'a/b', '']) {
      await expect(kc.get(name)).rejects.toThrow('is not a keychain entry name');
      await expect(kc.set(name, 's')).rejects.toThrow('is not a keychain entry name');
      await expect(kc.remove(name)).rejects.toThrow('is not a keychain entry name');
    }
    expect(calls).toEqual([]);
    await kc.get('alpaca-paper-key-id');
    expect(decoded().trimEnd().endsWith("get 'primerkit/alpaca-paper-key-id'")).toBe(true);
  });

  it('keeps no secret that holds a line break, which the macOS helper would read as a second command', async () => {
    for (const platform of ['win32', 'darwin', 'linux'] as const) {
      await expect(osKeychain(platform, run).set('alpaca-paper-secret', 'first\nsecond-line-is-a-command')).rejects.toThrow('A key cannot hold a line break');
    }
    expect(calls).toEqual([]);
  });

  it('says an entry is not there only when the keychain says so, and throws when the keychain could not be asked', async () => {
    const win = osKeychain('win32', run);
    answer = { code: 3, stdout: '', stderr: '' };
    expect(await win.get('alpaca-paper-secret')).toBeNull();
    expect(await win.remove('alpaca-paper-secret')).toBe(false);
    for (const code of [1, 4, null]) {
      answer = { code, stdout: '', stderr: 'blocked' };
      await expect(win.get('alpaca-paper-secret')).rejects.toThrow('Credential Manager could not be read for primerkit/alpaca-paper-secret: blocked');
      await expect(win.remove('alpaca-paper-secret')).rejects.toThrow('Credential Manager did not remove primerkit/alpaca-paper-secret: blocked');
    }
    const mac = osKeychain('darwin', run);
    answer = { code: 44, stdout: '', stderr: 'The specified item could not be found in the keychain.' };
    expect(await mac.get('alpaca-paper-secret')).toBeNull();
    expect(await mac.remove('alpaca-paper-secret')).toBe(false);
    answer = { code: 1, stdout: '', stderr: 'User interaction is not allowed.' };
    await expect(mac.get('alpaca-paper-secret')).rejects.toThrow('the keychain could not be read');
    const linux = osKeychain('linux', run);
    answer = { code: 1, stdout: '', stderr: '' };
    expect(await linux.get('alpaca-paper-secret')).toBeNull();
    expect(await linux.remove('alpaca-paper-secret')).toBe(false);
    answer = { code: 1, stdout: '', stderr: 'Cannot autolaunch D-Bus without X11' };
    await expect(linux.get('alpaca-paper-secret')).rejects.toThrow('the Secret Service could not be read');
  });

  // The one test that reaches the real helper. It asks Windows' Credential Manager for an
  // entry that does not exist, so nothing is read and nothing is changed; it is how the
  // script's own answer for "not there" (exit 3, on Windows' error 1168) is seen to work.
  // PRIMERKIT_SKIP_LIVE_KEYCHAIN=1 leaves it out, for a machine that blocks the helper.
  it.runIf(process.platform === 'win32' && process.env.PRIMERKIT_SKIP_LIVE_KEYCHAIN !== '1')(
    'Windows, live and changing nothing: an entry that does not exist reads as not there, and removing it removes nothing',
    async () => {
      const codes: Array<number | null> = [];
      const live: KeyRunner = async (command, args, input) => {
        const r = await keyRunner(command, args, input);
        codes.push(r.code);
        return r;
      };
      const kc = osKeychain('win32', live);
      const name = `zz-absent-${randomUUID().slice(0, 8)}`;
      expect(await kc.get(name)).toBeNull();
      expect(await kc.remove(name)).toBe(false);
      expect(codes).toEqual([3, 3]);
      // Its failing twin: the same script asked for a name longer than Windows allows
      // (built inside PowerShell, so the command line stays short). That is a failure, not
      // "not there", and the script must say so with its other exit code.
      const sent: string[][] = [];
      await osKeychain('win32', async (_command, args) => (sent.push(args), { code: 3, stdout: '', stderr: '' })).get('x');
      const script = Buffer.from(sent[0]!.at(-1) ?? '', 'base64').toString('utf16le').trimEnd();
      expect(script.endsWith("get 'primerkit/x'")).toBe(true);
      for (const op of ['get', 'delete']) {
        const tooLong = Buffer.from(script.replace(/get 'primerkit\/x'$/, `${op} ('a' * 40000)`), 'utf16le').toString('base64');
        expect((await keyRunner(keychainProgram('win32'), ['-NoProfile', '-NonInteractive', '-EncodedCommand', tooLong], '')).code).toBe(4);
      }
    },
    120_000,
  );
});

// A stray lock or a stray line must never be read as "nothing is wrong".
describe('the log', () => {
  it('stops every reader on a line that is not JSON', () => {
    const log = newLog();
    log.append({ event: 'disabled', reason: 'a stop' });
    appendFileSync(log.path, '{"at":"2026-10-01T00:00:00.000Z","event":"pla\n');
    expect(() => log.disabled()).toThrow();
    expect(() => log.pending()).toThrow();
  });

  it('counts an order on the day it was sent, once, though its outcome is written the next day', () => {
    const log = newLog();
    const body = broker().orderBody({ symbol: 'BTC/USD', side: 'buy', notional: 10 }, 'c-midnight');
    log.append({ event: 'sending', body, before: 0 }, new Date('2026-09-27T23:59:59Z'));
    log.append({ event: 'placed', body, order: { id: 'o1', status: 'accepted' }, expected: null, before: 0 }, new Date('2026-09-28T00:00:01Z'));
    expect(log.sentOn('2026-09-27')).toBe(1);
    expect(log.sentOn('2026-09-28')).toBe(0);
    // An order Alpaca refused counts on no day.
    const refused = broker().orderBody({ symbol: 'BTC/USD', side: 'buy', notional: 10 }, 'c-refused');
    log.append({ event: 'sending', body: refused, before: 0 }, new Date('2026-09-28T10:00:00Z'));
    log.append({ event: 'failed', body: refused, error: 'Alpaca: no' }, new Date('2026-09-28T10:00:01Z'));
    expect(log.sentOn('2026-09-28')).toBe(0);
  });
});

describe("a standing exit's order body", () => {
  it('writes a stop-limit or a limit sale by quantity, good till cancelled for crypto, and refuses anything else as one', () => {
    const b = broker();
    expect(b.orderBody({ symbol: 'BTC/USD', side: 'sell', qty: 0.25, type: 'stop_limit', stopPrice: 79_800, limitPrice: 79_002 }, 'c1')).toEqual({ symbol: 'BTC/USD', side: 'sell', type: 'stop_limit', time_in_force: 'gtc', qty: '0.25', limit_price: '79002.00', stop_price: '79800.00', client_order_id: 'c1' });
    expect(b.orderBody({ symbol: 'BTC/USD', side: 'sell', qty: 0.25, type: 'limit', limitPrice: 92_400 }, 'c2')).toEqual({ symbol: 'BTC/USD', side: 'sell', type: 'limit', time_in_force: 'gtc', qty: '0.25', limit_price: '92400.00', client_order_id: 'c2' });
    expect(() => b.orderBody({ symbol: 'BTC/USD', side: 'buy', notional: 100, type: 'limit', limitPrice: 80_000 }, 'c3')).toThrow('A limit or stop-limit order here is a sale by quantity: a standing exit.');
    expect(() => b.orderBody({ symbol: 'BTC/USD', side: 'sell', notional: 100, type: 'limit', limitPrice: 80_000 }, 'c4')).toThrow('A limit or stop-limit order here is a sale by quantity: a standing exit.');
    expect(() => b.orderBody({ symbol: 'BTC/USD', side: 'sell', qty: 0.1, type: 'stop_limit', limitPrice: 79_000 }, 'c5')).toThrow('A stop-limit order needs a stop price above zero.');
    expect(() => b.orderBody({ symbol: 'BTC/USD', side: 'sell', qty: 0.1, type: 'limit', limitPrice: -1 }, 'c6')).toThrow('A limit order needs a limit price above zero.');
    // CONTROL: a market order's body is as it was.
    expect(b.orderBody({ symbol: 'BTC/USD', side: 'buy', notional: 25 }, 'c7')).toEqual({ symbol: 'BTC/USD', side: 'buy', type: 'market', time_in_force: 'gtc', notional: '25.00', client_order_id: 'c7' });
  });
});

describe("Alpaca's asset list", () => {
  it('reads a symbol as Alpaca holds it, under either spelling of a crypto pair, and null where it holds none', async () => {
    const b = broker();
    const btc = { symbol: 'BTC/USD', assetClass: 'crypto', tradable: true, fractionable: true, minOrderSize: 0.0001, status: 'active' };
    expect(await b.asset('BTC/USD')).toEqual(btc);
    // BTCUSD, with no slash, is the crypto pair too: its class is read, never guessed from the symbol.
    expect(await b.asset('BTCUSD')).toEqual(btc);
    expect(await b.asset('XMPL')).toEqual({ symbol: 'XMPL', assetClass: 'us_equity', tradable: true, fractionable: false, minOrderSize: null, status: 'active' });
    expect(await b.asset('NOPE')).toBeNull();
    expect(seen.map((s) => `${s.method} ${s.path}`)).toEqual(['GET /v2/assets/BTC%2FUSD', 'GET /v2/assets/BTCUSD', 'GET /v2/assets/XMPL', 'GET /v2/assets/NOPE']);
  });
});

describe('the kill switch, and the caps on all positions and on groups', () => {
  it('refuses every order while a file named STOP is beside the log, a dry run included, and lets them go once it is gone', async () => {
    const { guard: g, log } = guard('paper', MANY);
    mkdirSync(dirname(log.path), { recursive: true });
    writeFileSync(log.stopPath, '');
    expect(log.stopPath).toBe(join(dirname(log.path), 'STOP'));
    const dry = new OrderGuard({ broker: broker(), mode: 'dry_run', caps: MANY, log });
    for (const run of [g, dry]) {
      const r = await run.submit({ symbol: 'BTC/USD', side: 'buy', notional: 50 }, yes);
      expect(r.outcome).toBe('refused');
      expect(r.checked.refused).toContain(`the kill switch is on: ${log.stopPath} is there, and no order goes while it is. Delete it to let orders go again`);
    }
    expect(posts()).toEqual([]);
    rmSync(log.stopPath);
    expect((await g.submit({ symbol: 'BTC/USD', side: 'buy', notional: 50 }, yes)).outcome).toBe('placed');
  });

  it('holds a buy to the share of equity all positions may reach together, and to each group the symbol is in', async () => {
    // $100,000 of equity, with $5,000 of ETH held.
    positions = [{ symbol: 'ETHUSD', qty: '2.5', market_value: '5000' }];
    const caps: Caps = { ...MANY, maxNotional: 10_000, maxPositionShare: 0.5, maxExposureShare: 0.08, groups: [{ name: 'crypto', symbols: ['BTC/USD', 'ETH/USD'], maxShare: 0.07 }] };
    const { guard: g } = guard('dry_run', caps);
    const refused = (await g.check({ symbol: 'BTC/USD', side: 'buy', notional: 4000 })).checked.refused;
    expect(refused).toEqual(['all positions would be 9.0% of equity, over your cap of 8.0% together', 'crypto (BTC/USD, ETH/USD) would be 9.0% of equity, over your cap of 7.0% for it']);
    // CONTROL: within both, it goes.
    expect((await g.check({ symbol: 'BTC/USD', side: 'buy', notional: 1500 })).checked.refused).toEqual([]);
  });

  it('names an optional cap that cannot be used, and leaves the four alone when the optional ones are not given', () => {
    expect(capsProblems(CAPS)).toEqual([]);
    expect(capsProblems({ ...CAPS, maxExposureShare: 1.5 })).toEqual(['max_exposure_share is 1.5, where it takes the share of equity all positions together may reach, above 0 and at most 1']);
    expect(capsProblems({ ...CAPS, groups: [{ name: 'g', symbols: [], maxShare: 0.2 }] })[0]).toMatch(/^groups is \[.*\], where each takes a name, its symbols, and the share of equity they may reach together, above 0 and at most 1$/);
    expect(capsProblems({ ...CAPS, groups: 'crypto' as unknown as Caps['groups'] })[0]).toMatch(/^groups is "crypto"/);
  });
});

describe("Alpaca's fee on a crypto purchase", () => {
  // The personas walk, 2026-10-14: a $10 paper purchase of BTC/USD filled 0.000117715, and
  // Alpaca held 0.00011742, the fill less its fee, which it takes in the coin.
  const FILLED = '0.000117715';
  const HELD = { symbol: 'BTCUSD', qty: '0.00011742', market_value: '9.78' };
  const filledAs = (qty: string) => {
    for (const [id, o] of orders) orders.set(id, { ...o, status: 'filled', filled_qty: qty });
  };
  const bought = async (g: OrderGuard) => {
    expect((await g.submit({ symbol: 'BTC/USD', side: 'buy', notional: 10 }, yes)).outcome).toBe('placed');
    filledAs(FILLED);
  };

  it("counts the fee on the walk's $10 purchase, names it, and lets the next order go", async () => {
    const { guard: g, log } = guard('paper', MANY);
    await bought(g);
    positions = [HELD];
    expect(await g.reconcile()).toEqual({ drift: [{ symbol: 'BTCUSD', expected: 0.000117715, held: 0.00011742, short: { by: 0.000000295, withinFee: true } }], waiting: [] });
    expect(log.disabled()).toBeNull();
    expect((await g.submit({ symbol: 'BTC/USD', side: 'buy', notional: 10 }, yes)).outcome).toBe('placed');
  });

  it('takes the fee out before the stop rule, so a rule tighter than the fee stops only a real difference', async () => {
    const log = newLog();
    const g = new OrderGuard({ broker: broker(), mode: 'paper', caps: MANY, log, stop: { failures: 3, driftShare: 0.001 }, now: () => new Date('2026-09-27T12:00:00Z') });
    await bought(g);
    positions = [HELD];
    await g.reconcile();
    expect(log.disabled()).toBeNull();
    // CONTROL: the same rule stops a difference of 0.5%, twice the fee.
    positions = [{ ...HELD, qty: '0.000117127' }];
    await g.reconcile();
    expect(log.disabled()).toBe('the broker holds 0.000117127 BTCUSD where the log expects 0.000117715');
  });

  it('says so where Alpaca holds less than its fee explains, to the ninth decimal', async () => {
    const { guard: g } = guard('paper', MANY);
    await bought(g);
    // A shortfall of 1%, four times the fee.
    positions = [{ ...HELD, qty: '0.000116538' }];
    expect((await g.reconcile()).drift).toEqual([{ symbol: 'BTCUSD', expected: 0.000117715, held: 0.000116538, short: { by: 0.000001177, withinFee: false } }]);
    // One ninth past the fee is past it.
    positions = [{ ...HELD, qty: '0.000117419' }];
    expect((await g.reconcile()).drift[0]?.short).toEqual({ by: 0.000000296, withinFee: false });
  });

  it('still stops on a real difference: a purchase whose answer was lost and that Alpaca holds none of, or a holding primerkit did not place', async () => {
    const { guard: g, log } = guard('paper', MANY);
    orderAnswer = 'taken-then-dropped';
    expect((await g.submit({ symbol: 'BTC/USD', side: 'buy', notional: 10 }, yes)).outcome).toBe('unknown');
    orderAnswer = 'ok';
    filledAs(FILLED);
    positions = [];
    const r = await g.reconcile();
    expect(r.resolved).toEqual([{ clientOrderId: expect.stringMatching(/^primerkit-/), taken: true }]);
    expect(r.drift).toEqual([{ symbol: 'BTCUSD', expected: 0.000117715, held: 0, short: { by: 0.000117715, withinFee: false } }]);
    expect(log.disabled()).toBe('the broker holds 0 BTCUSD where the log expects 0.000117715');
    // More held than the record is no fee.
    const other = guard('paper', MANY);
    await bought(other.guard);
    positions = [{ ...HELD, qty: '0.00023484' }];
    expect((await other.guard.reconcile()).drift).toEqual([{ symbol: 'BTCUSD', expected: 0.000117715, held: 0.00023484 }]);
    expect(other.log.disabled()).toBe('the broker holds 0.00023484 BTCUSD where the log expects 0.000117715');
  });

  it('counts a fee on a crypto purchase only: a sale, or a stock, short of the record is drift as before', async () => {
    holdings.set('BTCUSD', 0.002);
    const { guard: g, log } = guard('paper', MANY);
    expect((await g.submit({ symbol: 'BTC/USD', side: 'sell', qty: 0.001 }, yes)).outcome).toBe('placed');
    positions = [{ symbol: 'BTCUSD', qty: '0.000999', market_value: '83.92' }];
    expect((await g.reconcile()).drift).toEqual([{ symbol: 'BTCUSD', expected: 0.001, held: 0.000999 }]);
    expect(log.disabled()).toBeNull();
    positions = null;
    const stock = guard('paper', { ...MANY, symbols: ['XMPL'] });
    expect((await stock.guard.submit({ symbol: 'XMPL', side: 'buy', notional: 50 }, yes)).outcome).toBe('placed');
    positions = [{ symbol: 'XMPL', qty: '0.4995', market_value: '49.95' }];
    expect((await stock.guard.reconcile()).drift).toEqual([{ symbol: 'XMPL', expected: 0.5, held: 0.4995 }]);
  });

  it('sells no more than is held after the fee: the fill is refused, all that is held goes', async () => {
    const { guard: g } = guard('paper', MANY);
    await bought(g);
    positions = [HELD];
    expect((await g.check({ symbol: 'BTC/USD', side: 'sell', qty: 0.000117715 })).checked.refused).toEqual(['0.000117715 BTC/USD is more than the 0.00011742 held, and primerkit sells only what is held']);
    expect((await g.submit({ symbol: 'BTC/USD', side: 'sell', qty: 0.00011742 }, yes)).outcome).toBe('placed');
    expect(JSON.parse(posts().at(-1)!.body)).toMatchObject({ symbol: 'BTC/USD', side: 'sell', qty: '0.00011742' });
  });
});
