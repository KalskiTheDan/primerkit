import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { closeIntent, IntentFolder, intentDirs, intentsCsv, Journal, newIntentId, readIntent, renderIntent, type Intent } from '../src/index';

const intent = (created: string, over: Partial<Intent> = {}): Intent => ({
  intent_version: 1,
  intent_id: newIntentId(new Date(created)),
  created_at: created,
  expires_at: new Date(Date.parse(created) + 3_600_000).toISOString(),
  source: { kind: 'routine', routine: 'wf', tick: '2026-10-11T07:30:00.000Z' },
  instrument: { symbol: 'BTC/USD', asset_class: null, venue: 'alpaca' },
  side: 'buy',
  leg_of: null,
  sizing: { kind: 'target_share', share: 0.5 },
  entry: { kind: 'market' },
  exit: { target: { kind: 'distance', share: 0.1 }, standing: true },
  option: null,
  provenance: { thesis: 'wf, rules 1a2b, label enter', run_id: 'r1', cited: [{ block: 'btc.context', line: 7, quote: 'momentum, "rising"' }], generated: ['2026-10-11T05:00:00.000Z'], checks_passed: [{ check: 'citations', passed: true }], model: 'qwen2.5:7b', data_as_of: '2026-10-10' },
  ...over,
});

// An intent's whole life in its folder: checks, the yes, the fills, its exit, its end.
function lived(root: string): IntentFolder {
  const folder = IntentFolder.draft(new Journal(root), intent('2026-10-11T10:00:00.000Z'));
  const checks = { at: '2026-10-11T10:10:00.000Z', computed: { notional: 29000, quantity: null, price: 84000, price_at: null, equity: 100000, held: 0.25 }, checks: [{ check: 'max_notional', limit: 50000, value: 29000, passed: true, message: '$29,000.00 is within your cap | a pipe' }] };
  folder.write('checks.json', checks);
  folder.write('approval.json', { user: 'sam', at: '2026-10-11T10:10:05.000Z', body: { symbol: 'BTC/USD', notional: '29000.00' }, exits: 'Once it fills, a target 10% above the fill price …', typed: 'yes', terminal: 'Windows Terminal' });
  folder.write('checks.final.json', { ...checks, at: '2026-10-11T10:10:06.000Z' });
  folder.appendOrder({ at: '2026-10-11T10:10:07.000Z', client_order_id: 'c1', broker_order_id: 'o1', status: 'accepted', filled_qty: null, filled_avg_price: null });
  folder.appendOrder({ at: '2026-10-11T10:11:00.000Z', client_order_id: 'c1', broker_order_id: 'o1', status: 'filled', filled_qty: 0.345, filled_avg_price: 84000 });
  folder.appendOrder({ leg: 'exit', at: '2026-10-11T10:12:00.000Z', client_order_id: 'c2', broker_order_id: 'o2', status: 'filled', filled_qty: 0.345, filled_avg_price: 92400, note: 'standing target: limit $92,400' });
  closeIntent(folder, { at: '2026-10-11T12:00:00.000Z', state: 'closed', reason: 'its standing exit filled: 0.345 at $92,400' });
  return folder;
}

describe("an intent's page and its export", () => {
  it('closes with its page beside it, read top to bottom', () => {
    const folder = lived(mkdtempSync(join(tmpdir(), 'pk-export-')));
    const page = readFileSync(join(folder.dir, 'render.md'), 'utf8');
    expect(page).toEqual(renderIntent(readIntent(folder.dir, new Date('2026-10-11T12:00:00.000Z'))));
    const order = ['# buy BTC/USD, to 50% of equity', 'Your rules and your model decided; PreReason supplied data.', '## Where it came from', '  - btc.context line 7: "momentum, "rising""', '## The order', '- The rule: hold 50% of equity in it. The amount is computed by code, never by the model.', '- It came to $29,000.00 on equity of $100,000.00, 0.25 held.', '- The exit: a target 10% above the fill price, sent as a limit order.', '## The checks before the yes', '| max_notional | 50000 | 29000 | passed: $29,000.00 is within your cap / a pipe |', '## The yes', '- Typed "yes" by sam at 2026-10-11T10:10:05.000Z, at Windows Terminal.', '## The checks after the yes', '## The broker', '- 2026-10-11T10:11:00.000Z: filled, order o1, 0.345 filled at $84,000.00', '## The standing exit at the broker', '## The end', 'closed, 2026-10-11T12:00:00.000Z: its standing exit filled: 0.345 at $92,400.'];
    let at = 0;
    for (const part of order) {
      const found = page.indexOf(part, at);
      expect(found, part).toBeGreaterThanOrEqual(at);
      at = found;
    }
    // A page is written once, as every file there is.
    expect(() => closeIntent(folder, { at: '2026-10-11T12:01:00.000Z', state: 'closed', reason: 'again' })).toThrow(/EEXIST/);
  });

  it('finds the intents drafted from one day to another, both kept, and gives one CSV row each, quoted where it must be', () => {
    const root = mkdtempSync(join(tmpdir(), 'pk-export-'));
    lived(root);
    const later = IntentFolder.draft(new Journal(root), intent('2026-10-12T09:00:00.000Z', { exit: null, sizing: { kind: 'fixed_notional', dollars: 500 } }));
    IntentFolder.draft(new Journal(root), intent('2026-10-14T09:00:00.000Z'));
    expect(intentDirs(root, '2026-10-11', '2026-10-12').map((d) => d.split(/[\\/]/).slice(-3, -1).join('/'))).toEqual(['2026-10-11/intent', '2026-10-12/intent']);
    expect(intentDirs(root, '2026-10-13', '2026-10-13')).toEqual([]);
    expect(intentDirs(join(root, 'none'), '2026-10-01', '2026-10-31')).toEqual([]);
    const records = intentDirs(root, '2026-10-11', '2026-10-12').map((d) => readIntent(d, new Date('2026-10-12T09:30:00.000Z')));
    const [header, first, second, end] = intentsCsv(records).split('\r\n');
    expect(header).toBe('intent_id,created_at,state,source,thesis,run_id,model,symbol,side,rule,computed_notional,computed_quantity,checks_failed,approved_at,approved_by,broker_order_id,filled_qty,filled_avg_price,exit,exit_order_id,exit_status,closed_at,close_reason');
    expect(first).toContain(',closed,routine wf,"wf, rules 1a2b, label enter",r1,qwen2.5:7b,BTC/USD,buy,hold 50% of equity in it,29000,,,2026-10-11T10:10:05.000Z,sam,o1,0.345,84000,"a target 10% above the fill price, sent as a limit order",o2,filled,2026-10-11T12:00:00.000Z,"closed: its standing exit filled: 0.345 at $92,400"');
    expect(second).toBe(`${later.read().intent.intent_id},2026-10-12T09:00:00.000Z,draft,routine wf,"wf, rules 1a2b, label enter",r1,qwen2.5:7b,BTC/USD,buy,a fixed amount of $500.00,,,,,,,,,,,,,`);
    expect(end).toBe('');
    // Nothing in the journal was written by reading it.
    expect(existsSync(join(later.dir, 'render.md'))).toBe(false);
  });
});
