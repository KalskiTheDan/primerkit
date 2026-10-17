import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { IntentFolder, Journal, newIntentId, type Intent } from '@primerkit/core';
import { journalRows } from '../src/index';

describe('order intents in the journal', () => {
  it('lists each intent by what it does and the state its folder records, among the other runs', () => {
    const root = mkdtempSync(join(tmpdir(), 'pk-intent-rows-'));
    const created = '2026-10-11T10:00:00.000Z';
    const intent: Intent = {
      intent_version: 1,
      intent_id: newIntentId(new Date(created)),
      created_at: created,
      expires_at: '2099-01-01T00:00:00.000Z',
      source: { kind: 'manual' },
      instrument: { symbol: 'BTC/USD', asset_class: null, venue: 'alpaca' },
      side: 'buy',
      leg_of: null,
      sizing: { kind: 'fixed_notional', dollars: 500 },
      entry: { kind: 'market' },
      exit: null,
      option: null,
      provenance: { thesis: 'typed by hand', run_id: null, cited: [], generated: [], checks_passed: [], model: null, data_as_of: null },
    };
    const folder = IntentFolder.draft(new Journal(root), intent);
    folder.write('approval.json', { user: 'sam', at: '2026-10-11T10:01:00.000Z', body: {}, typed: 'yes', terminal: 'Windows Terminal' });
    // An ask run of the same day, beside it.
    const ask = join(root, '2026-10-11', 'ask', '20261011T095000Z-abc123');
    mkdirSync(ask, { recursive: true });
    writeFileSync(join(ask, 'packet.json'), JSON.stringify({ question: 'Where does Bitcoin stand?' }));
    writeFileSync(join(ask, 'meta.json'), JSON.stringify({ outcome: 'passed' }));
    // A folder still being written, with no intent.json yet, lists by its id.
    mkdirSync(join(root, '2026-10-11', 'intent', '20261011T100500Z-def456'));
    const rows = journalRows(root);
    expect(rows.map((r) => [r.operation, r.title, r.outcome, r.time])).toEqual([
      ['intent', '20261011T100500Z-def456', '', '10:05'],
      ['intent', 'buy BTC/USD, $500', 'approved', '10:00'],
      ['ask', 'Where does Bitcoin stand?', 'passed', '09:50'],
    ]);
  });
});
