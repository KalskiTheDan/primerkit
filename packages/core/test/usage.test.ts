import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  Journal,
  LIVE_INTENT_OPERATION,
  approveLiveIntent,
  blockFromMarkdown,
  costOf,
  findLiveIntent,
  journalEntries,
  journalSummary,
  listLiveIntents,
  liveIntentProblems,
  loadOperation,
  noUsage,
  readLiveIntent,
  recordLiveIntent,
  runOperation,
  type ModelAdapter,
  type ModelCapabilities,
  type ModelReply,
  type TokenPrice,
} from '../src/index';

const here = dirname(fileURLToPath(import.meta.url));
const ASK = loadOperation(join(here, '..', '..', '..', 'operations', 'ask'));
const FIXTURES = join(here, '..', '..', '..', 'operations', 'bench-comprehension', 'briefings-2026-09-25');
const PULSE = blockFromMarkdown('btc.pulse', readFileSync(join(FIXTURES, 'btc.pulse.md'), 'utf8'), '2026-09-25T09:06:00.000Z');
const GOOD = JSON.stringify({
  answer: 'Bitcoin is at $84,512.32, up 10.6% over 7 days.',
  claims: [{ text: 'Bitcoin is at $84,512.32, up 10.6% over 7 days.', citations: [{ block: 'btc.pulse', line: 7, quote: 'BTC at $84,512.32, up 10.6% over 7d.' }] }],
  not_in_data: [],
});
const BAD = JSON.stringify({ answer: 'Bitcoin is at $90,000.', claims: [{ text: 'Bitcoin is at $90,000.', citations: [{ block: 'btc.pulse', line: 7, quote: 'BTC at $90,000' }] }], not_in_data: [] });

// A model that reports its usage, as a hosted runtime does, at a price primerkit knows.
class Metered implements ModelAdapter {
  readonly id = 'anthropic:claude-test';
  readonly label = 'metered';
  private turn = 0;
  constructor(
    private readonly texts: string[],
    readonly price: TokenPrice | null,
    private readonly local = false,
    private readonly usage: ModelReply['usage'] | null = { inputTokens: 1000, outputTokens: 200, cacheReadTokens: 500, cacheWriteTokens: 0 },
  ) {}
  async capabilities(): Promise<ModelCapabilities> {
    return { local: this.local, schemaConstraint: false, contextTokens: null, canRaiseContext: false, format: 'markdown' };
  }
  async complete(): Promise<ModelReply> {
    const text = this.texts[Math.min(this.turn++, this.texts.length - 1)] ?? '';
    return { text, ...(this.usage ? { usage: this.usage } : {}) };
  }
}

const PRICE: TokenPrice = { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 };
const home = () => mkdtempSync(join(tmpdir(), 'pk-usage-'));

describe('real usage and cost in the journal', () => {
  it('keeps the tokens the model reported and their cost at list price, beside the packet count', async () => {
    const journal = new Journal(join(home(), 'journal'));
    const result = await runOperation({ operation: ASK, question: 'Where does Bitcoin stand?', blocks: [PULSE], model: new Metered([GOOD], PRICE), journal, now: () => new Date('2026-10-16T09:00:00Z') });
    expect(result.outcome).toBe('passed');
    expect(result.usage).toEqual({ inputTokens: 1000, outputTokens: 200, cacheReadTokens: 500, cacheWriteTokens: 0, reported: true });
    // 1000 × $4 + 200 × $20 + 500 × $0.20, a million tokens each.
    expect(result.cost).toEqual({ usd: 0.0081, basis: 'list price' });
    const meta = JSON.parse(readFileSync(join(result.journalDir!, 'meta.json'), 'utf8'));
    expect(meta.usage).toMatchObject({ inputTokens: 1000, outputTokens: 200, reported: true });
    expect(meta.cost).toEqual({ usd: 0.0081, basis: 'list price' });
    expect(meta.tokens.count).toBe(result.packet.tokens.count);
  });

  it('sums a repair turn into the run, names no cost without a price, and none at all for a local model', async () => {
    const repaired = await runOperation({ operation: ASK, question: 'Where does Bitcoin stand?', blocks: [PULSE], model: new Metered([BAD, GOOD], null) });
    expect(repaired.attempts).toBe(2);
    expect(repaired.usage).toMatchObject({ inputTokens: 2000, outputTokens: 400, reported: true });
    expect(repaired.cost).toBeNull();
    const local = await runOperation({ operation: ASK, question: 'Where does Bitcoin stand?', blocks: [PULSE], model: new Metered([GOOD], null, true) });
    expect(local.cost).toEqual({ usd: 0, basis: 'local' });
    // A runtime that reported nothing is never priced from a guess.
    const silent = await runOperation({ operation: ASK, question: 'Where does Bitcoin stand?', blocks: [PULSE], model: new Metered([GOOD], PRICE, false, null) });
    expect(silent.usage).toEqual(noUsage());
    expect(silent.cost).toBeNull();
    expect(costOf(noUsage(), PRICE, false)).toBeNull();
  });

  it('reads the runs back and sums each day, counting the runs with no price apart', async () => {
    const journal = new Journal(join(home(), 'journal'));
    await runOperation({ operation: ASK, question: 'Where does Bitcoin stand?', blocks: [PULSE], model: new Metered([GOOD], PRICE), journal, now: () => new Date('2026-10-16T09:00:00Z') });
    await runOperation({ operation: ASK, question: 'Where does Bitcoin stand?', blocks: [PULSE], model: new Metered([GOOD], null), journal, now: () => new Date('2026-10-16T10:00:00Z') });
    await runOperation({ operation: ASK, question: 'Where does Bitcoin stand?', blocks: [PULSE], model: new Metered([GOOD], PRICE), journal, now: () => new Date('2026-10-15T10:00:00Z') });
    // An order intent's folder holds no meta.json, and is not a run.
    recordLiveIntent(journal, { symbol: 'AAPL', side: 'buy', quantity: 1, source: 'typed' }, new Date('2026-10-16T11:00:00Z'));
    const entries = journalEntries(journal.root);
    expect(entries.map((e) => e.day)).toEqual(['2026-10-16', '2026-10-16', '2026-10-15']);
    expect(entries[0]).toMatchObject({ operation: 'ask', outcome: 'passed', tokens: { input: 1000, output: 200 } });
    const days = journalSummary(journal.root);
    expect(days[0]).toMatchObject({ day: '2026-10-16', runs: 2, outcomes: { passed: 2 }, tokens: { input: 2000, output: 400, reported_runs: 2 }, cost: { usd: 0.0081, priced_runs: 1, unpriced_runs: 1 } });
    expect(days[1]).toMatchObject({ day: '2026-10-15', runs: 1 });
    expect(journalSummary(journal.root, { days: 1 })).toHaveLength(1);
    // A run kept before usage was journaled reads as reporting none.
    const old = join(journal.root, '2026-10-14', 'ask', '20261014T090000Z-aaaaaa');
    journal.open('ask', '20261014T090000Z-aaaaaa', new Date('2026-10-14T09:00:00Z'));
    writeFileSync(join(old, 'meta.json'), JSON.stringify({ runId: '20261014T090000Z-aaaaaa', outcome: 'passed', model: 'x', tokens: { label: 'o200k', count: 900 } }));
    expect(journalEntries(journal.root, { day: '2026-10-14' })[0]).toMatchObject({ tokens: { packet: 900, input: null, output: null }, cost: null });
  });
});

describe('live order intents', () => {
  it('names every problem with an intent, and keeps none of them', () => {
    expect(liveIntentProblems({ symbol: 'AAPL', side: 'buy', quantity: 2, source: 'typed' })).toEqual([]);
    expect(liveIntentProblems({ symbol: 'aapl', side: 'buy', quantity: 2, source: 'rules', rules: 'my-rules', order_type: 'limit', limit_price: 190.5 })).toEqual([]);
    const problems = liveIntentProblems({ symbol: '1X', side: 'hold', quantity: -1, source: 'model', order_type: 'stop' });
    expect(problems.map((p) => p.split(':')[0])).toEqual(['symbol', 'side', 'quantity', 'order_type', 'source']);
    expect(liveIntentProblems({ symbol: 'AAPL', side: 'buy', quantity: 1, source: 'rules' })).toEqual(['rules: the name of the rules the order came from']);
    expect(liveIntentProblems({ symbol: 'AAPL', side: 'buy', quantity: 1, source: 'typed', order_type: 'limit' })[0]).toMatch(/^limit_price/);
    expect(liveIntentProblems({ broker: 'alpaca', symbol: 'AAPL', side: 'buy', quantity: 1, source: 'typed' })[0]).toMatch(/^broker/);
    const journal = new Journal(join(home(), 'journal'));
    expect(() => recordLiveIntent(journal, { symbol: 'AAPL', side: 'buy', quantity: 0, source: 'typed' })).toThrow(/was not kept: quantity/);
    expect(existsSync(journal.root)).toBe(false);
  });

  it('keeps an intent as pending, approves it once on the yes, and never after it expires', () => {
    const journal = new Journal(join(home(), 'journal'));
    const at = new Date('2026-10-16T09:00:00Z');
    // A run id an app sends anyway is not kept: an intent carries no link to a PreReason answer.
    const sent = { symbol: 'msft', side: 'sell', quantity: 1.5, source: 'typed', run_id: '20261016T085900Z-abcdef' };
    const kept = recordLiveIntent(journal, sent, at);
    expect(kept.intent).not.toHaveProperty('run_id');
    expect(readFileSync(join(kept.dir, 'intent.json'), 'utf8')).not.toContain('run_id');
    expect(kept.state).toBe('pending');
    expect(kept.intent).toMatchObject({ symbol: 'MSFT', side: 'sell', quantity: 1.5, order_type: 'market', limit_price: null, broker: 'robinhood', source: { kind: 'typed' }, expires_at: '2026-10-16T10:00:00.000Z' });
    expect(kept.dir).toBe(join(journal.root, '2026-10-16', LIVE_INTENT_OPERATION, kept.intent.intent_id));
    const dir = findLiveIntent(journal.root, kept.intent.intent_id)!;
    expect(dir).toBe(kept.dir);
    expect(findLiveIntent(journal.root, '../etc')).toBeNull();
    const approved = approveLiveIntent(dir, new Date('2026-10-16T09:10:00Z'));
    expect(approved.state).toBe('approved');
    expect(approved.approval).toEqual({ approved_at: '2026-10-16T09:10:00.000Z', by: 'a yes typed at a terminal' });
    expect(() => approveLiveIntent(dir, new Date('2026-10-16T09:11:00Z'))).toThrow(/approved already/);
    expect(readLiveIntent(dir, new Date('2026-10-16T10:00:00Z')).state).toBe('expired');
    const late = recordLiveIntent(journal, { symbol: 'AAPL', side: 'buy', quantity: 1, source: 'typed' }, at);
    expect(() => approveLiveIntent(late.dir, new Date('2026-10-16T10:30:00Z'))).toThrow(/expired at 10:00 UTC/);
    expect(existsSync(join(late.dir, 'approval.json'))).toBe(false);
    expect(listLiveIntents(journal.root, new Date('2026-10-16T09:30:00Z')).map((r) => r.state).sort()).toEqual(['approved', 'pending']);
  });
});
