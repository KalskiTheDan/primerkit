import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Ajv2020 } from 'ajv/dist/2020.js';
import type { ValidateFunction } from 'ajv';
import type { Journal } from './journal';
import { newRunId } from './packet';

// The order intent: the one documented record between what a model concluded and anything a
// broker does, and the only way an order leaves primerkit. It names the instrument, the side,
// the person's own sizing rule (never a number a model chose), the entry, the exits, and
// where it came from. Every order needs the person's typed yes, and a standing stop or target
// is given its yes with the entry's; a trigger only makes an intent ready. Paper trading only. The format is published as a JSON Schema in
// schemas/order-intent-1.schema.json, so another broker, model or agent can read and write it.

export const INTENT_VERSION = 1;

export type AssetClass = 'crypto' | 'us_equity';
export type IntentSide = 'buy' | 'sell' | 'hedge';

// The person's sizing rule. Code computes the amount from the broker's own figures when the
// checks run; the model never writes a size.
export type IntentSizing =
  | { kind: 'fixed_notional'; dollars: number }
  | { kind: 'fixed_quantity'; quantity: number }
  | { kind: 'percent_of_equity'; share: number }
  | { kind: 'target_share'; share: number }
  | { kind: 'risk_based'; risk_share: number; stop_distance: number };

export type IntentTrigger =
  | { kind: 'price'; symbol: string; above?: number; below?: number }
  | { kind: 'prereason_event'; source: string }
  | { kind: 'webhook'; name: string };

export type IntentEntry = { kind: 'market' } | { kind: 'limit'; price: number } | { kind: 'trigger'; condition: IntentTrigger };

// A stop or a target: a price, or a share of the fill price away from it.
export type IntentLevel = { kind: 'price'; price: number } | { kind: 'distance'; share: number };

export interface IntentExit {
  stop?: IntentLevel;
  target?: IntentLevel;
  time?: { kind: 'after_days'; days: number } | { kind: 'on'; date: string };
  rule?: string; // the routine's own exit label, read on its next tick
  standing: boolean; // the stop and target close at paper without a second yes
  stop_limit_gap?: number; // a crypto stop is a stop-limit order: its limit sits this share below the stop
}

export type IntentSource = { kind: 'routine'; routine: string; tick: string } | { kind: 'ask'; run_id: string } | { kind: 'manual' } | { kind: 'webhook'; name: string };

export interface IntentProvenance {
  thesis: string;
  run_id: string | null;
  cited: Array<{ block: string; line: number; quote: string }>;
  generated: string[]; // the cited briefings' generated times
  checks_passed: Array<{ check: string; passed: boolean }>;
  model: string | null;
  data_as_of: string | null;
}

export interface Intent {
  intent_version: 1;
  intent_id: string;
  created_at: string;
  expires_at: string;
  source: IntentSource;
  instrument: { symbol: string; asset_class: AssetClass | null; venue: string };
  side: IntentSide;
  leg_of: string | null;
  sizing: IntentSizing;
  entry: IntentEntry;
  exit: IntentExit | null;
  option: null;
  provenance: IntentProvenance;
}

// What the files beside intent.json record. Each is written once.
export interface IntentReady {
  at: string;
  by: 'trigger' | 'person';
  what: string;
}

export interface RiskCheck {
  check: string;
  limit: number | string | null;
  value: number | string | null;
  passed: boolean;
  message: string;
}

export interface IntentChecks {
  at: string;
  computed: { notional: number | null; quantity: number | null; price: number | null; price_at: string | null; equity: number | null; held: number | null };
  checks: RiskCheck[];
}

export interface IntentApproval {
  user: string; // the machine's user name, never an email
  at: string;
  body: Record<string, unknown>; // the exact order body shown
  exits?: string; // the standing exits shown with it, in the words shown
  typed: string;
  terminal: string;
}

export interface IntentOrderLine {
  leg?: 'entry' | 'exit'; // the entry where it is left out
  at: string;
  client_order_id: string;
  broker_order_id: string | null;
  status: string;
  filled_qty: number | null;
  filled_avg_price: number | null;
  note?: string;
}

export const CLOSED_STATES = ['closed', 'expired', 'refused', 'failed', 'cancelled'] as const;
export type ClosedState = (typeof CLOSED_STATES)[number];

export interface IntentClose {
  at: string;
  state: ClosedState;
  reason: string;
}

export type IntentState = 'draft' | 'ready' | 'approved' | 'sent' | 'partially_filled' | 'filled' | ClosedState;

const NUMBER = { type: 'number', exclusiveMinimum: 0 };
const SHARE = { type: 'number', exclusiveMinimum: 0, maximum: 1 };
const TIME = { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(\\.\\d+)?Z$' };
const closed = (properties: Record<string, unknown>, required = Object.keys(properties)) => ({ type: 'object', additionalProperties: false, required, properties });
const kind = (name: string, properties: Record<string, unknown> = {}, description?: string) => ({ ...closed({ kind: { const: name }, ...properties }), ...(description ? { description } : {}) });

// The published format. schemas/order-intent-1.schema.json holds it as JSON, and a test keeps
// the two the same.
export const INTENT_SCHEMA = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://github.com/KalskiTheDan/primerkit/schemas/order-intent-1.schema.json',
  title: 'primerkit order intent, version 1',
  description:
    "The one record between what a model concluded and anything a broker does. Your rules and your model decided; PreReason supplied data. Sizes come from the person's own rule, computed by code. Every order needs the person's typed yes; a standing stop or target is given its yes with the entry's. Paper trading only. This is intent.json, as drafted; the files beside it in its journal folder record the checks, the yes, the orders and the close, each written once.",
  ...closed({
    intent_version: { const: 1 },
    intent_id: { type: 'string', pattern: '^[0-9]{8}T[0-9]{6}Z-[0-9a-f]{6}$', description: 'The intent folder name: the time it was drafted and six random hex digits.' },
    created_at: TIME,
    expires_at: { ...TIME, description: 'A stale intent is never sent: past this time it is expired, and a new intent is needed.' },
    source: {
      description: 'What drafted the intent.',
      oneOf: [kind('routine', { routine: { type: 'string', minLength: 1 }, tick: { type: 'string', minLength: 1 } }), kind('ask', { run_id: { type: 'string', minLength: 1 } }), kind('manual'), kind('webhook', { name: { type: 'string', minLength: 1 } })],
    },
    instrument: closed({
      symbol: { type: 'string', pattern: '^[A-Za-z0-9./-]{1,20}$', description: 'As the broker names it, such as BTC/USD or AAPL.' },
      asset_class: { enum: ['crypto', 'us_equity', null], description: "Read from the broker's own asset list, never guessed from the symbol; null until the checks read it." },
      venue: { type: 'string', minLength: 1, description: "The broker's id, such as alpaca. Every adapter is paper only." },
    }),
    side: { enum: ['buy', 'sell', 'hedge'], description: 'A sell only reduces or closes what is held: short selling is off. A hedge is a second, opposite leg tied to the first by leg_of.' },
    leg_of: { type: ['string', 'null'], description: 'The intent a hedge is a leg of; null otherwise.' },
    sizing: {
      description: "The person's sizing rule, from their routine or their own command. The amount is computed by code from the broker's figures when the checks run, and written beside the rule in checks.json. A model never writes a size.",
      oneOf: [
        kind('fixed_notional', { dollars: NUMBER }),
        kind('fixed_quantity', { quantity: NUMBER }, 'Selling what is held only.'),
        kind('percent_of_equity', { share: SHARE }, 'Dollars equal to this share of equity.'),
        kind('target_share', { share: { type: 'number', minimum: 0, maximum: 1 } }, "Hold this share of equity in the symbol: a routine label's target. The side is what reaches it."),
        kind('risk_based', { risk_share: SHARE, stop_distance: SHARE }, 'The dollars at risk to the stop, as a share of equity, with the stop this share of the price away.'),
      ],
    },
    entry: {
      oneOf: [
        kind('market'),
        kind('limit', { price: NUMBER }),
        kind(
          'trigger',
          {
            condition: {
              description: 'A trigger only makes the intent ready. It never sends anything: the order still needs the typed yes.',
              oneOf: [
                { ...closed({ kind: { const: 'price' }, symbol: { type: 'string', minLength: 1 }, above: NUMBER, below: NUMBER }, ['kind', 'symbol']), description: "A price crossing, read from the broker's own quotes. Exactly one of above and below." },
                kind('prereason_event', { source: { type: 'string', minLength: 1 } }, 'Your routine runs when this PreReason publication changes; your rules decide. It is not a trade signal, and a publication on a futures, swap or options series can never be a trigger.'),
                kind('webhook', { name: { type: 'string', minLength: 1 } }, "A webhook on the person's own machine, bound to localhost, with their shared secret."),
              ],
            },
          },
        ),
      ],
    },
    exit: {
      description: "The exits, when any. Each fires as an intent of its own. A PreReason event is never an exit: a stop or a target is the person's own price, read from the broker's quotes.",
      oneOf: [
        { type: 'null' },
        closed(
          {
            stop: { $ref: '#/$defs/level' },
            target: { $ref: '#/$defs/level' },
            time: { oneOf: [kind('after_days', { days: { type: 'integer', minimum: 1 } }), kind('on', { date: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' } })] },
            rule: { type: 'string', minLength: 1, description: "The routine's own exit label, read on its next tick." },
            standing: { type: 'boolean', description: "When true, the stop and the target set at the entry's yes close the position at paper without a second yes. Every other exit needs its own yes." },
            stop_limit_gap: { type: 'number', minimum: 0, exclusiveMaximum: 0.5, description: "A crypto stop is a stop-limit order at the broker: its limit sits this share below the stop. The person's own setting." },
          },
          ['standing'],
        ),
      ],
    },
    option: { type: 'null', description: 'Reserved for an options leg. Every adapter refuses options until they are designed on their own.' },
    provenance: closed({
      thesis: { type: 'string', minLength: 1, description: "The routine's name and rules hash, or the question asked." },
      run_id: { type: ['string', 'null'], description: 'The journal run that gave the label or the answer.' },
      cited: { type: 'array', items: closed({ block: { type: 'string' }, line: { type: 'integer', minimum: 1 }, quote: { type: 'string' } }), description: 'The cited lines, as the checks verified them.' },
      generated: { type: 'array', items: { type: 'string' }, description: "The cited briefings' generated times." },
      checks_passed: { type: 'array', items: closed({ check: { type: 'string' }, passed: { type: 'boolean' } }) },
      model: { type: ['string', 'null'], description: 'What answered, as the provider reported it.' },
      data_as_of: { type: ['string', 'null'] },
    }),
  }),
  $defs: {
    level: { oneOf: [kind('price', { price: NUMBER }), kind('distance', { share: SHARE }, 'A share of the fill price away from it.')] },
  },
} as const;

let validate: ValidateFunction | null = null;

// Every problem with a drafted intent, in words, or none. The schema first, then what a
// schema cannot say: an intent expires after it is drafted, a hedge names its first leg and
// only a hedge does, a fixed quantity only sells, a price trigger has one bound, and standing
// exits need a stop or a target to stand on.
export function intentProblems(doc: unknown): string[] {
  if (!validate) validate = new Ajv2020({ allErrors: true, strict: false }).compile(INTENT_SCHEMA);
  if (!validate(doc)) {
    // A oneOf names a failure for each branch it tried; the first few say what is wrong.
    return [...new Set((validate.errors ?? []).map((e) => `${e.instancePath || 'the intent'} ${e.message ?? 'does not match the schema'}`))].slice(0, 8);
  }
  const intent = doc as Intent;
  const problems: string[] = [];
  if (!(Date.parse(intent.expires_at) > Date.parse(intent.created_at))) problems.push('expires_at must come after created_at');
  if ((intent.side === 'hedge') !== (intent.leg_of !== null)) problems.push('a hedge names the intent it is a leg of in leg_of, and only a hedge does');
  if (intent.sizing.kind === 'fixed_quantity' && intent.side !== 'sell') problems.push('a fixed quantity sells what is held only');
  if (intent.sizing.kind === 'target_share' && intent.side === 'hedge') problems.push('a target share is reached by a buy or a sell, not a hedge');
  if (intent.entry.kind === 'trigger' && intent.entry.condition.kind === 'price' && (intent.entry.condition.above === undefined) === (intent.entry.condition.below === undefined)) problems.push('a price trigger names one of above and below');
  if (intent.exit?.standing && !intent.exit.stop && !intent.exit.target) problems.push('standing exits need a stop or a target');
  if (intent.exit?.stop_limit_gap !== undefined && !intent.exit.stop) problems.push('stop_limit_gap goes with a stop');
  return problems;
}

export class IntentError extends Error {
  constructor(readonly problems: string[]) {
    super(`The order intent is not valid: ${problems.join('; ')}.`);
  }
}

// The files of an intent's folder. All but orders.jsonl are written once; orders.jsonl takes
// one line for each answer from the broker, appended, never rewritten.
export const INTENT_FILES = ['intent.json', 'ready.json', 'checks.json', 'approval.json', 'checks.final.json', 'orders.jsonl', 'close.json', 'render.md'] as const;
export type IntentFile = (typeof INTENT_FILES)[number];
type OnceFile = Exclude<IntentFile, 'orders.jsonl'>;

export const newIntentId = (now = new Date()): string => newRunId(now);

// One intent's folder in the journal: <day>/intent/<intent_id>/.
export class IntentFolder {
  private constructor(readonly dir: string) {}

  // Writes the drafted intent, checked first: an intent that is not valid is never written.
  static draft(journal: Journal, intent: Intent): IntentFolder {
    const problems = intentProblems(intent);
    if (problems.length) throw new IntentError(problems);
    const dir = journal.runDir('intent', intent.intent_id, new Date(intent.created_at));
    mkdirSync(dir, { recursive: true });
    const folder = new IntentFolder(dir);
    folder.write('intent.json', intent);
    return folder;
  }

  static at(dir: string): IntentFolder {
    if (!existsSync(join(dir, 'intent.json'))) throw new Error(`${dir} holds no intent.json`);
    return new IntentFolder(dir);
  }

  write(name: OnceFile, content: string | object): void {
    const body = typeof content === 'string' ? content : `${JSON.stringify(content, null, 2)}\n`;
    writeFileSync(join(this.dir, name), body, { flag: 'wx' });
  }

  appendOrder(line: IntentOrderLine): void {
    appendFileSync(join(this.dir, 'orders.jsonl'), `${JSON.stringify(line)}\n`);
  }

  read(now = new Date()): IntentRecord {
    return readIntent(this.dir, now);
  }
}

export interface IntentRecord {
  dir: string;
  intent: Intent;
  ready: IntentReady | null;
  checks: IntentChecks | null;
  approval: IntentApproval | null;
  finalChecks: IntentChecks | null;
  orders: IntentOrderLine[];
  close: IntentClose | null;
  state: IntentState;
}

const readJson = <T>(path: string): T | null => (existsSync(path) ? (JSON.parse(readFileSync(path, 'utf8')) as T) : null);

// The broker's order states that end an order unfilled.
const UNFILLED = new Set(['canceled', 'expired', 'rejected', 'failed']);

// An intent as its folder records it. The state is read from which files are there, and the
// files only ever grow, so the state only moves on: a close names its own; then the latest
// answer from the broker; then an intent not sent before it expired is expired; then the yes;
// then ready; else a draft.
export function readIntent(dir: string, now = new Date()): IntentRecord {
  const intent = readJson<Intent>(join(dir, 'intent.json'));
  if (!intent) throw new Error(`${dir} holds no intent.json`);
  const ordersPath = join(dir, 'orders.jsonl');
  const orders = existsSync(ordersPath)
    ? readFileSync(ordersPath, 'utf8')
        .split('\n')
        .filter((l) => l.trim())
        .map((l) => JSON.parse(l) as IntentOrderLine)
    : [];
  const record = {
    dir,
    intent,
    ready: readJson<IntentReady>(join(dir, 'ready.json')),
    checks: readJson<IntentChecks>(join(dir, 'checks.json')),
    approval: readJson<IntentApproval>(join(dir, 'approval.json')),
    finalChecks: readJson<IntentChecks>(join(dir, 'checks.final.json')),
    orders,
    close: readJson<IntentClose>(join(dir, 'close.json')),
  };
  return { ...record, state: stateOf(record, now) };
}

// The entry's lines; a standing exit's lines are its own, and its fill closes the intent.
export const entryLines = (orders: IntentOrderLine[]): IntentOrderLine[] => orders.filter((o) => (o.leg ?? 'entry') === 'entry');
export const exitLines = (orders: IntentOrderLine[]): IntentOrderLine[] => orders.filter((o) => o.leg === 'exit');

function stateOf(r: Omit<IntentRecord, 'state'>, now: Date): IntentState {
  if (r.close) return r.close.state;
  const last = entryLines(r.orders).at(-1);
  if (last) {
    if (last.status === 'filled') return 'filled';
    if (last.status === 'partially_filled') return 'partially_filled';
    if (UNFILLED.has(last.status)) return 'failed';
    return 'sent';
  }
  if (now.getTime() > Date.parse(r.intent.expires_at)) return 'expired';
  if (r.approval) return 'approved';
  if (r.ready) return 'ready';
  return 'draft';
}

// One line naming an intent, as the journal lists it: "buy BTC/USD, $500".
export function intentTitle(intent: Intent): string {
  const s = intent.sizing;
  const size =
    s.kind === 'fixed_notional'
      ? `$${s.dollars.toLocaleString('en-US')}`
      : s.kind === 'fixed_quantity'
        ? `${s.quantity} held`
        : s.kind === 'percent_of_equity'
          ? `${pct(s.share)} of equity`
          : s.kind === 'target_share'
            ? `to ${pct(s.share)} of equity`
            : `${pct(s.risk_share)} of equity at risk`;
  return `${intent.side} ${intent.instrument.symbol}, ${size}`;
}

const pct = (share: number): string => `${Number((share * 100).toFixed(2))}%`;
