import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { BrokerLog, type Keychain } from '@primerkit/brokers';
import { loadRoutine, newRoutine, readConfig, readIntent, routinesDir, writeConfig, type ForwardEntry } from '@primerkit/core';
import { brokerCommand, connectAlpaca, routineIntent, type Io } from '../src/broker';
import { intentCommand } from '../src/intent';
import { doctorLine, forTerminal, isTerminal } from '../src/terminal';

const BIN = fileURLToPath(new URL('../bin/primerkit.js', import.meta.url));
const ROOT = fileURLToPath(new URL('../../../', import.meta.url));

// A fake of Alpaca's paper API on 127.0.0.1: an order fills at once at a fixed price, and
// the positions follow the fills unless a test sets them itself. It can also take an
// order and drop the connection before it answers.
const PRICE = 84_000;
const posts: string[] = [];
const orders = new Map<string, { status: string; filled_qty: string; filled_avg_price?: string; client_order_id: string }>();
let filled = 0;
let held: Array<{ symbol: string; qty: string; market_value: string }> | null = null;
let dropAnswer = false;
let waitFill = false; // an order is taken and waits, unfilled, until it is cancelled
let server: Server;
let base = '';

beforeAll(async () => {
  server = createServer((req, res) => {
    let body = '';
    req.on('data', (c: Buffer) => (body += c.toString()));
    req.on('end', () => {
      const json = (code: number, v: unknown) => res.writeHead(code, { 'Content-Type': 'application/json' }).end(JSON.stringify(v));
      if (req.headers['apca-api-secret-key'] !== 'paper-secret') return json(403, { message: 'forbidden' });
      if (req.url === '/v2/account') return json(200, { id: 'a1', account_number: 'PA3456789012', status: 'ACTIVE', equity: '100000', cash: '100000', buying_power: '200000' });
      if (req.url === '/v2/positions') return json(200, held ?? (filled ? [{ symbol: 'BTCUSD', qty: String(filled), market_value: String(filled * PRICE) }] : []));
      if (req.url === '/v2/orders' && req.method === 'POST') {
        posts.push(body);
        const o = JSON.parse(body) as { side: string; qty?: string; notional?: string; client_order_id: string };
        const qty = o.qty ? Number(o.qty) : Number(o.notional) / PRICE;
        const id = `order-${posts.length}`;
        if (waitFill) orders.set(id, { status: 'accepted', filled_qty: '0', client_order_id: o.client_order_id });
        else {
          filled += o.side === 'buy' ? qty : -qty;
          orders.set(id, { status: 'filled', filled_qty: String(qty), filled_avg_price: String(PRICE), client_order_id: o.client_order_id });
        }
        if (dropAnswer) return void req.socket.destroy();
        return json(200, { id, status: 'accepted' });
      }
      const cancelled = /^\/v2\/orders\/([^/?]+)$/.exec(req.url ?? '');
      if (cancelled && req.method === 'DELETE') {
        const o = orders.get(cancelled[1]!);
        if (!o) return json(404, { message: 'order not found' });
        if (o.status === 'filled') return json(422, { message: 'order is not cancelable' });
        o.status = 'canceled';
        return void res.writeHead(204).end();
      }
      const byClient = /^\/v2\/orders:by_client_order_id\?client_order_id=([^&]+)$/.exec(req.url ?? '');
      if (byClient) {
        const found = [...orders].find(([, o]) => o.client_order_id === decodeURIComponent(byClient[1]!));
        return found ? json(200, { id: found[0], ...found[1] }) : json(404, { message: 'order not found' });
      }
      const one = /^\/v2\/orders\/([^/?]+)$/.exec(req.url ?? '');
      if (one) {
        const o = orders.get(one[1]!);
        return o ? json(200, { id: one[1], ...o }) : json(404, { message: 'order not found' });
      }
      if (req.url === '/v2/assets/BTC%2FUSD' || req.url === '/v2/assets/BTCUSD') return json(200, { class: 'crypto', symbol: 'BTC/USD', status: 'active', tradable: true, fractionable: true, min_order_size: '0.0001' });
      json(404, {});
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => {
  server.closeAllConnections();
  server.close();
});

interface Call {
  url: string;
  method: string;
  headers: string[];
  redirect: string | undefined;
}
type TestIo = Io & { out: string[]; errors: string[]; asked: Array<{ q: string; hidden: boolean }>; store: Map<string, string>; calls: Call[] };

// A person at a terminal unless a test says otherwise. Every call the broker makes is
// recorded as it is made, before it leaves.
function io(answers: string[] = [], terminal = true): TestIo {
  const store = new Map<string, string>();
  const keychain: Keychain = { set: async (n, s) => void store.set(n, s), get: async (n) => store.get(n) ?? null, remove: async (n) => store.delete(n) };
  const out: string[] = [];
  const errors: string[] = [];
  const asked: Array<{ q: string; hidden: boolean }> = [];
  const calls: Call[] = [];
  return {
    out,
    errors,
    asked,
    store,
    calls,
    keychain,
    base,
    terminal,
    fetch: ((url: string, init?: RequestInit) => {
      calls.push({ url: String(url), method: init?.method ?? 'GET', headers: Object.keys((init?.headers ?? {}) as Record<string, string>), redirect: init?.redirect });
      return fetch(url, init);
    }) as typeof fetch,
    print: (lines) => void out.push(...lines),
    fail: (m) => (errors.push(m), 1),
    ask: async (q, hidden = false) => {
      asked.push({ q, hidden });
      return answers.shift() ?? '';
    },
  };
}

// Connected: the paper keys typed and kept, as `primerkit connect alpaca` leaves it.
async function connected(answers: string[] = [], terminal = true): Promise<TestIo> {
  const t = io(['PKPAPER', 'paper-secret', ...answers]);
  expect(await connectAlpaca(t, false)).toBe(0);
  t.terminal = terminal;
  return t;
}

let home = '';
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'pk-cli-broker-'));
  process.env.PRIMERKIT_HOME = home;
  posts.length = 0;
  orders.clear();
  filled = 0;
  held = null;
  dropAnswer = false;
  waitFill = false;
});

const args =(sub: string | undefined, rest: string[] = [], flags: Record<string, string> = {}, on: string[] = []) => ({ sub, rest, flag: (n: string) => flags[n], has: (n: string) => on.includes(n) });
const CAPS = '{ max_notional: 50, max_position_share: 0.05, symbols: [BTC/USD], max_orders_per_day: 5 }';
const config = (mode: string, caps = CAPS) => writeFileSync(join(home, 'config.yaml'), `brokers:\n  alpaca:\n    mode: ${mode}\n    caps: ${caps}\n`);
const buy = (t: Io, dollars = '25', on = ['--paper']) => brokerCommand(t, args('order', ['btc/usd', 'buy'], { '--notional': dollars }, on));
const log = () => new BrokerLog(join(home, 'broker', 'alpaca.jsonl'));

describe('primerkit connect alpaca', () => {
  it('asks for the secret without echoing it, keeps the keys only after Alpaca accepts them, and starts in dry run', async () => {
    const t = io(['PKPAPER', 'paper-secret']);
    expect(await connectAlpaca(t, false)).toBe(0);
    expect(t.asked).toEqual([{ q: 'Paper key id: ', hidden: false }, { q: 'Paper secret: ', hidden: true }]);
    expect(t.out).toContain('Connected to Alpaca paper: account ********9012, ACTIVE, equity $100,000.00.');
    expect([...t.store.keys()]).toEqual(['alpaca-paper-key-id', 'alpaca-paper-secret']);
    expect(readConfig(home).brokers?.alpaca?.mode).toBe('dry_run');
    expect(t.out.join('\n')).not.toContain('paper-secret');
  });

  it('takes the keys from the person alone, never from the environment, where another tool may keep live ones under the same names', async () => {
    const before = { id: process.env.ALPACA_API_KEY, secret: process.env.ALPACA_SECRET_KEY };
    process.env.ALPACA_API_KEY = 'PKPAPER';
    process.env.ALPACA_SECRET_KEY = 'paper-secret';
    try {
      const t = io([]);
      expect(await connectAlpaca(t, false)).toBe(1);
      // Both were asked for, and with nothing typed nothing was sent and nothing was kept.
      expect(t.asked.map((a) => a.q)).toEqual(['Paper key id: ', 'Paper secret: ']);
      expect(t.errors).toEqual(['Nothing was kept: both the key id and the secret are needed.']);
      expect(t.calls).toEqual([]);
      expect(t.store.size).toBe(0);
    } finally {
      if (before.id === undefined) delete process.env.ALPACA_API_KEY;
      else process.env.ALPACA_API_KEY = before.id;
      if (before.secret === undefined) delete process.env.ALPACA_SECRET_KEY;
      else process.env.ALPACA_SECRET_KEY = before.secret;
    }
  });

  it('asks for the keys only at a terminal, so they are never in a pipe or a script', async () => {
    const t = io(['PKPAPER', 'paper-secret'], false);
    expect(await connectAlpaca(t, false)).toBe(1);
    expect(t.errors[0]).toBe('The keys are typed at a terminal, and this run has none: its input or its output is a pipe or a file. Run it in a terminal yourself.');
    expect(t.asked).toEqual([]);
    expect(t.calls).toEqual([]);
    expect(t.store.size).toBe(0);
  });

  it('keeps nothing when Alpaca refuses the keys, or when a key holds a control character', async () => {
    const t = io(['PKPAPER', 'wrong']);
    expect(await connectAlpaca(t, false)).toBe(1);
    expect(t.errors[0]).toBe('Nothing was kept: Alpaca did not accept the keys. Paper keys work only against the paper API.');
    expect(t.store.size).toBe(0);
    const odd = io(['PKPAPER', 'paper\u0007secret']);
    expect(await connectAlpaca(odd, false)).toBe(1);
    expect(odd.errors[0]).toBe('Nothing was kept: a key cannot hold a control character.');
    expect(odd.calls).toEqual([]);
  });

  it('shows the disclaimer before it asks for the keys', async () => {
    const t = await connected();
    expect(t.out).toContain('  Nothing here is investment advice.');
    expect(t.out).toContain('  Your model and your primers make every decision.');
    expect(t.out.indexOf('  Nothing here is investment advice.')).toBeLessThan(t.out.findIndex((l) => l.startsWith('Connected to Alpaca paper')));
  });

  it('takes the keys out and turns the connection off, and says no keys were kept only when none were', async () => {
    const t = await connected();
    expect(await connectAlpaca(t, true)).toBe(0);
    expect(t.out.at(-1)).toBe('The Alpaca keys are out of the keychain, and the connection is off.');
    expect(t.store.size).toBe(0);
    expect(readConfig(home).brokers?.alpaca?.mode).toBe('off');
    expect(await connectAlpaca(t, true)).toBe(0);
    expect(t.out.at(-1)).toBe('No Alpaca keys were kept. The connection is off.');
  });

  it('says so when the keychain could not take the keys out, where it used to say no keys were kept', async () => {
    const t = await connected();
    const kept = t.store;
    // The helper is blocked: it can neither read nor remove.
    t.keychain = {
      set: async () => undefined,
      get: async () => {
        throw new Error('Credential Manager could not be read for primerkit/alpaca-paper-key-id: blocked');
      },
      remove: async () => {
        throw new Error('blocked');
      },
    };
    expect(await connectAlpaca(t, true)).toBe(1);
    expect(t.errors.at(-1)).toMatch(/^The connection is off, but the Alpaca keys could not be taken out of the keychain and may still be kept: Credential Manager could not be read/);
    expect(t.out).not.toContain('No Alpaca keys were kept. The connection is off.');
    expect(kept.size).toBe(2);
    expect(readConfig(home).brokers?.alpaca?.mode).toBe('off');
    // A removal that reports success while the entry is still there is caught by reading it back.
    const stuck = await connected();
    stuck.keychain = { set: async () => undefined, get: async (n) => stuck.store.get(n) ?? null, remove: async () => true };
    expect(await connectAlpaca(stuck, true)).toBe(1);
    expect(stuck.errors.at(-1)).toContain('an entry is still there after it was removed');
  });
});

describe('primerkit broker', () => {
  it('shows the account, and runs an order as a dry run unless --paper, then places it on paper on a typed yes', async () => {
    const t = await connected(['yes']);
    expect(await brokerCommand(t, args(undefined))).toBe(0);
    expect(t.out).toContain('No caps are set, so no order will be placed.');

    // With no caps, not even a dry run passes the guard.
    expect(await buy(t, '25', [])).toBe(1);
    expect(t.errors.at(-1)).toContain('no caps are set');

    writeConfig(home, { ...readConfig(home), brokers: { alpaca: { mode: 'paper', caps: { max_notional: 50, max_position_share: 0.05, symbols: ['BTC/USD'], max_orders_per_day: 3 } } } });
    expect(await buy(t, '25', [])).toBe(0);
    expect(t.out).toContain('A dry run: nothing was sent. The order as it would go to Alpaca:');
    expect(posts).toHaveLength(0);

    expect(await buy(t)).toBe(0);
    expect(t.asked.at(-1)?.q).toBe('Place this paper order? Type yes to place it: ');
    expect(JSON.parse(posts[0]!)).toMatchObject({ symbol: 'BTC/USD', side: 'buy', notional: '25.00', time_in_force: 'gtc' });
    expect(t.out).toContain('Placed on paper: order order-1, accepted.');
    expect(await brokerCommand(t, args(undefined))).toBe(0);
    expect(t.out.at(-1)).toBe('Orders sent today, by UTC days: 1.');
  });

  it("refuses every order while config.yaml's caps leave a field out or give it as words, and says which", async () => {
    const t = await connected();
    config('paper', '{ symbols: [BTC/USD] }');
    for (let i = 0; i < 5; i += 1) expect(await buy(t, '5000')).toBe(1);
    expect(posts).toHaveLength(0);
    expect(t.errors.at(-1)).toContain('your caps in config.yaml cannot be used, so no order goes: max_notional is missing');
    expect(await brokerCommand(t, args(undefined))).toBe(0);
    expect(t.out.at(-2)).toMatch(/^Your caps in config\.yaml cannot be used, so no order will be placed: max_notional is missing/);
    config('paper', '{ max_notional: fifty, max_position_share: 0.05, symbols: [BTC/USD], max_orders_per_day: 3 }');
    expect(await buy(t, '5000')).toBe(1);
    expect(t.errors.at(-1)).toContain('max_notional is "fifty"');
    expect(posts).toHaveLength(0);
  });

  it('takes only the four mode names: any other value is refused by name, and nothing is read from Alpaca or sent', async () => {
    for (const mode of ['live', 'papr', 'PAPER', 'true', '""']) {
      const t = await connected(['yes']);
      t.calls.length = 0;
      config(mode);
      expect(await buy(t)).toBe(1);
      expect(t.errors.at(-1)).toMatch(/^Your broker settings in config\.yaml cannot be used, so nothing is read from Alpaca and nothing is sent: mode is .+, where it takes off, read, dry_run or paper\.$/);
      expect(await brokerCommand(t, args(undefined))).toBe(1);
      expect(await brokerCommand(t, args('reconcile'))).toBe(1);
      expect(t.calls).toEqual([]);
      expect(t.asked.slice(2)).toEqual([]);
    }
    expect(posts).toHaveLength(0);
    // CONTROL: dry_run sends nothing with --paper, and paper places.
    const t = await connected(['yes']);
    config('dry_run');
    expect(await buy(t)).toBe(0);
    expect(posts).toHaveLength(0);
    config('paper');
    expect(await buy(t)).toBe(0);
    expect(posts).toHaveLength(1);
  });

  it('reads nothing and sends nothing in mode off, with the keys still in the keychain', async () => {
    const t = await connected();
    t.calls.length = 0;
    config('off');
    expect(await brokerCommand(t, args(undefined))).toBe(0);
    expect(t.out.at(-1)).toMatch(/^Alpaca paper, mode off: nothing is read from Alpaca and nothing is sent\./);
    // It names the setting and the file it lives in.
    expect(t.out.at(-1)).toMatch(/set brokers\.alpaca\.mode to read, dry_run or paper in .+config\.yaml\.$/);
    expect(await brokerCommand(t, args('reconcile'))).toBe(1);
    expect(await buy(t, '25', [])).toBe(1);
    expect(await buy(t)).toBe(1);
    expect(t.calls).toEqual([]);
    // CONTROL: in read mode the same status reads the account and the positions.
    config('read');
    expect(await brokerCommand(t, args(undefined))).toBe(0);
    expect(t.calls.map((c) => c.url.slice(base.length)).sort()).toEqual(['/v2/account', '/v2/positions']);
  });

  it('sizes a buy in dollars and takes no typed price, and values a sale by quantity itself', async () => {
    const t = await connected(['yes', 'yes']);
    config('paper');
    expect(await brokerCommand(t, args('order', ['btc/usd', 'buy'], { '--qty': '5', '--price': '-1' }, ['--paper']))).toBe(1);
    expect(t.errors.at(-1)).toMatch(/^--price is not taken: a buy is sized in dollars/);
    expect(await brokerCommand(t, args('order', ['btc/usd', 'buy'], { '--qty': '5' }, ['--paper']))).toBe(1);
    expect(t.errors.at(-1)).toContain('a buy is sized in dollars, so your caps hold at any price');
    expect(posts).toHaveLength(0);
    // CONTROL: the dollar buy goes, and what it bought can be sold by quantity within the cap.
    expect(await buy(t, '42')).toBe(0);
    expect(await brokerCommand(t, args('order', ['btc/usd', 'sell'], { '--qty': '0.0002' }, ['--paper']))).toBe(0);
    expect(JSON.parse(posts[1]!)).toMatchObject({ side: 'sell', qty: '0.0002' });
  });

  it('says when the log has placed nothing to compare', async () => {
    const t = await connected();
    expect(await brokerCommand(t, args('reconcile'))).toBe(0);
    expect(t.out.at(-1)).toBe('The log has placed no orders to compare.');
  });

  it("names Alpaca's fee on the walk's $10 crypto purchase, and says so where Alpaca holds less than the fee explains", async () => {
    const t = await connected(['yes']);
    config('paper');
    expect(await buy(t, '10')).toBe(0);
    // As Alpaca answered the personas walk on 2026-10-14: 0.000117715 filled, 0.00011742 held.
    orders.set('order-1', { ...orders.get('order-1')!, filled_qty: '0.000117715' });
    held = [{ symbol: 'BTCUSD', qty: '0.00011742', market_value: '9.78' }];
    t.out.length = 0;
    expect(await brokerCommand(t, args('reconcile'))).toBe(0);
    expect(t.out).toEqual(["BTCUSD: the log expects 0.000117715, Alpaca holds 0.00011742: the 0.000000295 less is within Alpaca's fee on a crypto purchase (up to 0.25%, taken in the coin)"]);
    // A shortfall of 1%, four times the fee.
    held = [{ symbol: 'BTCUSD', qty: '0.000116538', market_value: '9.71' }];
    t.out.length = 0;
    expect(await brokerCommand(t, args('reconcile'))).toBe(0);
    expect(t.out).toEqual(["BTCUSD: the log expects 0.000117715, Alpaca holds 0.000116538: the 0.000001177 less is more than Alpaca's fee on a crypto purchase (up to 0.25%, taken in the coin)"]);
    // CONTROL: a holding equal to the record is shown as before.
    held = [{ symbol: 'BTCUSD', qty: '0.000117715', market_value: '9.80' }];
    t.out.length = 0;
    expect(await brokerCommand(t, args('reconcile'))).toBe(0);
    expect(t.out).toEqual(['BTCUSD: the log expects 0.000117715, Alpaca holds 0.000117715']);
  });
});

describe('the yes of a person at a terminal', () => {
  it('places no paper order where the input or the output is not a terminal, and never reads the keys for it', async () => {
    const t = await connected(['yes'], false);
    config('paper');
    t.calls.length = 0;
    t.keychain = {
      set: async () => undefined,
      get: async () => {
        throw new Error('the keychain was read');
      },
      remove: async () => false,
    };
    expect(await buy(t)).toBe(1);
    expect(t.errors.at(-1)).toBe('The yes for a paper order is typed at a terminal, and this run has none: its input or its output is a pipe or a file. Run it in a terminal yourself. A dry run, without --paper, runs anywhere.');
    expect(t.asked.slice(2)).toEqual([]);
    expect(t.calls).toEqual([]);
    expect(posts).toHaveLength(0);
  });

  it('still runs a dry run with no terminal, since nothing goes anywhere', async () => {
    const t = await connected([], false);
    config('paper');
    expect(await buy(t, '25', [])).toBe(0);
    expect(t.out).toContain('A dry run: nothing was sent. The order as it would go to Alpaca:');
    expect(posts).toHaveLength(0);
  });

  it('turns a stopped connection back on only for a person at a terminal who types yes, after showing the stop', async () => {
    const t = await connected(['no', 'yes'], false);
    config('paper');
    log().append({ event: 'disabled', reason: '3 orders failed in a row' });
    expect(await brokerCommand(t, args('enable'))).toBe(1);
    expect(t.errors.at(-1)).toBe('Turning the connection back on is asked of you at a terminal, and this run has none: its input or its output is a pipe or a file. Run it in a terminal yourself.');
    expect(t.asked.slice(2)).toEqual([]);
    expect(log().disabled()).toBe('3 orders failed in a row');
    t.terminal = true;
    expect(await brokerCommand(t, args('enable'))).toBe(0);
    expect(t.asked.at(-1)?.q).toBe('Turn the connection back on? Type yes to turn it on: ');
    expect(t.out).toContain('The connection is off: 3 orders failed in a row.');
    expect(t.out.at(-1)).toBe('It stays off.');
    expect(log().disabled()).toBe('3 orders failed in a row');
    expect(await brokerCommand(t, args('enable'))).toBe(0);
    expect(log().disabled()).toBeNull();
    expect(await brokerCommand(t, args('enable'))).toBe(1);
    expect(t.errors.at(-1)).toBe('The connection is not off.');
  });

  it('counts as a terminal only when the input and the output both are one', () => {
    const tty = { isTTY: true };
    const pipe = {};
    expect(isTerminal({ stdin: tty, stdout: tty })).toBe(true);
    // An answer's markdown bold: dropped in a terminal, kept for a pipe or a file.
    expect(forTerminal('**BTC at $84,512.32.**\n\nBody **bold** text.', true)).toBe('BTC at $84,512.32.\n\nBody bold text.');
    expect(forTerminal('**BTC at $84,512.32.**', false)).toBe('**BTC at $84,512.32.**');
    // Doctor: a step that is yours to take is neither ok nor a fault.
    expect(doctorLine(null, 'The digest is not scheduled: primerkit schedule 08:00')).toBe('-  The digest is not scheduled: primerkit schedule 08:00');
    expect(doctorLine(true, 'Node 22.14.0')).toBe('ok Node 22.14.0');
    expect(doctorLine(false, 'No model is set')).toBe('x  No model is set');
    expect(isTerminal({ stdin: pipe, stdout: tty })).toBe(false);
    expect(isTerminal({ stdin: tty, stdout: pipe })).toBe(false);
    expect(isTerminal({ stdin: pipe, stdout: pipe })).toBe(false);
    expect(isTerminal({ stdin: { isTTY: false }, stdout: tty })).toBe(false);
  });

  // A process started the way an AI app's command tool starts one: "yes" on a pipe. Run
  // on a child that wires the broker command as the real one does (its own terminal rule
  // and question function) but keeps its keychain in memory and talks to the fake Alpaca.
  // The real command is not used for an order: if the rule ever failed, the real command
  // would go on to the system's keychain and, with paper keys kept there, to Alpaca.
  function piped(command: string[], env: Record<string, string>): Promise<{ code: number | null; out: string; err: string }> {
    return new Promise((resolve) => {
      const child = spawn(process.execPath, command, { cwd: ROOT, env: { ...process.env, PRIMERKIT_HOME: home, FAKE_BASE: base, ...env }, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
      let out = '';
      let err = '';
      child.stdout.on('data', (d: Buffer) => (out += d.toString()));
      child.stderr.on('data', (d: Buffer) => (err += d.toString()));
      child.on('close', (code) => resolve({ code, out, err }));
      child.stdin.end('yes\n');
    });
  }
  const CHILD = ['--import', 'tsx', fileURLToPath(new URL('./piped-yes-child.ts', import.meta.url))];

  it('refuses a yes that comes on a pipe: nothing is asked, nothing is placed and no stop is lifted', async () => {
    config('paper');
    const order = await piped(CHILD, {});
    expect(order.out).toContain('a terminal: false');
    expect(order.code).toBe(1);
    expect(order.err).toContain('The yes for a paper order is typed at a terminal, and this run has none');
    expect(order.out).not.toContain('Place this paper order?');
    expect(posts).toHaveLength(0);
    expect(existsSync(join(home, 'broker', 'alpaca.jsonl'))).toBe(false);
    mkdirSync(join(home, 'broker'), { recursive: true });
    log().append({ event: 'disabled', reason: 'a stop' });
    const enable = await piped(CHILD, { CHILD_COMMAND: 'enable' });
    expect(enable.code).toBe(1);
    expect(enable.err).toContain('Turning the connection back on is asked of you at a terminal, and this run has none');
    expect(log().disabled()).toBe('a stop');
    expect(readFileSync(join(home, 'broker', 'alpaca.jsonl'), 'utf8').split('\n').filter(Boolean)).toHaveLength(1);
    // CONTROL: the same child with the rule skipped takes the piped yes and places the
    // order at the fake Alpaca, so the refusal above is the rule's doing.
    log().append({ event: 'enabled' });
    const skipped = await piped(CHILD, { CHILD_AS_TERMINAL: '1' });
    expect(skipped.out).toContain('a terminal: false');
    expect(skipped.out).toContain('Placed on paper');
    expect(posts).toHaveLength(1);
  }, 180_000);

  it('the child runs nothing without the fake address, where the broker would use the real paper one', async () => {
    config('paper');
    for (const address of ['', 'https://paper-api.alpaca.markets', 'http://127.0.0.1:1/x']) {
      const r = await piped(CHILD, { FAKE_BASE: address, CHILD_AS_TERMINAL: '1' });
      expect(r.code).toBe(2);
      expect(r.err).toContain('FAKE_BASE is not an address on this machine, so nothing was run');
      expect(r.out).toBe('');
    }
    expect(posts).toHaveLength(0);
    expect(existsSync(join(home, 'broker', 'alpaca.jsonl'))).toBe(false);
  }, 180_000);

  it('the command itself refuses to lift a stop with a yes on a pipe', async () => {
    // `broker enable` reads and writes only the log in this test's own home, so the real
    // command is safe to run here whatever it does.
    config('paper');
    log().append({ event: 'disabled', reason: 'a stop' });
    const enable = await piped([BIN, 'broker', 'enable'], {});
    expect(enable.code).toBe(1);
    expect(enable.err).toContain('Turning the connection back on is asked of you at a terminal, and this run has none');
    expect(log().disabled()).toBe('a stop');
  }, 180_000);
});

describe('the stops, through the command', () => {
  it('turns the connection off when Alpaca holds something else than the record, and back on with enable, the record starting again there', async () => {
    const t = await connected(['yes', 'yes', 'yes']);
    config('paper');
    expect(await buy(t, '42')).toBe(0);
    // Alpaca now holds four times what the order bought: something outside primerkit changed it.
    held = [{ symbol: 'BTCUSD', qty: '0.002', market_value: '168' }];
    expect(await buy(t, '42')).toBe(1);
    expect(t.errors.at(-1)).toContain('the connection is now off: the broker holds 0.002 BTCUSD where the log expects 0.0005');
    expect(posts).toHaveLength(1);
    expect(await brokerCommand(t, args('enable'))).toBe(0);
    expect(t.out.slice(-2)).toEqual(['The connection is back on. Its log keeps the stop that turned it off.', 'What Alpaca holds now is where the record starts again: holdings are compared from your next order on.']);
    // Turned back on, the next order goes: the old order is compared no more.
    expect(await buy(t, '42')).toBe(0);
    expect(posts).toHaveLength(2);
    expect(await brokerCommand(t, args('enable'))).toBe(1);
    expect(t.errors.at(-1)).toBe('The connection is not off.');
  });

  it('treats an order whose answer was lost as unknown: off at once, found again by reconcile, and only then turned back on', async () => {
    const t = await connected(['yes', 'yes', 'yes']);
    config('paper', '{ max_notional: 50, max_position_share: 0.05, symbols: [BTC/USD], max_orders_per_day: 1 }');
    dropAnswer = true;
    expect(await buy(t)).toBe(1);
    expect(t.errors.at(-1)).toMatch(/^The order was sent, and no readable answer came back \(Alpaca could not be reached: .+\), so Alpaca may hold it\. The connection is off\. primerkit broker reconcile asks Alpaca for the order by its id \(primerkit-.+\); then primerkit broker enable turns it back on\.$/);
    expect(orders.size).toBe(1);
    dropAnswer = false;
    // It used to read "Alpaca did not take it", and a second order went the same day.
    expect(await buy(t)).toBe(1);
    expect(orders.size).toBe(1);
    expect(await brokerCommand(t, args('enable'))).toBe(1);
    expect(t.errors.at(-1)).toMatch(/^An order primerkit sent has no outcome on record \(primerkit-.+\)\. Run primerkit broker reconcile first: it asks Alpaca for it\.$/);
    expect(await brokerCommand(t, args('reconcile'))).toBe(0);
    expect(t.out.join('\n')).toMatch(/primerkit-.+: Alpaca holds this order, so the log now says it was placed/);
    expect(await brokerCommand(t, args('enable'))).toBe(0);
    expect(log().disabled()).toBeNull();
    // It was today's one order.
    expect(await buy(t)).toBe(1);
    expect(t.errors.at(-1)).toContain('1 orders were sent today, your cap is 1 (a day is a UTC day)');
    expect(orders.size).toBe(1);
  });
});

describe('the network ledger', () => {
  it("sends every call of an order's whole life to the one paper address, on five paths, with four headers, and follows no redirect", async () => {
    const t = await connected(['yes']);
    config('paper');
    expect(await brokerCommand(t, args(undefined))).toBe(0);
    expect(await buy(t, '25', [])).toBe(0);
    expect(await buy(t)).toBe(0);
    expect(await brokerCommand(t, args('order', ['btc/usd', 'sell'], { '--qty': '0.0001' }, []))).toBe(0);
    expect(await brokerCommand(t, args('reconcile'))).toBe(0);
    expect(posts).toHaveLength(1);
    const paths = /^\/v2\/(account|positions|assets\/[A-Za-z0-9%]+|orders|orders\/[A-Za-z0-9-]+|orders:by_client_order_id\?client_order_id=[A-Za-z0-9-]+)$/;
    const headers = ['APCA-API-KEY-ID', 'APCA-API-SECRET-KEY', 'Accept', 'Content-Type'];
    expect(t.calls.length).toBeGreaterThan(8);
    for (const call of t.calls) {
      expect(call.url.startsWith(`${base}/`), call.url).toBe(true);
      expect(call.url.slice(base.length), call.url).toMatch(paths);
      expect(call.headers.filter((h) => !headers.includes(h)), call.url).toEqual([]);
      expect(call.redirect, call.url).toBe('manual');
      expect(['GET', 'POST']).toContain(call.method);
      if (call.method === 'POST') expect(call.url).toBe(`${base}/v2/orders`);
    }
    // Every kind of call this life makes was among them.
    expect(new Set(t.calls.map((c) => `${c.method} ${c.url.slice(base.length).replace(/order-\d+$/, '<id>')}`))).toEqual(new Set(['GET /v2/account', 'GET /v2/positions', 'GET /v2/assets/BTC%2FUSD', 'POST /v2/orders', 'GET /v2/orders/<id>']));
  });

  it("sends every call of an intent's whole life (draft, check, place, refresh, cancel) to the one paper address, and nothing elsewhere", async () => {
    const t = await connected(['yes', 'yes']);
    config('paper', '{ max_notional: 50000, max_position_share: 0.9, symbols: [BTC/USD], max_orders_per_day: 5 }');
    newRoutine(home, 'wf');
    const routine = loadRoutine(join(routinesDir(home), 'wf'));
    mkdirSync(join(routine.dir, 'forward'), { recursive: true });
    const label = (target: number) => writeFileSync(join(routine.dir, 'forward', 'record.jsonl'), `${JSON.stringify({ at: '2026-10-11T07:30:00.000Z', day: '2026-10-11', close: { date: '2026-10-10', price: PRICE }, label: 'enter', outcome: 'passed', runId: 'r1', model: 'm', rulesHash: 'h', target, capped: false, reads: [] })}\n`);
    const at = new Date('2026-10-11T10:00:00.000Z');
    const dir = join(home, 'journal', '2026-10-11', 'intent');
    const draft = async (target: number) => {
      label(target);
      const before = existsSync(dir) ? readdirSync(dir) : [];
      expect(await routineIntent(t, routine, at)).toBe(0);
      return readdirSync(dir).find((d) => !before.includes(d))!;
    };
    const first = await draft(0.5);
    expect(await intentCommand(t, [first, 'check'], at)).toBe(0);
    expect(await intentCommand(t, [first, 'place'], at)).toBe(0);
    expect(await intentCommand(t, [first, 'refresh'], at)).toBe(0);
    waitFill = true;
    const second = await draft(0.8);
    expect(await intentCommand(t, [second, 'place'], at)).toBe(0);
    expect(await intentCommand(t, [second, 'cancel'], at)).toBe(0);
    expect(posts).toHaveLength(2);
    const paths = /^\/v2\/(account|positions|assets\/[A-Za-z0-9%]+|orders|orders\/[A-Za-z0-9-]+)$/;
    for (const call of t.calls) {
      expect(call.url.startsWith(`${base}/`), call.url).toBe(true);
      expect(call.url.slice(base.length), call.url).toMatch(paths);
      expect(call.redirect, call.url).toBe('manual');
      if (call.method === 'POST') expect(call.url).toBe(`${base}/v2/orders`);
      if (call.method === 'DELETE') expect(call.url).toBe(`${base}/v2/orders/order-2`);
    }
    expect(new Set(t.calls.map((c) => `${c.method} ${c.url.slice(base.length).replace(/order-\d+$/, '<id>')}`))).toEqual(new Set(['GET /v2/account', 'GET /v2/positions', 'GET /v2/assets/BTC%2FUSD', 'POST /v2/orders', 'GET /v2/orders/<id>', 'DELETE /v2/orders/<id>']));
  });
});

describe('primerkit routine <name> intent', () => {
  // The routine wf with one label in its forward record, as track writes it.
  const routineWith = (over: Partial<ForwardEntry> = {}) => {
    newRoutine(home, 'wf');
    const routine = loadRoutine(join(routinesDir(home), 'wf'));
    const entry: ForwardEntry = { at: '2026-10-11T07:30:00.000Z', day: '2026-10-11', close: { date: '2026-10-10', price: PRICE }, label: 'enter', outcome: 'passed', runId: '20261011T073000Z-abc123', model: 'qwen2.5:7b', rulesHash: '1a2b3c4d5e6f7a8b', target: 0.5, capped: false, reads: [], ...over };
    mkdirSync(join(routine.dir, 'forward'), { recursive: true });
    writeFileSync(join(routine.dir, 'forward', 'record.jsonl'), `${JSON.stringify(entry)}\n`);
    return routine;
  };
  const NOW = new Date('2026-10-11T10:00:00.000Z');

  it('drafts an intent from the newest label, sized on the paper account, keeps it in the journal, and sends nothing', async () => {
    const t = await connected();
    config('dry_run');
    held = [{ symbol: 'BTCUSD', qty: '0.25', market_value: String(0.25 * PRICE) }];
    t.calls.length = 0;
    t.out.length = 0;
    expect(await routineIntent(t, routineWith(), NOW)).toBe(0);
    // $100,000 of equity at 50% is $50,000, and $21,000 is held: $29,000 to buy.
    expect(t.out[0]).toBe("Drafted an order intent from wf's label enter, given at 2026-10-11 07:30 UTC:");
    expect(t.out).toContain('  buy BTC/USD, to 50% of equity');
    expect(t.out).toContain('  On the paper account now: $29,000.00 to buy: 50% of equity of $100,000.00 is $50,000.00, and $21,000.00 is held.');
    expect(t.out).toContain('Your rules and your model decided; PreReason supplied data.');
    expect(t.out.at(-1)).toMatch(/^It is a draft, kept in .+\. Nothing is sent: an order goes only after its checks and your yes, typed at a terminal\. It expires at 11:00 UTC\.$/);
    const dir = join(home, 'journal', '2026-10-11', 'intent');
    const [id] = readdirSync(dir);
    const record = readIntent(join(dir, id!), NOW);
    expect(record.state).toBe('draft');
    expect(record.intent).toMatchObject({ side: 'buy', sizing: { kind: 'target_share', share: 0.5 }, source: { kind: 'routine', routine: 'wf' } });
    // The account was read, and nothing was sent: no order, and nothing to PreReason.
    expect(t.calls.map((c) => `${c.method} ${c.url.slice(base.length)}`).sort()).toEqual(['GET /v2/account', 'GET /v2/positions']);
    expect(posts).toEqual([]);
  });

  it('drafts nothing, and reads nothing, where there is no label, the connection is off, or Alpaca is not connected', async () => {
    newRoutine(home, 'none');
    const t = io();
    expect(await routineIntent(t, loadRoutine(join(routinesDir(home), 'none')), NOW)).toBe(1);
    expect(t.errors.at(-1)).toBe('none has no label yet to draft an intent from: primerkit routine none track runs it once.');
    expect(await routineIntent(t, routineWith(), NOW)).toBe(1);
    expect(t.errors.at(-1)).toMatch(/^Alpaca paper, mode off: nothing is read from Alpaca\. An intent is sized on the paper account's own figures/);
    config('read');
    expect(await routineIntent(t, loadRoutine(join(routinesDir(home), 'wf')), NOW)).toBe(1);
    expect(t.errors.at(-1)).toBe('Alpaca is not connected: primerkit connect alpaca');
    expect(t.calls).toEqual([]);
    // A label that keeps what is held drafts nothing, and says so.
    const c = await connected();
    config('read');
    writeFileSync(join(home, 'routines', 'wf', 'forward', 'record.jsonl'), `${JSON.stringify({ at: '2026-10-11T07:30:00.000Z', day: '2026-10-11', close: { date: '2026-10-10', price: PRICE }, label: 'watch', outcome: 'passed', runId: 'r', model: 'm', rulesHash: 'h', target: null, capped: false, reads: [] })}\n`);
    expect(await routineIntent(c, loadRoutine(join(routinesDir(home), 'wf')), NOW)).toBe(0);
    expect(c.out.at(-1)).toBe("No intent was drafted: wf's label watch keeps what is held, so there is no order to draft.");
    expect(existsSync(join(home, 'journal'))).toBe(false);
  });

  // Caps that let the routine's $29,000 buy through.
  const ROOMY = '{ max_notional: 50000, max_position_share: 0.6, symbols: [BTC/USD], max_orders_per_day: 5 }';

  it('lists the intents, shows one with where it came from, and runs its checks on the paper account, writing nothing and sending nothing', async () => {
    const t = await connected();
    config('paper', ROOMY);
    held = [{ symbol: 'BTCUSD', qty: '0.25', market_value: String(0.25 * PRICE) }];
    expect(await routineIntent(t, routineWith(), NOW)).toBe(0);
    const dir = join(home, 'journal', '2026-10-11', 'intent');
    const [id] = readdirSync(dir);
    t.out.length = 0;
    expect(await intentCommand(t, [], NOW)).toBe(0);
    expect(t.out).toEqual(['Your order intents, newest first:', `  ${id}  draft            buy BTC/USD, to 50% of equity`, '', 'primerkit intent <id> shows one.']);
    t.out.length = 0;
    expect(await intentCommand(t, [id!], NOW)).toBe(0);
    expect(t.out[0]).toBe('buy BTC/USD, to 50% of equity: draft');
    expect(t.out[1]).toBe("  From the routine wf's label, given at 2026-10-11T07:30:00.000Z. Drafted 2026-10-11T10:00:00.000Z; it expires 2026-10-11T11:00:00.000Z.");
    expect(t.out).toContain('Your rules and your model decided; PreReason supplied data.');
    t.out.length = 0;
    t.calls.length = 0;
    expect(await intentCommand(t, [id!, 'check'], new Date('2026-10-11T10:10:00.000Z'))).toBe(0);
    expect(t.out[0]).toBe('The pre-trade checks of buy BTC/USD, to 50% of equity:');
    expect(t.out).toContain('  ok max_notional     $29,000.00 is within your cap of $50,000.00 an order');
    expect(t.out).toContain('  ok asset            BTC/USD, crypto, from Alpaca\'s asset list');
    expect(t.out).toContain('All 17 checks pass.');
    expect(t.out.at(-1)).toBe("Nothing was written and nothing was sent. Before an order goes, every check runs again, and the broker's record is compared with what Alpaca holds.");
    expect(t.calls.map((c) => `${c.method} ${c.url.slice(base.length)}`).sort()).toEqual(['GET /v2/account', 'GET /v2/assets/BTC%2FUSD', 'GET /v2/positions']);
    expect(posts).toEqual([]);
    expect(readdirSync(join(dir, id!))).toEqual(['intent.json']);
    // With the kill switch on, the same check names it and fails.
    mkdirSync(join(home, 'broker'), { recursive: true });
    writeFileSync(join(home, 'broker', 'STOP'), '');
    t.out.length = 0;
    expect(await intentCommand(t, [id!, 'check'], new Date('2026-10-11T10:10:00.000Z'))).toBe(0);
    expect(t.out).toContain(`  x  kill_switch      on: ${join(home, 'broker', 'STOP')} is there, and no order goes while it is`);
    expect(t.out).toContain('1 of 17 checks fail, so it would not go.');
  });

  it('checks a sale to none on the share it leaves, 0% of equity, not the share held now', async () => {
    const t = await connected();
    config('paper');
    // $9.86 of BTC held on $100,000 of equity, 0.01% of it, and a label whose target is none.
    held = [{ symbol: 'BTCUSD', qty: '0.00011742', market_value: String(0.00011742 * PRICE) }];
    expect(await routineIntent(t, routineWith({ label: 'exit', target: 0 }), NOW)).toBe(0);
    const [id] = readdirSync(join(home, 'journal', '2026-10-11', 'intent'));
    t.out.length = 0;
    expect(await intentCommand(t, [id!, 'check'], new Date('2026-10-11T10:10:00.000Z'))).toBe(0);
    expect(t.out[0]).toBe('The pre-trade checks of sell BTC/USD, to 0% of equity:');
    expect(t.out).toContain('  ok position_share   BTC/USD would be 0% of equity after this sale; your cap is 5%');
    expect(t.out).toContain('  ok total_exposure   all positions would be 0% of equity after this sale; you set no cap on them together');
    expect(t.out).toContain('All 17 checks pass.');
    expect(posts).toEqual([]);
  });

  it("refuses as a trigger a PreReason publication the catalogue marks, reading the marks only for such a trigger", async () => {
    const t = await connected();
    config('paper', ROOMY);
    held = [{ symbol: 'BTCUSD', qty: '0.25', market_value: String(0.25 * PRICE) }];
    expect(await routineIntent(t, routineWith(), NOW)).toBe(0);
    const dir = join(home, 'journal', '2026-10-11', 'intent');
    const [id] = readdirSync(dir);
    let asked = 0;
    const marks = async () => {
      asked += 1;
      return { marked: new Set(['btc.momentum', 'cot-btc-net']), listed: new Set(['btc.momentum', 'cot-btc-net', 'macro.snapshot']) };
    };
    const at = new Date('2026-10-11T10:10:00.000Z');
    // A market order needs no marks, and nothing is read for them.
    t.out.length = 0;
    expect(await intentCommand(t, [id!, 'check'], at, () => undefined, marks)).toBe(0);
    expect(asked).toBe(0);
    expect(t.out).toContain('All 17 checks pass.');
    // The same intent waiting on a PreReason publication that the catalogue marks.
    const file = join(dir, id!, 'intent.json');
    writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, 'utf8')), entry: { kind: 'trigger', condition: { kind: 'prereason_event', source: 'btc.momentum' } } }, null, 2));
    t.out.length = 0;
    expect(await intentCommand(t, [id!, 'check'], at, () => undefined, marks)).toBe(0);
    expect(asked).toBe(1);
    expect(t.out).toContain("  x  entry            btc.momentum can never be a trigger: PreReason's catalogue marks it as measuring a futures, swap or options market");
    expect(t.out).toContain('1 of 17 checks fail, so it would not go.');
    // Placing it is refused the same way, and nothing is sent.
    expect(await intentCommand(t, [id!, 'place'], at, () => undefined, marks)).toBe(1);
    expect(t.errors.at(-1)).toContain('btc.momentum can never be a trigger');
    // An id the catalogue does not list is refused as unknown, never taken for unmarked.
    writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, 'utf8')), entry: { kind: 'trigger', condition: { kind: 'prereason_event', source: 'btc.momentun' } } }, null, 2));
    t.out.length = 0;
    expect(await intentCommand(t, [id!, 'check'], at, () => undefined, marks)).toBe(0);
    expect(t.out).toContain("  x  entry            btc.momentun cannot be a trigger: PreReason's catalogue does not list it, so whether it measures a futures, swap or options market is not known");
    writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, 'utf8')), entry: { kind: 'trigger', condition: { kind: 'prereason_event', source: 'btc.momentum' } } }, null, 2));
    // With the marks unreadable, the publication is refused all the same.
    t.out.length = 0;
    expect(await intentCommand(t, [id!, 'check'], at, () => undefined, async () => { throw new Error('PreReason is out of reach'); })).toBe(0);
    expect(t.out.some((l) => l.includes("btc.momentum cannot be a trigger: PreReason's catalogue could not be read"))).toBe(true);
    expect(posts).toEqual([]);
  });

  it('finds an intent by its id alone, and refuses anything else as one', async () => {
    const t = io();
    expect(await intentCommand(t, [], NOW)).toBe(0);
    expect(t.out).toEqual(["No order intents yet. primerkit routine <name> intent drafts one from a routine's label."]);
    for (const id of ['../../etc', '20261011T100000Z-zzzzzz', '20261011T100000Z-abc123']) {
      expect(await intentCommand(t, [id], NOW)).toBe(1);
      expect(t.errors.at(-1)).toBe(`There is no order intent ${id} in the journal. primerkit intent lists them.`);
    }
  });
});

describe('primerkit broker disable', () => {
  it('turns the connection off at once, from anywhere, so no order goes, a dry run included, until broker enable', async () => {
    const t = await connected([], false);
    config('dry_run');
    expect(await brokerCommand(t, args('disable'))).toBe(0);
    expect(t.out.at(-2)).toBe('The connection is off: no order goes, a dry run included, until primerkit broker enable, which asks your yes at a terminal.');
    expect(log().disabled()).toBe('turned off by hand with primerkit broker disable');
    expect(await buy(t, '25', [])).toBe(1);
    expect(t.errors.at(-1)).toContain('the connection is off since a stop condition: turned off by hand with primerkit broker disable');
    expect(await brokerCommand(t, args('disable'))).toBe(1);
    expect(t.errors.at(-1)).toBe('The connection is already off: turned off by hand with primerkit broker disable.');
    expect(posts).toEqual([]);
  });

  it('says in the status when the kill switch file is there', async () => {
    const t = await connected();
    config('read');
    mkdirSync(join(home, 'broker'), { recursive: true });
    writeFileSync(join(home, 'broker', 'STOP'), '');
    expect(await brokerCommand(t, args(undefined))).toBe(0);
    expect(t.out).toContain(`Alpaca paper, mode read, and the kill switch is on (${join(home, 'broker', 'STOP')})`);
  });
});

describe('placing an order intent on paper', () => {
  const AT = new Date('2026-10-11T10:10:00.000Z');
  // A routine's draft of $29,000 to buy, on $100,000 of equity holding 0.25 BTC, in mode paper
  // with caps that let it through. The answers are typed at the terminal, in order.
  const drafted = async (answers: string[] = [], mode = 'paper') => {
    const t = await connected(answers);
    config(mode, '{ max_notional: 50000, max_position_share: 0.6, symbols: [BTC/USD], max_orders_per_day: 5 }');
    held = [{ symbol: 'BTCUSD', qty: '0.25', market_value: String(0.25 * PRICE) }];
    if (!existsSync(join(routinesDir(home), 'wf'))) newRoutine(home, 'wf');
    const routine = loadRoutine(join(routinesDir(home), 'wf'));
    mkdirSync(join(routine.dir, 'forward'), { recursive: true });
    writeFileSync(join(routine.dir, 'forward', 'record.jsonl'), `${JSON.stringify({ at: '2026-10-11T07:30:00.000Z', day: '2026-10-11', close: { date: '2026-10-10', price: PRICE }, label: 'enter', outcome: 'passed', runId: 'r1', model: 'm', rulesHash: 'h1h2h3h4h5h6', target: 0.5, capped: false, reads: [] })}\n`);
    const dir = join(home, 'journal', '2026-10-11', 'intent');
    const before = existsSync(dir) ? readdirSync(dir) : [];
    expect(await routineIntent(t, routine, new Date('2026-10-11T10:00:00.000Z'))).toBe(0);
    const id = readdirSync(dir).find((d) => !before.includes(d))!;
    t.out.length = 0;
    t.calls.length = 0;
    return { t, id, folder: join(dir, id) };
  };

  it('shows the checks and the exact order, places it on a yes, and keeps each step in the intent folder', async () => {
    const { t, id, folder } = await drafted(['yes']);
    expect(await intentCommand(t, [id, 'place'], AT)).toBe(0);
    expect(t.asked.at(-1)?.q).toBe('Place this paper order? Type yes to place it: ');
    expect(t.out[0]).toBe('buy BTC/USD, to 50% of equity: all 17 pre-trade checks pass. $29,000.00 to buy: 50% of equity of $100,000.00 is $50,000.00, and $21,000.00 is held.');
    expect(t.out).toContain('Your rules and your model decided; PreReason supplied data.');
    expect(posts).toHaveLength(1);
    expect(JSON.parse(posts[0]!)).toMatchObject({ symbol: 'BTC/USD', side: 'buy', type: 'market', time_in_force: 'gtc', notional: '29000.00' });
    expect(readdirSync(folder).sort()).toEqual(['approval.json', 'checks.final.json', 'checks.json', 'intent.json', 'orders.jsonl']);
    const record = readIntent(folder, AT);
    expect(record.state).toBe('sent');
    expect(record.approval).toMatchObject({ typed: 'yes', body: { symbol: 'BTC/USD', notional: '29000.00' } });
    expect(record.approval?.user).not.toContain('@');
    expect(record.checks?.computed.notional).toBe(29000);
    expect(record.finalChecks?.checks.find((c) => c.check === 'state')).toMatchObject({ passed: true, value: 'approved' });
    expect(record.orders).toEqual([expect.objectContaining({ broker_order_id: 'order-1', status: 'accepted', client_order_id: JSON.parse(posts[0]!).client_order_id })]);
    // The fills, read from Alpaca.
    t.out.length = 0;
    expect(await intentCommand(t, [id, 'refresh'], AT)).toBe(0);
    expect(t.out).toEqual([`Order order-1: filled, ${29000 / PRICE} filled at $84,000.`, 'The intent is filled.']);
    expect(await intentCommand(t, [id, 'refresh'], AT)).toBe(0);
    expect(t.out.at(-1)).toBe('Order order-1: filled, as before.');
    // A filled intent has nothing to cancel, and cannot be placed again.
    expect(await intentCommand(t, [id, 'cancel'], AT)).toBe(1);
    expect(t.errors.at(-1)).toBe('Its order has filled, so there is nothing to cancel. A new intent sells what is held.');
    expect(await intentCommand(t, [id, 'place'], AT)).toBe(1);
    expect(t.errors.at(-1)).toContain('  x  state            it is filled, and only a draft or a ready intent goes on');
    expect(posts).toHaveLength(1);
  });

  it('places nothing and writes nothing without the yes, in a dry run, without a terminal, or when a check fails', async () => {
    const no = await drafted(['no']);
    expect(await intentCommand(no.t, [no.id, 'place'], AT)).toBe(0);
    expect(no.t.out.at(-1)).toBe('Not placed. The intent stays as it was.');
    expect(readdirSync(no.folder)).toEqual(['intent.json']);
    const dry = await drafted([], 'dry_run');
    expect(await intentCommand(dry.t, [dry.id, 'place'], AT)).toBe(0);
    expect(dry.t.out[0]).toBe('A dry run: nothing was sent, and the intent stays as it was. The order as it would go to Alpaca:');
    expect(dry.t.asked.map((a) => a.q)).not.toContain('Place this paper order? Type yes to place it: ');
    expect(readdirSync(dry.folder)).toEqual(['intent.json']);
    const pipe = await drafted(['yes']);
    pipe.t.terminal = false;
    expect(await intentCommand(pipe.t, [pipe.id, 'place'], AT)).toBe(1);
    expect(pipe.t.errors.at(-1)).toBe('The yes for a paper order is typed at a terminal, and this run has none: its input or its output is a pipe or a file. Run it in a terminal yourself.');
    expect(pipe.t.calls).toEqual([]);
    const late = await drafted(['yes']);
    expect(await intentCommand(late.t, [late.id, 'place'], new Date('2026-10-11T11:00:01.000Z'))).toBe(1);
    // Expired, it is no draft any more either: two checks fail.
    expect(late.t.errors.at(-1)).toMatch(/^Not placed: 2 of 17 checks fail\.\n {2}x {2}state {12}it is expired, and only a draft or a ready intent goes on\n {2}x {2}expiry/);
    expect(readdirSync(late.folder)).toEqual(['intent.json']);
    expect(posts).toEqual([]);
  });

  it('runs every check again after the yes, and closes the intent as refused when one fails then', async () => {
    const { t, id, folder } = await drafted();
    // The kill switch is turned on while the question waits for the yes.
    t.ask = async (q) => {
      t.asked.push({ q, hidden: false });
      mkdirSync(join(home, 'broker'), { recursive: true });
      writeFileSync(join(home, 'broker', 'STOP'), '');
      return 'yes';
    };
    expect(await intentCommand(t, [id, 'place'], AT)).toBe(1);
    expect(t.errors.at(-1)).toBe(`Not placed: after your yes, a check failed, so the intent is closed as refused.\n  x  kill_switch      on: ${join(home, 'broker', 'STOP')} is there, and no order goes while it is`);
    // Closed, its page is written beside it.
    expect(readdirSync(folder).sort()).toEqual(['approval.json', 'checks.final.json', 'checks.json', 'close.json', 'intent.json', 'render.md']);
    expect(readIntent(folder, AT).state).toBe('refused');
    expect(posts).toEqual([]);
  });

  it('cancels a draft at once, and an order that has not filled at Alpaca', async () => {
    const draft = await drafted();
    expect(await intentCommand(draft.t, [draft.id, 'cancel'], AT)).toBe(0);
    expect(draft.t.out.at(-1)).toBe('Cancelled. No order had gone.');
    expect(readIntent(draft.folder, AT).state).toBe('cancelled');
    expect(draft.t.calls).toEqual([]);
    waitFill = true;
    const open = await drafted(['yes']);
    expect(await intentCommand(open.t, [open.id, 'place'], AT)).toBe(0);
    expect(await intentCommand(open.t, [open.id, 'cancel'], AT)).toBe(0);
    expect(open.t.out.at(-1)).toBe('Cancelled at Alpaca, with nothing filled.');
    expect(open.t.calls.some((c) => c.method === 'DELETE' && c.url.endsWith('/v2/orders/order-1'))).toBe(true);
    const record = readIntent(open.folder, AT);
    expect(record.state).toBe('cancelled');
    expect(record.orders.map((o) => o.status)).toEqual(['accepted', 'canceled']);
  });
});

describe('a symbol from Alpaca\'s asset list', () => {
  it('sends BTCUSD, with no slash, as the crypto pair BTC/USD, and refuses a symbol Alpaca does not list', async () => {
    const t = await connected();
    config('dry_run');
    expect(await brokerCommand(t, args('order', ['BTCUSD', 'buy'], { '--notional': '25' }, []))).toBe(0);
    expect(t.out.join('\n')).toContain('"symbol": "BTC/USD"');
    expect(t.out.join('\n')).toContain('"time_in_force": "gtc"');
    expect(await brokerCommand(t, args('order', ['NOPE', 'buy'], { '--notional': '25' }, []))).toBe(1);
    expect(t.errors.at(-1)).toBe("NOPE is not in Alpaca's asset list, so nothing was sent.");
    expect(posts).toEqual([]);
  });
});

describe('a standing exit at Alpaca paper (his answer B)', () => {
  const AT = new Date('2026-10-11T10:10:00.000Z');
  // The routine wf with a stop of its own: 5% below the fill, its limit 1% below the stop.
  const withStop = async (answers: string[]) => {
    const t = await connected(answers);
    config('paper', '{ max_notional: 60000, max_position_share: 0.6, symbols: [BTC/USD], max_orders_per_day: 5 }');
    const dir = join(routinesDir(home), 'wf');
    if (!existsSync(dir)) newRoutine(home, 'wf');
    writeFileSync(join(dir, 'routine.yaml'), 'rules: rules.md\nlabels:\n  watch: { hold: true }\n  enter: { target: 0.5 }\nexits:\n  stop: 0.05\n  stop_limit_gap: 0.01\n');
    const routine = loadRoutine(dir);
    mkdirSync(join(dir, 'forward'), { recursive: true });
    writeFileSync(join(dir, 'forward', 'record.jsonl'), `${JSON.stringify({ at: '2026-10-11T07:30:00.000Z', day: '2026-10-11', close: { date: '2026-10-10', price: PRICE }, label: 'enter', outcome: 'passed', runId: 'r1', model: 'm', rulesHash: 'h', target: 0.5, capped: false, reads: [] })}\n`);
    const folder = join(home, 'journal', '2026-10-11', 'intent');
    const before = existsSync(folder) ? readdirSync(folder) : [];
    expect(await routineIntent(t, routine, new Date('2026-10-11T10:00:00.000Z'))).toBe(0);
    const id = readdirSync(folder).find((d) => !before.includes(d))!;
    return { t, id, folder: join(folder, id) };
  };

  it("is shown with the buy and covered by its yes, rests at Alpaca once the buy fills, and its fill closes the intent", async () => {
    const { t, id, folder } = await withStop(['yes']);
    t.out.length = 0;
    expect(await intentCommand(t, [id, 'place'], AT)).toBe(0);
    const shown = 'Once it fills, a stop 5% below the fill price, sent as a stop-limit order with its limit 1% below the stop rests at Alpaca paper and sells what it bought, without a second yes. This yes covers it.';
    expect(t.out).toContain(shown);
    expect(readIntent(folder, AT).approval?.exits).toBe(shown);
    expect(posts).toHaveLength(1);
    // The buy has filled: the refresh reads it, and places the stop to rest.
    waitFill = true;
    t.out.length = 0;
    expect(await intentCommand(t, [id, 'refresh'], AT)).toBe(0);
    const bought = 50_000 / PRICE;
    expect(posts).toHaveLength(2);
    expect(JSON.parse(posts[1]!)).toMatchObject({ symbol: 'BTC/USD', side: 'sell', type: 'stop_limit', time_in_force: 'gtc', qty: bought.toFixed(9).replace(/0+$/, ''), stop_price: '79800.00', limit_price: '79002.00' });
    expect(t.out).toEqual([`Order order-1: filled, ${bought} filled at $84,000.`, `Its standing exit rests at Alpaca: order order-2, a sale of ${bought} BTC/USD, stop $79,800, limit $79,002.`, 'The intent is filled.']);
    // Resting, it is read as it is; filled, it closes the intent.
    t.out.length = 0;
    expect(await intentCommand(t, [id, 'refresh'], AT)).toBe(0);
    expect(t.out).toEqual(['Order order-1: filled, as before.', 'Its standing exit, order order-2: accepted, as before.']);
    orders.set('order-2', { ...orders.get('order-2')!, status: 'filled', filled_qty: String(bought), filled_avg_price: '79500' });
    t.out.length = 0;
    expect(await intentCommand(t, [id, 'refresh'], AT)).toBe(0);
    expect(t.out.slice(-2)).toEqual(['The position it opened is closed.', 'The intent is closed.']);
    const record = readIntent(folder, AT);
    expect(record.close).toMatchObject({ state: 'closed', reason: `its standing exit filled: ${bought} at $79,500` });
    expect(record.orders.map((o) => `${o.leg ?? 'entry'} ${o.status}`)).toEqual(['entry accepted', 'entry filled', 'exit accepted', 'exit filled']);
    // No second yes was asked for the exit.
    expect(t.asked.filter((a) => a.q.startsWith('Place this paper order?'))).toHaveLength(1);
  });

  it("sells what is held after Alpaca's fee, not what the purchase filled", async () => {
    const { t, id } = await withStop(['yes']);
    expect(await intentCommand(t, [id, 'place'], AT)).toBe(0);
    // Alpaca keeps its fee, 0.25% of the fill, out of what is held.
    const after = Number(((50_000 / PRICE) * 0.9975).toFixed(9));
    held = [{ symbol: 'BTCUSD', qty: String(after), market_value: String(after * PRICE) }];
    waitFill = true;
    t.out.length = 0;
    expect(await intentCommand(t, [id, 'refresh'], AT)).toBe(0);
    expect(JSON.parse(posts[1]!)).toMatchObject({ symbol: 'BTC/USD', side: 'sell', type: 'stop_limit', qty: String(after) });
    expect(t.out[1]).toBe(`Its standing exit rests at Alpaca: order order-2, a sale of ${after} BTC/USD, stop $79,800, limit $79,002.`);
  });

  it('is never placed in a dry run, where the buy is only shown', async () => {
    const dry = await withStop([]);
    config('dry_run', '{ max_notional: 60000, max_position_share: 0.6, symbols: [BTC/USD], max_orders_per_day: 5 }');
    expect(await intentCommand(dry.t, [dry.id, 'place'], AT)).toBe(0);
    expect(posts).toEqual([]);
    expect(readdirSync(dry.folder)).toEqual(['intent.json']);
  });

  it('takes back a resting exit and leaves the position open', async () => {
    const { t, id, folder } = await withStop(['yes']);
    expect(await intentCommand(t, [id, 'place'], AT)).toBe(0);
    waitFill = true;
    expect(await intentCommand(t, [id, 'refresh'], AT)).toBe(0);
    t.out.length = 0;
    expect(await intentCommand(t, [id, 'cancel'], AT)).toBe(0);
    expect(t.out).toEqual(['Its standing exit was cancelled at Alpaca. The position stays open, with nothing resting for it.']);
    expect(readIntent(folder, AT).state).toBe('filled');
    expect(await intentCommand(t, [id, 'cancel'], AT)).toBe(1);
    expect(t.errors.at(-1)).toBe('Its order has filled, so there is nothing to cancel. A new intent sells what is held.');
  });

  it('exports the intents of the days asked into a new folder, as one CSV and a folder each with its page, and changes nothing in the journal', async () => {
    const { t, id, folder } = await withStop(['yes']);
    expect(await intentCommand(t, [id, 'place'], AT)).toBe(0);
    waitFill = true;
    expect(await intentCommand(t, [id, 'refresh'], AT)).toBe(0);
    const out = join(mkdtempSync(join(tmpdir(), 'pk-out-')), 'audit');
    const flags = (f: Record<string, string>) => (name: string) => f[name];
    t.out.length = 0;
    expect(await intentCommand(t, ['export'], AT, flags({ '--from': '2026-10-11', '--to': '2026-10-11', '--out': out }))).toBe(0);
    expect(t.out[0]).toBe(`Exported one order intent drafted from 2026-10-11 to 2026-10-11 into ${out}:`);
    expect(readdirSync(out).sort()).toEqual([id, 'intents-2026-10-11-to-2026-10-11.csv']);
    const csv = readFileSync(join(out, 'intents-2026-10-11-to-2026-10-11.csv'), 'utf8').split('\r\n');
    expect(csv).toHaveLength(3);
    expect(csv[1]).toMatch(new RegExp(`^${id},2026-10-11T10:00:00.000Z,filled,routine wf,`));
    expect(readdirSync(join(out, id)).sort()).toEqual(['approval.json', 'checks.final.json', 'checks.json', 'intent.json', 'orders.jsonl', 'render.md']);
    expect(readFileSync(join(out, id, 'render.md'), 'utf8')).toContain('## The standing exit at the broker');
    // The journal is as it was: an open intent has no page there yet.
    expect(existsSync(join(folder, 'render.md'))).toBe(false);
    // Never into a folder that holds anything, never with days it cannot read.
    expect(await intentCommand(t, ['export'], AT, flags({ '--from': '2026-10-11', '--to': '2026-10-11', '--out': out }))).toBe(1);
    expect(t.errors.at(-1)).toBe(`${out} is not empty, and an export writes only into a new or empty folder, so nothing was written.`);
    expect(await intentCommand(t, ['export'], AT, flags({ '--from': '2026-10-12', '--to': '2026-10-11', '--out': out }))).toBe(1);
    expect(await intentCommand(t, ['export'], AT, flags({ '--from': '2026-10-11', '--to': '2026-10-11' }))).toBe(1);
    expect(t.errors.at(-1)).toMatch(/^primerkit intent export --from <YYYY-MM-DD> --to <YYYY-MM-DD> --out <folder>/);
    expect(await intentCommand(t, ['export'], AT, flags({ '--from': '2026-10-01', '--to': '2026-10-02', '--out': join(out, 'none') }))).toBe(0);
    expect(t.out.at(-1)).toBe('No order intents were drafted from 2026-10-01 to 2026-10-02. Nothing was written.');
    expect(existsSync(join(out, 'none'))).toBe(false);
  });
});
