import { cpSync, existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { userInfo } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { BrokerLog, capsProblems, heldAs, OrderGuard, type AlpacaBroker, type Asset, type BrokerMode, type Caps, type OrderBody } from '@primerkit/brokers';
import { checksPassed, closeIntent, entryLines, exitLines, exitOrder, exitWords, IntentFolder, intentChecks, intentDirs, intentsCsv, intentTitle, isDate, primerkitHome, readIntent, renderIntent, type IntentChecks, type IntentOrderLine, type IntentRecord, type RiskCheck } from '@primerkit/core';
import { journalFind, journalRows } from '@primerkit/session';
import { brokerFrom, capsOf, logOf, modeOf, type Io } from './broker';

// Order intents from the command line: the list, one intent with where it came from, its
// pre-trade checks, and its placing on paper after the person's yes. Checking reads the paper
// account and Alpaca's asset list and writes nothing. Placing writes each step to the
// intent's folder: the checks shown, the yes, the checks run again after it, and each answer
// from Alpaca. Your rules and your model decided; PreReason supplied data.

const ID = /^\d{8}T\d{6}Z-[0-9a-f]{6}$/;
const USAGE = 'primerkit intent, primerkit intent <id> [check | place | refresh | cancel], or primerkit intent export --from <day> --to <day> --out <folder>';
const DECIDED = 'Your rules and your model decided; PreReason supplied data.';
const noTerminal = (lead: string) => `${lead} at a terminal, and this run has none: its input or its output is a pipe or a file. Run it in a terminal yourself.`;

function find(root: string, id: string): string | null {
  if (!ID.test(id)) return null;
  const dir = journalFind(root, id);
  return dir && basename(dirname(dir)) === 'intent' ? dir : null;
}

// What PreReason's catalogue marks as measuring a futures, swap or options market, and every
// id it lists, or null where it cannot be read. The checks ask for it only for a PreReason
// publication trigger.
export type Marks = () => Promise<{ marked: ReadonlySet<string>; listed: ReadonlySet<string> } | null>;

// now: a time for tests, or the clock; the checks after a yes read the clock again, since a
// person may take a while to answer.
export async function intentCommand(io: Io, rest: string[], now: Date | (() => Date) = () => new Date(), flag: (name: string) => string | undefined = () => undefined, marks: Marks = async () => null): Promise<number> {
  const clock = typeof now === 'function' ? now : () => now;
  const home = primerkitHome();
  const root = join(home, 'journal');
  const [id, sub] = rest;
  if (id === 'export') return exportIntents(io, root, flag, clock);
  if (!id) {
    const rows = journalRows(root, 1000, clock()).filter((r) => r.operation === 'intent');
    io.print(rows.length ? ['Your order intents, newest first:', ...rows.map((r) => `  ${basename(r.dir)}  ${(r.outcome || 'unread').padEnd(16)} ${r.title}`), '', 'primerkit intent <id> shows one.'] : ['No order intents yet. primerkit routine <name> intent drafts one from a routine\'s label.']);
    return 0;
  }
  const dir = find(root, id);
  if (!dir) return io.fail(`There is no order intent ${id} in the journal. primerkit intent lists them.`);
  let record: IntentRecord;
  try {
    record = readIntent(dir, clock());
  } catch (error) {
    return io.fail(`The intent ${id} could not be read: ${(error as Error).message}`);
  }
  if (!sub) {
    io.print(intentPage(record));
    return 0;
  }
  if (sub === 'check') return check(io, home, record, clock, marks);
  if (sub === 'place') return place(io, home, record, clock, marks);
  if (sub === 'refresh') return refresh(io, home, record, clock);
  if (sub === 'cancel') return cancel(io, home, record, clock);
  return io.fail(USAGE);
}

// The intents drafted from one day to another, written where the person says: one CSV, and a
// copy of each intent's folder with its page. Only into a new or empty folder; nothing in the
// journal changes, and nothing leaves the machine.
function exportIntents(io: Io, root: string, flag: (name: string) => string | undefined, clock: () => Date): number {
  const [from, to, out] = [flag('--from'), flag('--to'), flag('--out')];
  if (!from || !to || !isDate(from) || !isDate(to) || from > to || !out) return io.fail('primerkit intent export --from <YYYY-MM-DD> --to <YYYY-MM-DD> --out <folder>: the days the intents were drafted, both kept, and a new or empty folder to write to.');
  const dirs = intentDirs(root, from, to);
  if (!dirs.length) {
    io.print([`No order intents were drafted from ${from} to ${to}. Nothing was written.`]);
    return 0;
  }
  const target = resolve(out);
  if (existsSync(target) && readdirSync(target).length) return io.fail(`${target} is not empty, and an export writes only into a new or empty folder, so nothing was written.`);
  mkdirSync(target, { recursive: true });
  const records = dirs.map((d) => readIntent(d, clock()));
  const csv = `intents-${from}-to-${to}.csv`;
  writeFileSync(join(target, csv), intentsCsv(records), { flag: 'wx' });
  for (const r of records) {
    const copy = join(target, r.intent.intent_id);
    cpSync(r.dir, copy, { recursive: true, errorOnExist: true, force: false });
    if (!existsSync(join(copy, 'render.md'))) writeFileSync(join(copy, 'render.md'), renderIntent(r), { flag: 'wx' });
  }
  io.print([
    `Exported ${records.length === 1 ? 'one order intent' : `${records.length} order intents`} drafted from ${from} to ${to} into ${target}:`,
    `  ${csv}, a row for each`,
    '  a folder for each, as the journal keeps it, with render.md, its page read top to bottom',
    'Nothing in the journal was changed, and nothing left this machine.',
  ]);
  return 0;
}

function intentPage(r: IntentRecord): string[] {
  const i = r.intent;
  const p = i.provenance;
  const source = i.source.kind === 'routine' ? `the routine ${i.source.routine}'s label, given at ${i.source.tick}` : i.source.kind === 'ask' ? `the answer of run ${i.source.run_id}` : i.source.kind === 'webhook' ? `the webhook ${i.source.name}` : 'typed by hand';
  return [
    `${intentTitle(i)}: ${r.state}`,
    `  From ${source}. Drafted ${i.created_at}; it expires ${i.expires_at}.`,
    `  Thesis: ${p.thesis}`,
    `  Its run ${p.run_id ?? 'none'}, on ${p.model ?? 'no model'}, with data as of ${p.data_as_of ?? 'unknown'}. It cites ${p.cited.length === 1 ? 'one line' : `${p.cited.length} lines`}${p.cited.length ? `: ${p.cited.map((c) => `${c.block} line ${c.line}`).join(', ')}` : ''}.`,
    `  Its checks then: ${p.checks_passed.length ? p.checks_passed.map((c) => `${c.check} ${c.passed ? 'passed' : 'failed'}`).join(', ') : 'none kept'}.`,
    ...(r.approval ? [`  Your yes: ${r.approval.at}, typed by ${r.approval.user}.`] : []),
    ...r.orders.map((o) => `  ${o.leg === 'exit' ? 'Its standing exit at Alpaca' : 'Alpaca'}: ${o.status}${o.broker_order_id ? `, order ${o.broker_order_id}` : ''}${o.filled_qty ? `, ${o.filled_qty} filled${o.filled_avg_price ? ` at $${o.filled_avg_price.toLocaleString('en-US')}` : ''}` : ''}, ${o.at}${o.note ? `: ${o.note}` : ''}`),
    ...(r.close ? [`  Closed ${r.close.state}, ${r.close.at}: ${r.close.reason}`] : []),
    DECIDED,
    `Kept in ${r.dir}. primerkit intent ${i.intent_id} check runs its pre-trade checks.`,
  ];
}

interface Connected {
  mode: BrokerMode;
  broker: AlpacaBroker;
  log: BrokerLog;
  caps: Caps | null;
  marks: Marks;
}

// The broker as config.yaml and the keychain give it, or the reason there is none.
async function connect(io: Io, home: string, what: string, marks: Marks = async () => null): Promise<Connected | number> {
  const { mode, wrong } = modeOf(home);
  if (wrong) return io.fail(`Your broker settings in config.yaml cannot be used, so nothing is read from Alpaca: ${wrong}.`);
  if (mode === 'off') return io.fail(`Alpaca paper, mode off: nothing is read from Alpaca, so ${what}. primerkit connect alpaca, or set brokers.alpaca.mode in config.yaml.`);
  let broker: AlpacaBroker | null;
  try {
    broker = await brokerFrom(io);
  } catch (error) {
    return io.fail(`The keychain could not be read, so nothing was done: ${(error as Error).message}`);
  }
  if (!broker) return io.fail('Alpaca is not connected: primerkit connect alpaca');
  return { mode, broker, log: logOf(home), caps: capsOf(home), marks };
}

// The account, its positions and the symbol's asset, read from Alpaca, and the checks on them.
// For a PreReason publication trigger, what PreReason's catalogue marks is read too; nothing
// else leaves for anywhere but the paper address.
async function checksNow(c: Connected, record: IntentRecord, now: Date, afterYes = false): Promise<{ result: IntentChecks & { sized: ReturnType<typeof intentChecks>['sized'] }; asset: Asset | null }> {
  const entry = record.intent.entry;
  const event = entry.kind === 'trigger' && entry.condition.kind === 'prereason_event';
  const [a, positions, asset, derivatives] = await Promise.all([c.broker.account(), c.broker.positions(), c.broker.asset(record.intent.instrument.symbol), event ? c.marks().catch(() => null) : Promise.resolve(null)]);
  const result = intentChecks({
    derivatives,
    record,
    now,
    connection: { mode: c.mode, off: c.log.disabled(), killSwitch: c.log.killSwitch(), pending: c.log.pending().map((e) => e.body.client_order_id) },
    account: { status: a.status, equity: a.equity, positions },
    asset,
    caps: c.caps,
    capsProblems: c.caps ? capsProblems(c.caps) : [],
    sentToday: c.log.sentOn(now.toISOString().slice(0, 10)),
    heldAs,
    afterYes,
  });
  return { result, asset };
}

const checkLines = (checks: RiskCheck[]): string[] => checks.map((c) => `  ${c.passed ? 'ok' : 'x '} ${c.check.padEnd(16)} ${c.message}`);
const kept = (r: IntentChecks): IntentChecks => ({ at: r.at, computed: r.computed, checks: r.checks });

async function check(io: Io, home: string, record: IntentRecord, clock: () => Date, marks: Marks): Promise<number> {
  const c = await connect(io, home, 'the checks cannot run', marks);
  if (typeof c === 'number') return c;
  let result;
  try {
    ({ result } = await checksNow(c, record, clock()));
  } catch (error) {
    return io.fail(`The paper account could not be read, so the checks did not run: ${(error as Error).message}`);
  }
  const failed = result.checks.filter((x) => !x.passed);
  io.print([
    `The pre-trade checks of ${intentTitle(record.intent)}:`,
    ...checkLines(result.checks),
    '',
    checksPassed(result) ? `All ${result.checks.length} checks pass.` : `${failed.length} of ${result.checks.length} checks fail, so it would not go.`,
    DECIDED,
    "Nothing was written and nothing was sent. Before an order goes, every check runs again, and the broker's record is compared with what Alpaca holds.",
  ]);
  return 0;
}

// The terminal the yes was typed at, as the environment names it; never more than a name.
const terminalName = (): string => (process.env.WT_SESSION ? 'Windows Terminal' : (process.env.TERM_PROGRAM ?? process.env.TERM ?? 'a terminal'));

// The intent placed on paper: its checks pass, the order is shown exactly as it goes, and it
// goes only on a yes typed at a terminal. After the yes every check runs again, and the guard
// sends it: one order at a time, logged before it is sent, under the stops.
async function place(io: Io, home: string, record: IntentRecord, clock: () => Date, marks: Marks): Promise<number> {
  const { mode } = modeOf(home);
  if (mode === 'paper' && !io.terminal) return io.fail(noTerminal('The yes for a paper order is typed'));
  const c = await connect(io, home, 'nothing can be placed', marks);
  if (typeof c === 'number') return c;
  let first;
  try {
    first = await checksNow(c, record, clock());
  } catch (error) {
    return io.fail(`The paper account could not be read, so nothing was placed: ${(error as Error).message}`);
  }
  const { result, asset } = first;
  const sized = result.sized;
  if (!checksPassed(result) || sized?.kind !== 'order' || !asset) {
    return io.fail([`Not placed: ${result.checks.filter((x) => !x.passed).length} of ${result.checks.length} checks fail.`, ...checkLines(result.checks.filter((x) => !x.passed))].join('\n'));
  }
  const folder = IntentFolder.at(record.dir);
  const order = { symbol: asset.symbol, side: sized.side, ...(sized.notional !== null ? { notional: sized.notional } : { qty: sized.quantity! }) };
  const guard = new OrderGuard({ broker: c.broker, mode: c.mode, caps: c.caps, log: c.log, now: clock });
  let finalFailed: RiskCheck[] | null = null;
  const exits = record.intent.exit ? `Once it fills, ${exitWords(record.intent.exit)} rests at Alpaca paper and sells what it bought, without a second yes. This yes covers it.` : null;
  const outcome = await guard.submit(order, async (body: OrderBody) => {
    io.print([
      `${intentTitle(record.intent)}: all ${result.checks.length} pre-trade checks pass. ${sized.says}.`,
      'The order, exactly as it goes to Alpaca paper:',
      JSON.stringify(body, null, 2),
      ...(exits ? [exits] : []),
      DECIDED,
    ]);
    const typed = (await io.ask('Place this paper order? Type yes to place it: ')).trim();
    if (typed.toLowerCase() !== 'yes') return false;
    const at = clock();
    folder.write('checks.json', kept(result));
    folder.write('approval.json', { user: userInfo().username, at: at.toISOString(), body: body as unknown as Record<string, unknown>, ...(exits ? { exits } : {}), typed, terminal: terminalName() });
    // Every check again, after the yes: the account, the clock and the caps may have moved.
    let again: IntentChecks;
    try {
      again = (await checksNow(c, readIntent(record.dir, at), at, true)).result;
    } catch (error) {
      again = { at: at.toISOString(), computed: result.computed, checks: [{ check: 'account', limit: null, value: null, passed: false, message: `the account could not be read again after the yes: ${(error as Error).message}` }] };
    }
    folder.write('checks.final.json', kept(again));
    if (!checksPassed(again)) {
      finalFailed = again.checks.filter((x) => !x.passed);
      return false;
    }
    return true;
  });
  const now = clock().toISOString();
  const approved = readIntent(record.dir, clock()).approval !== null;
  const reasons = (list: string[]) => list.join('; ');
  if (outcome.outcome === 'dry_run') {
    io.print(['A dry run: nothing was sent, and the intent stays as it was. The order as it would go to Alpaca:', JSON.stringify(outcome.checked.body, null, 2), 'Set mode: paper in config.yaml to place it on paper, after your yes.']);
    return 0;
  }
  if (outcome.outcome === 'declined') {
    if (finalFailed) {
      const failed = finalFailed as RiskCheck[];
      closeIntent(folder, { at: now, state: 'refused', reason: `the checks after the yes failed: ${reasons(failed.map((x) => `${x.check}: ${x.message}`))}` });
      return io.fail(['Not placed: after your yes, a check failed, so the intent is closed as refused.', ...checkLines(failed)].join('\n'));
    }
    io.print(['Not placed. The intent stays as it was.']);
    return 0;
  }
  if (outcome.outcome === 'refused') {
    // Refused by the guard: before the yes, nothing is written; after it, the intent closes.
    if (approved) closeIntent(folder, { at: now, state: 'refused', reason: reasons(outcome.checked.refused) });
    return io.fail(['Not placed:', ...outcome.checked.refused.map((r) => `  ${r}`)].join('\n'));
  }
  const body = outcome.checked.body!;
  if (outcome.outcome === 'placed') {
    folder.appendOrder({ at: now, client_order_id: body.client_order_id, broker_order_id: outcome.order!.id, status: outcome.order!.status, filled_qty: null, filled_avg_price: null });
    io.print([`Placed on paper: order ${outcome.order!.id}, ${outcome.order!.status}.`, `primerkit intent ${record.intent.intent_id} refresh reads its fills.`]);
    return 0;
  }
  if (outcome.outcome === 'failed') {
    folder.appendOrder({ at: now, client_order_id: body.client_order_id, broker_order_id: null, status: 'rejected', filled_qty: 0, filled_avg_price: null, note: outcome.error ?? '' });
    closeIntent(folder, { at: now, state: 'failed', reason: `Alpaca did not take it: ${outcome.error ?? 'no reason given'}` });
    return io.fail(`Alpaca did not take it: ${outcome.error}.${c.log.disabled() ? ` The connection is off: ${c.log.disabled()}.` : ''}`);
  }
  folder.appendOrder({ at: now, client_order_id: body.client_order_id, broker_order_id: null, status: 'unknown', filled_qty: null, filled_avg_price: null, note: outcome.error ?? '' });
  return io.fail(`The order was sent, and no readable answer came back (${outcome.error}), so Alpaca may hold it. The connection is off. primerkit broker reconcile asks Alpaca for the order by its id (${body.client_order_id}); then primerkit broker enable turns it back on.`);
}

// The states after which an order fills no more.
const ENDED = new Set(['filled', 'canceled', 'expired', 'rejected']);
const said = (l: IntentOrderLine): string => `${l.status}${l.filled_qty ? `, ${l.filled_qty} filled${l.filled_avg_price ? ` at $${l.filled_avg_price.toLocaleString('en-US')}` : ''}` : ''}`;

// One order read again at Alpaca, and a line added where it moved.
async function readOrder(c: Connected, folder: IntentFolder, last: IntentOrderLine, at: string): Promise<{ line: IntentOrderLine; moved: boolean }> {
  const state = await c.broker.order(last.broker_order_id!);
  const filled = Number.isFinite(state.filledQty) ? state.filledQty : null;
  // A line written as an order was placed holds no quantity filled, where Alpaca says 0.
  if (state.status === last.status && (filled ?? 0) === (last.filled_qty ?? 0)) return { line: last, moved: false };
  const line: IntentOrderLine = { ...(last.leg ? { leg: last.leg } : {}), at, client_order_id: last.client_order_id, broker_order_id: last.broker_order_id, status: state.status, filled_qty: filled, filled_avg_price: state.filledAvgPrice ?? null, ...(last.note ? { note: last.note } : {}) };
  folder.appendOrder(line);
  return { line, moved: true };
}

// The entry's state at Alpaca, read again; once it has filled, its standing exit placed to rest
// there; and that exit read again, whose fill closes the intent.
async function refresh(io: Io, home: string, record: IntentRecord, clock: () => Date): Promise<number> {
  const entry = entryLines(record.orders).at(-1);
  if (!entry?.broker_order_id) return io.fail(`${intentTitle(record.intent)} has no order at Alpaca to read: it is ${record.state}.`);
  if (record.close) return io.fail(`The intent is closed: ${record.close.state}, ${record.close.reason}.`);
  const c = await connect(io, home, 'the order cannot be read');
  if (typeof c === 'number') return c;
  const folder = IntentFolder.at(record.dir);
  try {
    const e = await readOrder(c, folder, entry, clock().toISOString());
    const lines = [`Order ${entry.broker_order_id}: ${e.moved ? said(e.line) : `${e.line.status}, as before`}.`];
    let moved = e.moved;
    const now = readIntent(record.dir, clock());
    const exit = now.intent.exit;
    const resting = exitLines(now.orders).at(-1);
    if (now.state === 'filled' && exit?.standing && !resting) {
      lines.push(...(await placeExit(c, folder, now, clock)));
      moved = true;
    } else if (resting?.broker_order_id && !ENDED.has(resting.status)) {
      const x = await readOrder(c, folder, resting, clock().toISOString());
      lines.push(`Its standing exit, order ${resting.broker_order_id}: ${x.moved ? said(x.line) : `${x.line.status}, as before`}.`);
      moved ||= x.moved;
      if (x.line.status === 'filled') {
        closeIntent(folder, { at: clock().toISOString(), state: 'closed', reason: `its standing exit filled: ${x.line.filled_qty} at $${(x.line.filled_avg_price ?? 0).toLocaleString('en-US')}` });
        lines.push('The position it opened is closed.');
      } else if (ENDED.has(x.line.status)) lines.push(`Its standing exit is ${x.line.status}, so nothing rests at Alpaca for it now, and the position stays open.`);
    }
    io.print(moved ? [...lines, `The intent is ${readIntent(record.dir, clock()).state}.`] : lines);
    return 0;
  } catch (error) {
    return io.fail(`Alpaca could not be read: ${(error as Error).message}`);
  }
}

// The standing exit, placed to rest at Alpaca once the entry has filled: a sale of what it
// bought and is held now (a crypto fee can leave a little less), priced from the fill. The
// entry's yes covers it, in the words approval.json keeps; it goes through the guard all the
// same, at paper only.
async function placeExit(c: Connected, folder: IntentFolder, record: IntentRecord, clock: () => Date): Promise<string[]> {
  const exit = record.intent.exit!;
  const filled = entryLines(record.orders).at(-1)!;
  const order = filled.filled_avg_price ? exitOrder(exit, filled.filled_avg_price) : null;
  if (!order) return [`Its standing exit could not be priced from the fill (${filled.filled_avg_price ?? 'no price on record'}), so none was placed.`];
  if (c.mode !== 'paper') return [`Its standing exit, ${exitWords(exit)}, rests only at paper; in mode ${c.mode} it is not placed.`];
  const symbol = record.intent.instrument.symbol;
  const [positions, asset] = await Promise.all([c.broker.positions(), c.broker.asset(symbol)]);
  const qty = Math.min(filled.filled_qty ?? 0, positions.find((p) => heldAs(p.symbol) === heldAs(symbol))?.qty ?? 0);
  if (!(qty > 0)) return ['Nothing it bought is held now, so no standing exit was placed.'];
  const prices = order.type === 'stop_limit' ? `stop $${order.stopPrice.toLocaleString('en-US')}, limit $${order.limitPrice.toLocaleString('en-US')}` : `limit $${order.limitPrice.toLocaleString('en-US')}`;
  const guard = new OrderGuard({ broker: c.broker, mode: 'paper', caps: c.caps, log: c.log, now: clock });
  const result = await guard.submit({ symbol: asset?.symbol ?? symbol, side: 'sell', qty, type: order.type, limitPrice: order.limitPrice, ...(order.type === 'stop_limit' ? { stopPrice: order.stopPrice } : {}) }, async () => true);
  const at = clock().toISOString();
  const note = `standing ${exit.stop ? 'stop' : 'target'}: ${prices}`;
  const body = result.checked.body;
  if (result.outcome === 'placed') {
    folder.appendOrder({ leg: 'exit', at, client_order_id: body!.client_order_id, broker_order_id: result.order!.id, status: result.order!.status, filled_qty: null, filled_avg_price: null, note });
    return [`Its standing exit rests at Alpaca: order ${result.order!.id}, a sale of ${qty} ${symbol}, ${prices}.`];
  }
  if (result.outcome === 'failed') {
    folder.appendOrder({ leg: 'exit', at, client_order_id: body!.client_order_id, broker_order_id: null, status: 'rejected', filled_qty: 0, filled_avg_price: null, note: `${note}; ${result.error ?? ''}` });
    return [`Alpaca did not take its standing exit: ${result.error}. The position stays open, with nothing resting for it.`];
  }
  if (result.outcome === 'unknown') {
    folder.appendOrder({ leg: 'exit', at, client_order_id: body!.client_order_id, broker_order_id: null, status: 'unknown', filled_qty: null, filled_avg_price: null, note: `${note}; ${result.error ?? ''}` });
    return [`Its standing exit was sent, and no readable answer came back (${result.error}). The connection is off; primerkit broker reconcile asks Alpaca for it.`];
  }
  return ['Its standing exit was not placed:', ...result.checked.refused.map((r) => `  ${r}`), 'A later refresh tries again.'];
}

// An intent cancelled: one with no order yet is closed; one whose order has not filled asks
// Alpaca to cancel it, and closes once Alpaca has; a filled one's resting exit is taken back,
// and the position stays open.
async function cancel(io: Io, home: string, record: IntentRecord, clock: () => Date): Promise<number> {
  const folder = IntentFolder.at(record.dir);
  if (record.close) return io.fail(`The intent is already closed: ${record.close.state}.`);
  const resting = exitLines(record.orders).at(-1);
  const exitRests = Boolean(resting?.broker_order_id && !ENDED.has(resting.status));
  if (record.state === 'filled' && !exitRests) return io.fail('Its order has filled, so there is nothing to cancel. A new intent sells what is held.');
  const last = record.state === 'filled' ? resting! : entryLines(record.orders).at(-1);
  if (!last) {
    closeIntent(folder, { at: clock().toISOString(), state: 'cancelled', reason: 'cancelled by hand before any order' });
    io.print(['Cancelled. No order had gone.']);
    return 0;
  }
  if (!last.broker_order_id) return io.fail('Its order has no id at Alpaca on record: primerkit broker reconcile asks Alpaca for it first.');
  const c = await connect(io, home, 'nothing can be cancelled');
  if (typeof c === 'number') return c;
  try {
    await c.broker.cancel(last.broker_order_id);
    const state = await c.broker.order(last.broker_order_id);
    const at = clock().toISOString();
    folder.appendOrder({ ...(last.leg ? { leg: last.leg } : {}), at, client_order_id: last.client_order_id, broker_order_id: last.broker_order_id, status: state.status, filled_qty: Number.isFinite(state.filledQty) ? state.filledQty : null, filled_avg_price: state.filledAvgPrice ?? null, ...(last.note ? { note: last.note } : {}) });
    if (state.status !== 'canceled') {
      io.print([`Alpaca took the cancel, and the order is ${state.status} for now. primerkit intent ${record.intent.intent_id} refresh reads it again.`]);
      return 0;
    }
    if (last.leg === 'exit') {
      io.print(['Its standing exit was cancelled at Alpaca. The position stays open, with nothing resting for it.']);
      return 0;
    }
    closeIntent(folder, { at, state: 'cancelled', reason: `cancelled at Alpaca${state.filledQty ? `, after ${state.filledQty} filled` : ', with nothing filled'}` });
    io.print([`Cancelled at Alpaca${state.filledQty ? `, after ${state.filledQty} filled` : ', with nothing filled'}.`]);
    return 0;
  } catch (error) {
    return io.fail(`Alpaca did not cancel it: ${(error as Error).message}`);
  }
}

