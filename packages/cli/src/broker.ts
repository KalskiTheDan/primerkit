import { join } from 'node:path';
import { AlpacaBroker, BrokerLog, capsProblems, CRYPTO_FEE_SHARE, heldAs, modeProblem, OrderGuard, osKeychain, type BrokerMode, type Caps, type Keychain, type OrderBody } from '@primerkit/brokers';
import { IntentFolder, Journal, configPath, draftFromRoutine, intentTitle, primerkitHome, readConfig, readForward, runRecord, writeConfig, type Routine } from '@primerkit/core';
import { DISCLAIMER_POINTS, journalFind } from '@primerkit/session';

// Alpaca from the command line: connect with paper keys kept in the keychain, read the
// account, and run one order through the guard. Paper only; a dry run unless --paper,
// and a paper order only on a yes typed at a terminal.

const KEY_ID = 'alpaca-paper-key-id';
const SECRET = 'alpaca-paper-secret';

export interface Io {
  print(lines: string[]): void;
  fail(message: string): number;
  ask(question: string, hidden?: boolean): Promise<string>;
  terminal: boolean; // the input and the output are both a terminal
  mark?: string[]; // primerkit's mark and name as this terminal draws them, atop a connect screen
  keychain?: Keychain;
  base?: string; // a fake Alpaca for tests
  fetch?: typeof fetch; // the calls as they are made, for tests
}

// A connect screen opens with primerkit's own mark, as --version draws it. The broker is
// named in plain words below it: no broker's logo, wordmark or colours, which could read as
// a partnership the broker never agreed to.
export const marked = (io: Io, lines: string[]): string[] => (io.mark?.length ? [...io.mark, '', ...lines] : lines);

// The keys, a yes for an order and turning a stopped connection back on are asked only at
// a terminal: where the input or the output is a pipe or a file, nothing is asked and
// nothing goes. A terminal is all the code can see. A program can make one of its own.
const noTerminal = (lead: string) => `${lead} at a terminal, and this run has none: its input or its output is a pipe or a file. Run it in a terminal yourself.`;

export const logOf = (home: string) => new BrokerLog(join(home, 'broker', 'alpaca.jsonl'));
const CONTROL = /[\u0000-\u001f\u007f]/;

// The person's caps as config.yaml gives them, the two optional ones only where given. What
// cannot be used is left as it was written, for capsProblems to name.
export function capsOf(home: string): Caps | null {
  const c = readConfig(home).brokers?.alpaca?.caps;
  if (!c) return null;
  const groups = c.groups as unknown;
  return {
    maxNotional: c.max_notional,
    maxPositionShare: c.max_position_share,
    symbols: c.symbols,
    maxOrdersPerDay: c.max_orders_per_day,
    ...(c.max_exposure_share !== undefined ? { maxExposureShare: c.max_exposure_share } : {}),
    ...(groups !== undefined ? { groups: (Array.isArray(groups) ? groups.map((g: { name?: unknown; symbols?: unknown; max_share?: unknown } | null) => ({ name: g?.name, symbols: g?.symbols, maxShare: g?.max_share })) : groups) as Caps['groups'] } : {}),
  };
}

export async function brokerFrom(io: Io): Promise<AlpacaBroker | null> {
  const kc = io.keychain ?? osKeychain();
  const [keyId, secret] = [await kc.get(KEY_ID), await kc.get(SECRET)];
  return keyId && secret ? new AlpacaBroker({ keyId, secret, ...(io.base ? { base: io.base } : {}), ...(io.fetch ? { fetch: io.fetch } : {}) }) : null;
}

const dollars = (n: number) => `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
// A quantity to Alpaca's nine decimals, never "2.95e-7".
const ninths = (n: number) => n.toFixed(9).replace(/\.?0+$/, '');
// What a crypto purchase left short of the log's record: Alpaca's fee, or more than it.
const shortWords = (short: { by: number; withinFee: boolean }) => `the ${ninths(short.by)} less is ${short.withinFee ? 'within' : 'more than'} Alpaca's fee on a crypto purchase (up to ${Number((CRYPTO_FEE_SHARE * 100).toFixed(2))}%, taken in the coin)`;

export async function connectAlpaca(io: Io, remove: boolean): Promise<number> {
  const kc = io.keychain ?? osKeychain();
  const home = primerkitHome();
  if (remove) {
    const config = readConfig(home);
    writeConfig(home, { ...config, brokers: { ...config.brokers, alpaca: { ...config.brokers?.alpaca, mode: 'off' } } });
    // "No keys were kept" is said only when the keychain itself says so, before and after.
    try {
      const before = [await kc.get(KEY_ID), await kc.get(SECRET)];
      await kc.remove(KEY_ID);
      await kc.remove(SECRET);
      const after = [await kc.get(KEY_ID), await kc.get(SECRET)];
      if (after.some((v) => v !== null)) throw new Error('an entry is still there after it was removed');
      io.print(marked(io, [before.some((v) => v !== null) ? 'The Alpaca keys are out of the keychain, and the connection is off.' : 'No Alpaca keys were kept. The connection is off.']));
      return 0;
    } catch (error) {
      return io.fail(`The connection is off, but the Alpaca keys could not be taken out of the keychain and may still be kept: ${(error as Error).message}. Try again, or remove the entries primerkit/${KEY_ID} and primerkit/${SECRET} in your system's keychain by hand.`);
    }
  }
  if (!io.terminal) return io.fail(noTerminal('The keys are typed'));
  io.print(marked(io, [
    'Alpaca paper trading. Make paper keys in your Alpaca dashboard; they place no real orders.',
    'The keys are kept in this machine\'s keychain and sent only to Alpaca. Type them here: primerkit takes',
    'them from nowhere else, and never from an environment variable.',
    '',
    ...DISCLAIMER_POINTS.map((point) => `  ${point.join(' ')}`),
    '',
  ]));
  const keyId = (await io.ask('Paper key id: ')).trim();
  const secret = (await io.ask('Paper secret: ', true)).trim();
  if (!keyId || !secret) return io.fail('Nothing was kept: both the key id and the secret are needed.');
  if (CONTROL.test(keyId) || CONTROL.test(secret)) return io.fail('Nothing was kept: a key cannot hold a control character.');
  const broker = new AlpacaBroker({ keyId, secret, ...(io.base ? { base: io.base } : {}), ...(io.fetch ? { fetch: io.fetch } : {}) });
  let summary: string;
  try {
    const a = await broker.account();
    summary = `account ${a.number.replace(/.(?=.{4})/g, '*')}, ${a.status}, equity ${dollars(a.equity)}`;
  } catch (error) {
    return io.fail(`Nothing was kept: ${(error as Error).message}`);
  }
  await kc.set(KEY_ID, keyId);
  await kc.set(SECRET, secret);
  const config = readConfig(home);
  const before: unknown = config.brokers?.alpaca?.mode;
  const mode: BrokerMode = before === 'read' || before === 'dry_run' || before === 'paper' ? before : 'dry_run';
  writeConfig(home, { ...config, brokers: { ...config.brokers, alpaca: { ...config.brokers?.alpaca, mode } } });
  io.print([`Connected to Alpaca paper: ${summary}.`, `Mode: ${mode}. Orders are dry runs until you set mode: paper and your caps in config.yaml.`]);
  return 0;
}

// The broker's mode as config.yaml gives it: only the four names are modes, and any other
// value is refused by name, never read as paper.
export function modeOf(home: string): { mode: BrokerMode; wrong: string | null } {
  const given: unknown = readConfig(home).brokers?.alpaca?.mode;
  const wrong = given === undefined ? null : modeProblem(given);
  return { mode: given === undefined || wrong ? 'off' : (given as BrokerMode), wrong };
}

// An order intent from a routine's newest label, sized on the paper account as it stands:
// drafted and kept in the journal, and nothing sent. Only the account is read from Alpaca.
export async function routineIntent(io: Io, routine: Routine, now = new Date()): Promise<number> {
  const home = primerkitHome();
  const name = routine.spec.name;
  const entry = readForward(routine).at(-1);
  if (!entry) return io.fail(`${name} has no label yet to draft an intent from: primerkit routine ${name} track runs it once.`);
  const { mode, wrong } = modeOf(home);
  if (wrong) return io.fail(`Your broker settings in config.yaml cannot be used, so nothing is read from Alpaca: ${wrong}.`);
  if (mode === 'off') return io.fail(`Alpaca paper, mode off: nothing is read from Alpaca. An intent is sized on the paper account's own figures: primerkit connect alpaca, or set brokers.alpaca.mode to read, dry_run or paper in ${configPath(home)}.`);
  let broker: AlpacaBroker | null;
  try {
    broker = await brokerFrom(io);
  } catch (error) {
    return io.fail(`The keychain could not be read, so nothing was done: ${(error as Error).message}`);
  }
  if (!broker) return io.fail('Alpaca is not connected: primerkit connect alpaca');
  let account: { equity: number; heldQty: number; heldValue: number };
  try {
    const [a, positions] = await Promise.all([broker.account(), broker.positions()]);
    const held = positions.find((p) => heldAs(p.symbol) === heldAs(routine.spec.symbol));
    account = { equity: a.equity, heldQty: held?.qty ?? 0, heldValue: held?.marketValue ?? 0 };
  } catch (error) {
    return io.fail(`The paper account could not be read, so no intent was drafted: ${(error as Error).message}`);
  }
  const root = join(home, 'journal');
  const dir = journalFind(root, entry.runId);
  const drafted = draftFromRoutine({ routine, entry, run: dir ? runRecord(dir) : null, account, now, venue: broker.id });
  if (drafted.kind === 'none') {
    io.print([`No intent was drafted: ${drafted.why}.`]);
    return 0;
  }
  const { intent, sized } = drafted;
  const folder = IntentFolder.draft(new Journal(root), intent);
  const cited = intent.provenance.cited.length;
  io.print([
    `Drafted an order intent from ${name}'s label ${entry.label}, given at ${entry.at.slice(0, 16).replace('T', ' ')} UTC:`,
    `  ${intentTitle(intent)}`,
    sized.kind === 'order' ? `  On the paper account now: ${sized.says}.` : '',
    `  It cites ${cited === 1 ? 'one line' : `${cited} lines`} of its run, ${entry.runId}.`,
    'Your rules and your model decided; PreReason supplied data.',
    `It is a draft, kept in ${folder.dir}. Nothing is sent: an order goes only after its checks and your yes, typed at a terminal. It expires at ${intent.expires_at.slice(11, 16)} UTC.`,
  ].filter(Boolean));
  return 0;
}

const USAGE = 'primerkit broker order <symbol> buy --notional <dollars> [--paper], or sell --notional <dollars> | --qty <quantity> [--paper]';

export async function brokerCommand(io: Io, args: { sub: string | undefined; rest: string[]; flag: (name: string) => string | undefined; has: (name: string) => boolean }): Promise<number> {
  const home = primerkitHome();
  const config = readConfig(home);
  const log = logOf(home);
  // Only the four names are modes. Any other value is refused by name, never read as paper.
  const given: unknown = config.brokers?.alpaca?.mode;
  const wrongMode = given === undefined ? null : modeProblem(given);
  const mode: BrokerMode = given === undefined || wrongMode ? 'off' : (given as BrokerMode);
  const caps = capsOf(home);
  // The connection off by hand, from anywhere and at once: no order goes, a dry run included,
  // until broker enable, which asks a yes at a terminal.
  if (args.sub === 'disable') {
    const off = log.disabled();
    if (off) return io.fail(`The connection is already off: ${off}.`);
    log.append({ event: 'disabled', reason: 'turned off by hand with primerkit broker disable' });
    io.print(['The connection is off: no order goes, a dry run included, until primerkit broker enable, which asks your yes at a terminal.', `A file named STOP at ${log.stopPath} does the same, for as long as it is there.`]);
    return 0;
  }
  if (args.sub === 'enable') {
    const off = log.disabled();
    if (!off) return io.fail('The connection is not off.');
    if (!io.terminal) return io.fail(noTerminal('Turning the connection back on is asked of you'));
    const pending = log.pending();
    if (pending.length) return io.fail(`An order primerkit sent has no outcome on record (${pending.map((e) => e.body.client_order_id).join(', ')}). Run primerkit broker reconcile first: it asks Alpaca for it.`);
    io.print([`The connection is off: ${off}.`, 'Turning it back on takes what Alpaca holds now as where the record starts again, so look at the account first.']);
    if ((await io.ask('Turn the connection back on? Type yes to turn it on: ')).trim().toLowerCase() !== 'yes') {
      io.print(['It stays off.']);
      return 0;
    }
    log.append({ event: 'enabled' });
    io.print(['The connection is back on. Its log keeps the stop that turned it off.', 'What Alpaca holds now is where the record starts again: holdings are compared from your next order on.']);
    return 0;
  }
  if (args.sub && !['status', 'reconcile', 'order'].includes(args.sub)) return io.fail('primerkit broker, broker order, broker reconcile, broker disable or broker enable.');
  if (wrongMode) return io.fail(`Your broker settings in config.yaml cannot be used, so nothing is read from Alpaca and nothing is sent: ${wrongMode}.`);
  // Off is off: with the keys still in the keychain, nothing is read and nothing is sent.
  if (mode === 'off') {
    const said = `Alpaca paper, mode off: nothing is read from Alpaca and nothing is sent. To use it, primerkit connect alpaca, or set brokers.alpaca.mode to read, dry_run or paper in ${configPath(home)}.`;
    if (!args.sub || args.sub === 'status') {
      io.print([said]);
      return 0;
    }
    return io.fail(said);
  }
  let intent: { symbol: string; side: 'buy' | 'sell'; notional?: number; qty?: number } | null = null;
  const paper = args.has('--paper');
  if (args.sub === 'order') {
    const [symbol, side] = args.rest;
    if (!symbol || (side !== 'buy' && side !== 'sell')) return io.fail(USAGE);
    if (args.flag('--price') !== undefined) return io.fail(`--price is not taken: a buy is sized in dollars, and a sale by quantity is valued at Alpaca's own figures. ${USAGE}`);
    const notional = Number(args.flag('--notional') ?? NaN);
    const qty = Number(args.flag('--qty') ?? NaN);
    intent = { symbol: symbol.toUpperCase(), side, ...(Number.isFinite(notional) ? { notional } : {}), ...(Number.isFinite(qty) ? { qty } : {}) };
    // Checked before the keychain is read: a run with no terminal never gets as far as the keys.
    if (paper && mode === 'paper' && !io.terminal) return io.fail(`${noTerminal('The yes for a paper order is typed')} A dry run, without --paper, runs anywhere.`);
  }
  let broker: AlpacaBroker | null;
  try {
    broker = await brokerFrom(io);
  } catch (error) {
    return io.fail(`The keychain could not be read, so nothing was done: ${(error as Error).message}`);
  }
  if (!broker) return io.fail('Alpaca is not connected: primerkit connect alpaca');
  const guard = new OrderGuard({ broker, mode, caps, log });
  if (!args.sub || args.sub === 'status') {
    const [a, positions] = await Promise.all([broker.account(), broker.positions()]);
    const today = new Date().toISOString().slice(0, 10);
    io.print([
      `Alpaca paper, mode ${mode}${log.disabled() ? `, off since: ${log.disabled()}` : ''}${log.killSwitch() ? `, and the kill switch is on (${log.killSwitch()})` : ''}`,
      `Account ${a.number.replace(/.(?=.{4})/g, '*')}, ${a.status}: equity ${dollars(a.equity)}, cash ${dollars(a.cash)}, buying power ${dollars(a.buyingPower)}`,
      positions.length ? `Holding: ${positions.map((p) => `${p.qty} ${p.symbol} (${dollars(p.marketValue)})`).join(', ')}` : 'Holding nothing.',
      !caps
        ? 'No caps are set, so no order will be placed.'
        : capsProblems(caps).length
          ? `Your caps in config.yaml cannot be used, so no order will be placed: ${capsProblems(caps).join('; ')}.`
          : `Your caps: ${dollars(caps.maxNotional)} an order, ${(caps.maxPositionShare * 100).toFixed(1)}% of equity a symbol, ${caps.maxOrdersPerDay} orders a day, on ${caps.symbols.join(', ')}`,
      `Orders sent today, by UTC days: ${log.sentOn(today)}.`,
    ]);
    return 0;
  }
  if (args.sub === 'reconcile') {
    const { drift, waiting, resolved = [], busy } = await guard.reconcile();
    io.print([
      ...(busy ? ['An order is going through in another run right now, so the orders with no outcome on record were left alone. Run primerkit broker reconcile again when it is done.', `Where no order is running, a run ended without taking its lock away (${log.lockPath}), and the lock clears itself five minutes after it was made.`] : []),
      ...resolved.map((r) => `${r.clientOrderId}: ${r.taken ? 'Alpaca holds this order, so the log now says it was placed' : 'Alpaca holds no such order, so the log now says it was not taken'}`),
      ...(drift.length || waiting.length || resolved.length || busy ? [] : ['The log has placed no orders to compare.']),
      ...drift.map((d) => `${d.symbol}: the log expects ${d.expected}, Alpaca holds ${d.held}${d.short ? `: ${shortWords(d.short)}` : ''}`),
      ...waiting.map((symbol) => `${symbol}: its last order, in dollars, has not settled at Alpaca, so it is compared once it has`),
    ]);
    if (log.disabled()) io.print([`The connection is off: ${log.disabled()}.`]);
    return 0;
  }
  if (!intent) return io.fail(USAGE);
  // The symbol as Alpaca's asset list holds it, so its class is read and never guessed:
  // BTCUSD, with no slash, goes as the crypto pair BTC/USD, not as a stock order.
  let asset;
  try {
    asset = await broker.asset(intent.symbol);
  } catch (error) {
    return io.fail(`Alpaca's asset list could not be read, so nothing was sent: ${(error as Error).message}`);
  }
  if (!asset) return io.fail(`${intent.symbol} is not in Alpaca's asset list, so nothing was sent.`);
  if (asset.assetClass !== 'crypto' && asset.assetClass !== 'us_equity') return io.fail(`${asset.symbol} is ${asset.assetClass}, and primerkit trades crypto and US stocks only.`);
  intent = { ...intent, symbol: asset.symbol };
  const run = new OrderGuard({ broker, mode: paper ? mode : 'dry_run', caps, log });
  const result = await run.submit(intent, async (body: OrderBody) => {
    if (!io.terminal) return false;
    io.print(['The order, exactly as it goes to Alpaca paper:', JSON.stringify(body, null, 2)]);
    return (await io.ask('Place this paper order? Type yes to place it: ')).trim().toLowerCase() === 'yes';
  });
  if (result.outcome === 'refused') return io.fail(['Not placed:', ...result.checked.refused.map((r) => `  ${r}`)].join('\n'));
  if (result.outcome === 'dry_run') io.print(['A dry run: nothing was sent. The order as it would go to Alpaca:', JSON.stringify(result.checked.body, null, 2), paper ? 'Set mode: paper in config.yaml to place paper orders.' : 'Add --paper to place it on paper, after a yes.']);
  if (result.outcome === 'declined') io.print(['Not placed.']);
  if (result.outcome === 'placed') io.print([`Placed on paper: order ${result.order?.id}, ${result.order?.status}.`]);
  if (result.outcome === 'failed') return io.fail(`Alpaca did not take it: ${result.error}.${log.disabled() ? ` The connection is off: ${log.disabled()}.` : ''}`);
  if (result.outcome === 'unknown') return io.fail(`The order was sent, and no readable answer came back (${result.error}), so Alpaca may hold it. The connection is off. primerkit broker reconcile asks Alpaca for the order by its id (${result.checked.body?.client_order_id}); then primerkit broker enable turns it back on.`);
  return 0;
}
