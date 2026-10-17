import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Snapshots, blockFromMarkdown, companyMarket, lineNumber, loadOperation, type DataBlock, type Packet } from '@primerkit/core';
import { FixtureConnector, PreReasonClient, parseCatalog, type CatalogEntry, type ContextRequest, type MetricEntry, type Tier } from '@primerkit/connector-prereason';
import { ScriptedModel } from '@primerkit/models';
import { ASK_DIR, BENCH_BRIEFINGS, DEMO_CATALOG, askBriefings, collectDigest, type AskEngine, type AskOutcome, type Briefings } from '../src/index';

// A free key, as the full run of 2026-10-14 met it: a direction question read a bare metric
// while a free briefing held the change, a company named by its code was dropped without a
// word, and a rate limit did not say how long it lasts.

const ask = loadOperation(ASK_DIR);
const catalog = parseCatalog(JSON.parse(readFileSync(DEMO_CATALOG, 'utf8')));
// The company family, as PreReason's catalog lists it: read with a company in its id.
const FAMILY: CatalogEntry = { id: 'equities.company', name: 'Company briefing', description: 'Request as equities.company/<company>.', tier: 'basic' };
const TODAY = new Date('2026-10-14T10:00:00.000Z');
const METRICS: MetricEntry[] = [{ id: 'net-liquidity', name: 'Net Liquidity', description: 'Net liquidity proxy - Fed balance sheet minus reverse repo and Treasury account balances', category: 'macro' }];

// Keys are built here, never written out, and are not real keys.
const fakeKey = (tag: string) => `pr_test_${tag.repeat(20)}`;

// The saved briefings, read as the live connector reads them, each read recorded, and a
// metric read as a free key is served it: its latest reading alone.
class Recording implements Briefings {
  readonly id = 'prereason';
  readonly readsDates = true;
  readonly reads: string[] = [];
  private readonly saved = new FixtureConnector(BENCH_BRIEFINGS);
  async fetch(req: ContextRequest): Promise<DataBlock> {
    this.reads.push(req.briefing);
    return this.saved.fetch(req);
  }
  async metricBlock(id: string): Promise<DataBlock> {
    this.reads.push(id);
    return blockFromMarkdown(id, `# Net Liquidity\n\n**Latest reading:** $5.87T\n\nA free key reads the latest reading of this metric.\n`, TODAY.toISOString());
  }
}

// PreReason as a fetch that counts every call and answers each with `answer`.
function counted(answer: () => Response = () => new Response('{}', { status: 500 })) {
  const calls: string[] = [];
  const impl = (async (input: string | URL | Request) => {
    calls.push(String(input));
    return answer();
  }) as typeof fetch;
  return { calls, data: new PreReasonClient({ key: fakeKey('f'), version: '0.1.0', fetch: impl, now: () => TODAY }) };
}

// An answer that passes every check: one claim on the first line of the first block.
function answerFor(packet: Packet): string {
  const b = packet.blocks[0]!;
  const line = b.lines[0]!;
  return JSON.stringify({
    answer: 'The packet reads as its first line says.',
    claims: [{ text: 'The first line names what was read.', citations: [{ block: b.id, line: lineNumber(b, 0), quote: line.slice(0, Math.min(12, line.length)) }] }],
    not_in_data: [],
  });
}
const local = () => new ScriptedModel([(p) => answerFor(p)], { local: true, format: 'markdown' });
const hosted = () => new ScriptedModel([JSON.stringify({ read: ['equities.company/aapl'] }), (p) => answerFor(p)], { local: false, format: 'markdown' });

const engineOf = (model: ScriptedModel, data: Briefings, tier: Tier | null, over: Partial<AskEngine> = {}): AskEngine => ({
  operation: ask,
  model,
  data,
  catalog: async () => [...catalog, FAMILY],
  metrics: async () => METRICS,
  tier,
  now: () => TODAY,
  ...over,
});
const noted = (o: AskOutcome): string => {
  if (o.kind !== 'note') throw new Error(`not a note: ${JSON.stringify(o)}`);
  return o.text;
};
const FREE_READS = 'btc.quick-check, btc.context, macro.snapshot, cross.correlations, btc.pulse, btc.grid-stress';

describe('a direction question on a free key', () => {
  it('reads the free briefing that holds the change, and says why, where it read the bare metric', async () => {
    const data = new Recording();
    const o = await askBriefings(engineOf(local(), data, 'free'), 'Is net liquidity rising or falling?', null);
    if (o.kind !== 'answer') throw new Error(JSON.stringify(o));
    expect(data.reads).toEqual(['macro.snapshot']);
    expect(o.notes).toContain('net-liquidity was read in macro.snapshot, which carries its changes: on a Free key, a metric read on its own is its latest reading alone.');
    expect(o.notes.join(' ')).not.toContain('btc.quick-check');
    // CONTROL: a basic key is served the metric's changes, and reads its own series.
    const basic = new Recording();
    await askBriefings(engineOf(local(), basic, 'basic'), 'Is net liquidity rising or falling?', null);
    expect(basic.reads).toEqual(['net-liquidity']);
  });
});

describe('a company named by its code, on a key that does not read company briefings', () => {
  it('stops before any call, with the tier its market needs and what the key reads', async () => {
    const { calls, data } = counted();
    const model = local();
    const o = await askBriefings(engineOf(model, data, 'free'), 'equities.company/aapl: revenue in each of its last 8 quarters?', null);
    expect(noted(o)).toBe(`A USA company's briefing needs a Basic key or above. Your Free key reads: ${FREE_READS}.`);
    expect(calls).toHaveLength(0);
    expect(model.calls).toHaveLength(0);
    // A hosted model is not asked to pick either.
    const pick = hosted();
    noted(await askBriefings(engineOf(pick, data, 'free'), 'What did equities.company/aapl earn last quarter?', null));
    expect([calls.length, pick.calls.length]).toEqual([0, 0]);
    // CONTROL: a basic key reads the company it names.
    const basic = counted(() => new Response('# Company briefing\n\n**Revenue:** reported for the quarter\n', { status: 200 }));
    await askBriefings(engineOf(local(), basic.data, 'basic'), 'equities.company/aapl: what was its latest revenue?', null);
    expect(basic.calls.some((u) => u.includes('equities.company%2Faapl') || u.includes('equities.company/aapl'))).toBe(true);
  });

  it("says each market's tier: a USA company's, a Japanese, Korean or Indian company's, and both where the code's shape does not say", async () => {
    // As PreReason serves them: a USA company's briefing on Basic and above, a Japanese,
    // Korean or Indian company's on Pro and above.
    const { calls, data } = counted();
    const say = async (q: string, tier: Tier | null = 'free') => noted(await askBriefings(engineOf(local(), data, tier), q, null));
    expect(await say('equities.company/brk-b: latest revenue?')).toBe(`A USA company's briefing needs a Basic key or above. Your Free key reads: ${FREE_READS}.`);
    expect(await say('equities.company/ine018a01030: latest revenue?')).toBe(`A Japanese, Korean or Indian company's briefing needs a Pro key or above. Your Free key reads: ${FREE_READS}.`);
    const both = `A USA company's briefing needs a Basic key or above; a Japanese, Korean or Indian company's needs a Pro key. Your Free key reads: ${FREE_READS}.`;
    expect(await say('equities.company/7203: latest revenue?')).toBe(both);
    expect(await say('equities.company/005930: latest revenue?')).toBe(both);
    expect(await say('equities.company/0000320193: latest revenue?')).toBe(both);
    expect(await say('Compare equities.company/nvda and equities.company/ine018a01030.')).toBe(both);
    expect(await say('equities.company/nvda: latest revenue?', null)).toBe(`A USA company's briefing needs a Basic key or above. Read as a Free key until PreReason names its tier, this key reads: ${FREE_READS}.`);
    expect(calls).toHaveLength(0);
    // The shapes: letters alone a US ticker, an ISIN that starts with IN an Indian company's,
    // digits alone not known (a CIK, a Japanese or a Korean code).
    expect(['nvda', 'brk-b', 'brk.b', 'ine018a01030', '7203', '005930', '0000320193', '130a'].map(companyMarket)).toEqual(['usa', 'usa', 'usa', 'india', null, null, null, null]);
  });
});

describe('a rate limit in the digest', () => {
  it('says how long to wait', async () => {
    const { data } = counted(() => new Response(JSON.stringify({ code: 'RATE_LIMIT_EXCEEDED', message: 'Daily limit reached' }), { status: 429, headers: { 'retry-after': '120' } }));
    const home = mkdtempSync(join(tmpdir(), 'pk-free-digest-'));
    const error = await collectDigest({ data, snapshots: new Snapshots(join(home, 'snapshots')), home, now: () => TODAY }, { watchlist: ['macro.snapshot'] }).catch((e: unknown) => e as Error);
    expect((error as Error).message).toBe("none of the watchlist could be read (macro.snapshot could not be read: PreReason's daily rate limit for this account is reached. Try again in about 2 minutes)");
  });

  it('says a few minutes on the ask, where PreReason sends no wait', async () => {
    const { data } = counted(() => new Response('{}', { status: 429 }));
    const o = await askBriefings(engineOf(local(), data, 'free'), 'macro.snapshot: where do yields stand?', null);
    expect(o).toEqual({ kind: 'failed', message: "PreReason's rate limit for this account is reached", detail: 'Try again in a few minutes.' });
  });
});
