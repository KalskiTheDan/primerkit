import { existsSync, mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { INTENT_SCHEMA, IntentError, IntentFolder, Journal, intentProblems, intentTitle, newIntentId, readIntent, type Intent } from '../src/index';

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = join(here, '..', '..', '..');
const CREATED = '2026-10-11T10:00:00.000Z';

// An intent a routine's label drafts: hold half the account in BTC/USD, with a standing stop
// and target set at the entry's yes.
function intent(over: Partial<Intent> = {}): Intent {
  return {
    intent_version: 1,
    intent_id: newIntentId(new Date(CREATED)),
    created_at: CREATED,
    expires_at: '2026-10-11T11:00:00.000Z',
    source: { kind: 'routine', routine: 'wf', tick: '2026-10-11' },
    instrument: { symbol: 'BTC/USD', asset_class: null, venue: 'alpaca' },
    side: 'buy',
    leg_of: null,
    sizing: { kind: 'target_share', share: 0.5 },
    entry: { kind: 'market' },
    exit: { stop: { kind: 'distance', share: 0.05 }, target: { kind: 'price', price: 95000 }, standing: true },
    option: null,
    provenance: { thesis: 'wf, rules 1a2b3c4d5e6f', run_id: '20261011T095900Z-abc123', cited: [{ block: 'btc.pulse', line: 7, quote: 'BTC at $84,512.32' }], generated: ['2026-10-11T09:05:00.000Z'], checks_passed: [{ check: 'citations', passed: true }], model: 'qwen2.5:7b', data_as_of: null },
    ...over,
  };
}

describe('the order intent format', () => {
  it('takes an intent a routine drafts, and the published schema is the one the code checks with', () => {
    expect(intentProblems(intent())).toEqual([]);
    const published = JSON.parse(readFileSync(join(ROOT, 'schemas', 'order-intent-1.schema.json'), 'utf8')) as unknown;
    expect(published).toEqual(JSON.parse(JSON.stringify(INTENT_SCHEMA)));
  });

  it('says in its own words what decided, that a trigger never sends, and that PreReason is never an exit', () => {
    const text = JSON.stringify(INTENT_SCHEMA);
    expect(text).toContain('Your rules and your model decided; PreReason supplied data.');
    expect(text).toContain('A trigger only makes the intent ready. It never sends anything: the order still needs the typed yes.');
    expect(text).toContain('Your routine runs when this PreReason publication changes; your rules decide. It is not a trade signal');
    expect(text).toContain('A PreReason event is never an exit');
    // No other word of the format calls PreReason a signal, or says it recommends.
    expect(text.replace('It is not a trade signal', '')).not.toMatch(/signal|recommend/i);
  });

  it('refuses what a model might write, and whatever the rules forbid, naming each', () => {
    const refused = (over: Record<string, unknown>) => intentProblems({ ...intent(), ...over }).join('; ');
    // A size of the model's own, beside the rule, is no field of the format.
    expect(refused({ qty: 3 })).toMatch(/must NOT have additional properties/);
    expect(refused({ sizing: { kind: 'fixed_notional', dollars: -5 } })).toMatch(/sizing/);
    expect(refused({ sizing: { kind: 'percent_of_equity', share: 1.5 } })).toMatch(/sizing/);
    // Options are reserved, and refused.
    expect(refused({ option: { right: 'call', strike: 90000, expiry: '2026-12-25', contracts: 1 } })).toMatch(/option must be null/);
    // A PreReason event cannot be an exit: a stop is the person's own price.
    expect(refused({ exit: { stop: { kind: 'prereason_event', source: 'btc.momentum' }, standing: true } })).toMatch(/exit/);
    // An asset class is crypto or a US stock, read from the broker.
    expect(refused({ instrument: { symbol: 'BTC-PERP', asset_class: 'future', venue: 'alpaca' } })).toMatch(/asset_class/);
    expect(refused({ intent_version: 2 })).toMatch(/intent_version must be equal to constant/);
    // What a schema cannot say.
    expect(refused({ sizing: { kind: 'fixed_quantity', quantity: 0.1 } })).toBe('a fixed quantity sells what is held only');
    expect(refused({ side: 'hedge', sizing: { kind: 'fixed_notional', dollars: 500 } })).toBe('a hedge names the intent it is a leg of in leg_of, and only a hedge does');
    expect(refused({ side: 'hedge', leg_of: '20261011T100000Z-abcdef' })).toBe('a target share is reached by a buy or a sell, not a hedge');
    expect(refused({ leg_of: '20261011T100000Z-abcdef' })).toBe('a hedge names the intent it is a leg of in leg_of, and only a hedge does');
    expect(refused({ expires_at: CREATED })).toBe('expires_at must come after created_at');
    expect(refused({ entry: { kind: 'trigger', condition: { kind: 'price', symbol: 'BTC/USD', above: 90000, below: 80000 } } })).toBe('a price trigger names one of above and below');
    expect(refused({ entry: { kind: 'trigger', condition: { kind: 'price', symbol: 'BTC/USD' } } })).toBe('a price trigger names one of above and below');
    expect(refused({ exit: { rule: 'exit', standing: true } })).toBe('standing exits need a stop or a target');
    // CONTROL: a sell of a fixed quantity, a hedge with its first leg and a trigger on a
    // PreReason publication are each valid.
    expect(refused({ side: 'sell', sizing: { kind: 'fixed_quantity', quantity: 0.1 } })).toBe('');
    expect(refused({ side: 'hedge', leg_of: '20261011T100000Z-abcdef', sizing: { kind: 'fixed_notional', dollars: 500 } })).toBe('');
    expect(refused({ entry: { kind: 'trigger', condition: { kind: 'prereason_event', source: 'macro.snapshot' } } })).toBe('');
  });
});

describe("an intent's journal folder", () => {
  it('is <day>/intent/<intent_id>/, is written only for a valid intent, and each file once', () => {
    const root = mkdtempSync(join(tmpdir(), 'pk-intent-'));
    const journal = new Journal(root);
    const draft = intent();
    const folder = IntentFolder.draft(journal, draft);
    expect(folder.dir).toBe(join(root, '2026-10-11', 'intent', draft.intent_id));
    expect(JSON.parse(readFileSync(join(folder.dir, 'intent.json'), 'utf8'))).toEqual(draft);
    // Nothing is written over: not the intent, not a file once written.
    expect(() => folder.write('intent.json', draft)).toThrow(/EEXIST/);
    folder.write('ready.json', { at: '2026-10-11T10:01:00.000Z', by: 'person', what: 'drafted at the terminal' });
    expect(() => folder.write('ready.json', {})).toThrow(/EEXIST/);
    // An intent that is not valid is never written.
    const bad = { ...intent(), intent_id: newIntentId(new Date('2026-10-11T10:00:01Z')), sizing: { kind: 'fixed_quantity', quantity: 1 } } as Intent;
    expect(() => IntentFolder.draft(journal, bad)).toThrow(IntentError);
    expect(readdirSync(join(root, '2026-10-11', 'intent'))).toEqual([draft.intent_id]);
  });

  it('reads its state from the files there, which only move it on', () => {
    const root = mkdtempSync(join(tmpdir(), 'pk-intent-'));
    const folder = IntentFolder.draft(new Journal(root), intent());
    const at = (t: string) => folder.read(new Date(`2026-10-11T${t}Z`)).state;
    expect(at('10:00:30')).toBe('draft');
    folder.write('ready.json', { at: '2026-10-11T10:01:00.000Z', by: 'trigger', what: 'BTC/USD above 90,000' });
    expect(at('10:01:30')).toBe('ready');
    folder.write('approval.json', { user: 'sam', at: '2026-10-11T10:02:00.000Z', body: { symbol: 'BTC/USD' }, typed: 'yes', terminal: 'Windows Terminal' });
    expect(at('10:02:30')).toBe('approved');
    // Approved and not sent by the time it expires: expired, never sent.
    expect(at('11:00:01')).toBe('expired');
    folder.appendOrder({ at: '2026-10-11T10:03:00.000Z', client_order_id: 'pk-1', broker_order_id: 'a1', status: 'accepted', filled_qty: 0, filled_avg_price: null });
    expect(at('10:03:30')).toBe('sent');
    // Once sent, the clock no longer expires it: the broker's answers say where it stands.
    expect(at('11:30:00')).toBe('sent');
    folder.appendOrder({ at: '2026-10-11T10:03:05.000Z', client_order_id: 'pk-1', broker_order_id: 'a1', status: 'partially_filled', filled_qty: 0.002, filled_avg_price: 84500 });
    expect(at('10:03:30')).toBe('partially_filled');
    folder.appendOrder({ at: '2026-10-11T10:03:09.000Z', client_order_id: 'pk-1', broker_order_id: 'a1', status: 'filled', filled_qty: 0.003, filled_avg_price: 84510 });
    const record = folder.read(new Date('2026-10-11T10:04:00Z'));
    expect(record.state).toBe('filled');
    expect(record.orders.map((o) => o.status)).toEqual(['accepted', 'partially_filled', 'filled']);
    folder.write('close.json', { at: '2026-10-11T12:00:00.000Z', state: 'closed', reason: 'the standing target filled' });
    expect(at('12:00:30')).toBe('closed');
    // An order the broker refused, in a folder of its own.
    const refused = IntentFolder.draft(new Journal(root), intent({ intent_id: newIntentId(new Date('2026-10-11T10:05:00Z')), created_at: '2026-10-11T10:05:00.000Z' }));
    refused.appendOrder({ at: '2026-10-11T10:06:00.000Z', client_order_id: 'pk-2', broker_order_id: null, status: 'rejected', filled_qty: 0, filled_avg_price: null });
    expect(refused.read(new Date('2026-10-11T10:06:30Z')).state).toBe('failed');
    expect(readIntent(refused.dir, new Date('2026-10-11T10:06:30Z')).intent.intent_id).toBe(refused.read().intent.intent_id);
  });

  it('names itself in one line', () => {
    expect(intentTitle(intent())).toBe('buy BTC/USD, to 50% of equity');
    expect(intentTitle(intent({ sizing: { kind: 'fixed_notional', dollars: 1500 } }))).toBe('buy BTC/USD, $1,500');
    expect(intentTitle(intent({ side: 'sell', sizing: { kind: 'fixed_quantity', quantity: 0.25 } }))).toBe('sell BTC/USD, 0.25 held');
    expect(intentTitle(intent({ sizing: { kind: 'risk_based', risk_share: 0.01, stop_distance: 0.05 } }))).toBe('buy BTC/USD, 1% of equity at risk');
    expect(existsSync(join(ROOT, 'schemas', 'order-intent-1.schema.json'))).toBe(true);
  });
});
