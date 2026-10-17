import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { sampleJournal } from './sample-journal';
import { Journal, approveLiveIntent, intentRows, journalEntries, journalRun, journalRunLines, journalSummary, parseJournalQuery, queryWords, recordLiveIntent, sizingText } from '../src/index';

const fresh = () => sampleJournal(join(mkdtempSync(join(tmpdir(), 'pk-find-')), 'journal'));

describe('finding things in the journal', () => {
  it('reads words as a query: an operation, an outcome, a day, an id, and the rest as text', () => {
    expect(parseJournalQuery('failed macro.snapshot 2026-10-16 yield curve')).toEqual({ outcome: 'failed', briefing: 'macro.snapshot', day: '2026-10-16', text: 'yield curve' });
    expect(parseJournalQuery('routine')).toEqual({ operation: 'routine' });
    expect(parseJournalQuery('equities.company/nvda treasury-10y')).toEqual({ briefing: 'equities.company/nvda', text: 'treasury-10y' });
    expect(parseJournalQuery('  ')).toEqual({});
    expect(queryWords({ operation: 'ask', outcome: 'passed', text: 'yields' })).toBe('ask passed "yields"');
  });

  it('keeps the runs that match every field given, and carries each run\'s question and briefings', () => {
    const { root } = fresh();
    expect(journalEntries(root).map((e) => e.run_id)).toEqual(['20261016T100000Z-bbbbbb', '20261016T090000Z-aaaaaa', '20261015T120000Z-cccccc']);
    expect(journalEntries(root)[1]).toMatchObject({ question: 'Where do Treasury yields stand?', briefings: ['macro.snapshot'] });
    const ids = (q: Parameters<typeof journalEntries>[1]) => journalEntries(root, q).map((e) => e.run_id.slice(-6));
    expect(ids({ query: { operation: 'routine' } })).toEqual(['cccccc']);
    expect(ids({ query: { operation: 'ask', outcome: 'failed' } })).toEqual(['bbbbbb']);
    expect(ids({ query: { briefing: 'macro.snapshot' } })).toEqual(['aaaaaa']);
    expect(ids({ query: { day: '2026-10-15' } })).toEqual(['cccccc']);
    // Words in a question, or in the answer as it was read.
    expect(ids({ query: { text: 'treasury' } })).toEqual(['aaaaaa']);
    expect(ids({ query: { text: '4.02%' } })).toEqual(['aaaaaa']);
    expect(ids({ query: { text: 'dollar strengthening' } })).toEqual(['bbbbbb']);
    expect(ids({ query: { text: 'nowhere at all' } })).toEqual([]);
    expect(journalSummary(root, { query: { operation: 'ask' } })).toEqual([expect.objectContaining({ day: '2026-10-16', runs: 2, outcomes: { passed: 1, failed: 1 } })]);
  });

  it('opens a run to its question, answer, each cited line in full, its checks and what it spent', () => {
    const { root } = fresh();
    const run = journalRun(join(root, '2026-10-16', 'ask', '20261016T090000Z-aaaaaa'))!;
    expect(run).toMatchObject({ question: 'Where do Treasury yields stand?', answer: 'The 10-year yield is 4.02%.', label: null, outcome: 'passed', cost: { usd: 0.000175, basis: 'list price' }, tokens: { packet: 1200, input: 1300, output: 90 } });
    expect(run.claims[0]!.citations[0]).toEqual({ block: 'macro.snapshot', line: 3, quote: '"value_formatted":"4.02%"', line_text: '{"metric":"treasury-10y","value_formatted":"4.02%"}' });
    expect(run.checks).toEqual([{ id: 'schema', passed: true, failures: [] }, { id: 'citations', passed: true, failures: [] }]);
    const lines = journalRunLines(run);
    expect(lines).toContain('Question: Where do Treasury yields stand?');
    expect(lines).toContain('Answer: The 10-year yield is 4.02%.');
    expect(lines).toContain('  [macro.snapshot L3] {"metric":"treasury-10y","value_formatted":"4.02%"}');
    expect(lines).toContain('  ok citations');
    expect(lines).toContain('Spent: the packet 1,200 tokens; 1,300 in, 90 out, as the model reported; $0.0002 at list price.');
    const failed = journalRunLines(journalRun(join(root, '2026-10-16', 'ask', '20261016T100000Z-bbbbbb'))!);
    expect(failed).toContain('  x  citations: the quote is not in the line');
    expect(failed).toContain('Spent: the packet 1,200 tokens; no tokens reported; no cost known.');
  });

  it("reads a routine's tick as the label that fired, beside the reading it cites", () => {
    const { root } = fresh();
    const tick = journalRun(join(root, '2026-10-15', 'routine.btc-rules', '20261015T120000Z-cccccc'))!;
    expect(tick).toMatchObject({ label: 'enter', reason: 'The hash ribbon reads 1.016, above 1.' });
    const lines = journalRunLines(tick);
    expect(lines).toContain('Label: enter');
    expect(lines).toContain('  [rules L2] enter when the hash ribbon is above 1');
    expect(lines).toContain('  [btc.context L2] {"metric":"hash-ribbon","value_formatted":"1.016"}');
  });
});

describe('order intents for the positions screen', () => {
  it('lists each intent with what it came from, when it was recorded and when it was approved', () => {
    const journal = new Journal(join(mkdtempSync(join(tmpdir(), 'pk-pos-')), 'journal'));
    const typed = recordLiveIntent(journal, { symbol: 'AAPL', side: 'buy', quantity: 2, source: 'typed' }, new Date('2026-10-16T09:00:00Z'));
    recordLiveIntent(journal, { symbol: 'MSFT', side: 'sell', quantity: 1, order_type: 'limit', limit_price: 420, source: 'rules', rules: 'trim-rules' }, new Date('2026-10-16T09:30:00Z'));
    approveLiveIntent(typed.dir, new Date('2026-10-16T09:05:00Z'));
    const rows = intentRows(journal.root, new Date('2026-10-16T09:40:00Z'));
    expect(rows).toEqual([
      { id: expect.any(String), broker: 'Robinhood live', symbol: 'MSFT', side: 'sell', quantity: '1 at $420', from: 'rules: trim-rules', recorded_at: '2026-10-16T09:30:00.000Z', approved_at: null, state: 'pending' },
      { id: typed.intent.intent_id, broker: 'Robinhood live', symbol: 'AAPL', side: 'buy', quantity: '2', from: 'an order you typed', recorded_at: '2026-10-16T09:00:00.000Z', approved_at: '2026-10-16T09:05:00.000Z', state: 'approved' },
    ]);
    expect([sizingText({ kind: 'fixed_notional', dollars: 25 }), sizingText({ kind: 'fixed_quantity', quantity: 0.5 }), sizingText({ kind: 'percent_of_equity', share: 0.05 })]).toEqual(['$25', '0.5', '5% of equity']);
  });
});
