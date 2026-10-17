import { mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Journal, blockFromMarkdown, lineNumber, loadOperation, renderMarkdown, type DataBlock, type Packet } from '@primerkit/core';
import { FixtureConnector, PreReasonError, parseCatalog, readableBy, type ContextRequest, type MetricEntry } from '@primerkit/connector-prereason';
import { ScriptedModel } from '@primerkit/models';
import { ASK_DIR, BENCH_BRIEFINGS, DEMO_CATALOG, askBriefings, type AskEngine, type AskOutcome, type Briefings } from '../src/index';

// The three gaps of ask, on fixture questions: a metric only question, one past day, and
// the short note. Each question has its expected pick, day or note, on a scripted model:
// local (code picks by words) or hosted (the model picks, and may name a day).

const ask = loadOperation(ASK_DIR);
const catalog = parseCatalog(JSON.parse(readFileSync(DEMO_CATALOG, 'utf8')));
const TODAY = new Date('2026-10-03T12:00:00.000Z'); // a Saturday
const METRICS: MetricEntry[] = [
  { id: 'treasury-10y', name: '10-Year Treasury Yield', description: 'The 10 year US Treasury constant maturity yield (FRED)', category: 'macro' },
  { id: 'fed-funds-rate', name: 'Federal Funds Rate', description: 'The effective federal funds rate (FRED)', category: 'macro' },
  { id: 'gold-silver-ratio', name: 'Gold/Silver Ratio', description: 'Gold price over silver price, from the two ETFs', category: 'calculated' },
  { id: 'm2-supply', name: 'M2 Money Supply', description: 'US M2 money stock (FRED)', category: 'macro' },
];

// The saved briefings, read as the live connector reads them, with each read recorded: the
// day it was asked for, and the metrics read beside them.
class Recording implements Briefings {
  readonly id = 'prereason';
  readonly readsDates: boolean = true;
  readonly reads: Array<{ id: string; date: string | null }> = [];
  private readonly saved = new FixtureConnector(BENCH_BRIEFINGS);
  constructor(private readonly refuse: Record<string, PreReasonError> = {}) {}
  has(id: string): boolean {
    return this.saved.has(id);
  }
  async fetch(req: ContextRequest): Promise<DataBlock> {
    this.reads.push({ id: req.briefing, date: req.date ?? null });
    const refused = this.refuse[req.briefing];
    if (refused) throw refused;
    return this.saved.fetch(req);
  }
  async metricBlock(id: string): Promise<DataBlock> {
    this.reads.push({ id, date: null });
    const refused = this.refuse[id];
    if (refused) throw refused;
    const name = METRICS.find((m) => m.id === id)?.name ?? id;
    return blockFromMarkdown(id, `# ${name}\n\n**Latest reading:** 4.12%\n\n*Source: Sample Statistics Office | Updated: 2026-10-02T00:00:00Z | 1 day old*\n`, TODAY.toISOString());
  }
}

class Saved extends Recording {
  override readonly readsDates = false;
}
// A PreReason that also holds the company family and serves a company's briefing.
class WithCompanies extends Recording {
  override has(id: string): boolean {
    return id === 'equities.company' || super.has(id);
  }
  override async fetch(req: ContextRequest): Promise<DataBlock> {
    if (!req.briefing.startsWith('equities.company/')) return super.fetch(req);
    this.reads.push({ id: req.briefing, date: req.date ?? null });
    return blockFromMarkdown(req.briefing, '# Company briefing\n\n**Revenue:** reported for the quarter\n', TODAY.toISOString());
  }
}

// A PreReason that serves a company's briefing as it stands now only, as production did on
// 2026-10-12: one asked for a past day answers 400.
class CompaniesNowOnly extends WithCompanies {
  override async fetch(req: ContextRequest): Promise<DataBlock> {
    if (req.briefing.startsWith('equities.company/') && req.date) {
      this.reads.push({ id: req.briefing, date: req.date });
      throw new PreReasonError('PreReason answered 400', 400, null);
    }
    return super.fetch(req);
  }
}

// An answer that passes every check: one claim on the first line of the first block, with
// no number in it, and the day the packet stands as of.
function answerFor(packet: Packet, asOf: string | undefined = packet.asOf): string {
  const b = packet.blocks[0]!;
  const line = b.lines[0]!;
  return JSON.stringify({
    answer: 'The packet reads as its first line says.',
    claims: [{ text: 'The first line names what was read.', citations: [{ block: b.id, line: lineNumber(b, 0), quote: line.slice(0, Math.min(12, line.length)) }] }],
    not_in_data: ['what the question asked beyond these lines'],
    ...(asOf ? { data_as_of: asOf } : {}),
  });
}

const local = () => new ScriptedModel([(p) => answerFor(p)], { local: true, format: 'markdown' });
// A hosted model: its first reply is the pick, then it answers.
const hosted = (pick: object) => new ScriptedModel([JSON.stringify(pick), (p) => answerFor(p)], { local: false, format: 'markdown' });

function setup(model: ScriptedModel, over: Partial<AskEngine> = {}, data: Recording = new Recording()) {
  const engine: AskEngine = { operation: ask, model, data, catalog: async () => catalog, metrics: async () => METRICS, tier: 'free', now: () => TODAY, ...over };
  return { engine, data, model };
}

const answered = (o: AskOutcome) => {
  if (o.kind !== 'answer') throw new Error(`not an answer: ${JSON.stringify(o)}`);
  return o;
};
const noted = (o: AskOutcome): string => {
  if (o.kind !== 'note') throw new Error(`not a note: ${JSON.stringify(o)}`);
  return o.text;
};

describe('a metric only question', () => {
  it('reads a metric no briefing holds, by its words, as numbered lines the answer cites', async () => {
    const { engine, data } = setup(local());
    const o = answered(await askBriefings(engine, 'What is the gold silver ratio?', null));
    expect(o.result.packet.blocks[0]?.id).toBe('gold-silver-ratio');
    expect(data.reads[0]).toEqual({ id: 'gold-silver-ratio', date: null });
    expect(o.result.packet.text).toContain('Metric gold-silver-ratio (Gold/Silver Ratio), markdown, as it stands now:');
    expect(o.result.packet.text).toContain('[gold-silver-ratio L2] **Latest reading:** 4.12%');
    expect(o.view.sources[0]).toEqual({ n: 1, block: 'gold-silver-ratio', line: 1 });
    expect(o.view.briefings).toContain('gold-silver-ratio');
  });

  it('reads a fact from its own series, and names the briefing that holds what drives it', async () => {
    const { engine, data } = setup(local());
    const o = answered(await askBriefings(engine, 'What is the M2 money supply?', null));
    expect(data.reads).toEqual([{ id: 'm2-supply', date: null }]);
    expect(o.notes).toContain('Read from m2-supply alone. For what drives it and how it connects, name macro.snapshot in the question.');
    // CONTROL: a question a briefing answers whole reads the briefing, and names nothing.
    const whole = answered(await askBriefings(setup(local()).engine, 'Where does Bitcoin stand?', null));
    expect(whole.notes.join(' ')).not.toContain('For what drives');
  });

  it('reads a metric the question names by its id, beside a briefing it names', async () => {
    const { engine } = setup(local());
    const o = answered(await askBriefings(engine, 'macro.snapshot and treasury-10y: where are yields?', null));
    expect(o.result.packet.blocks.map((b) => b.id)).toEqual(['macro.snapshot', 'treasury-10y']);
  });

  it('says a short wait PreReason asks for in seconds, not "about 1 minutes"', async () => {
    const busy = new PreReasonError('PreReason asked primerkit to wait: its list of briefings takes only a few reads a minute from one address', 429, 'RATE_LIMITED', 30);
    const { engine } = setup(local(), { catalog: async () => { throw busy; } });
    const o = await askBriefings(engine, 'Where does Bitcoin stand?', null);
    expect(o).toMatchObject({ kind: 'failed', message: busy.message, detail: 'Try again in about 30 seconds.' });
  });

  it('reads a company briefing the hosted model names with its company, as its catalog line asks', async () => {
    const family = { id: 'equities.company', name: 'Company briefing', description: 'Request as equities.company/<company>.', tier: 'basic' as const };
    const model = hosted({ read: ['equities.company/NVDA'] });
    const { engine, data } = setup(model, { tier: 'basic', catalog: async () => [...catalog, family] }, new WithCompanies());
    answered(await askBriefings(engine, 'What did Nvidia report last quarter?', null));
    expect(data.reads.map((r) => r.id)).toEqual(['equities.company/nvda']);
    expect(model.calls[0]!.packet.text).toContain('equities.company: Company briefing.');
    expect(model.calls[0]!.packet.text).toContain('such as equities.company/nvda');
  });

  it("drops the model's pick of the company family alone, which names no company", async () => {
    const family = { id: 'equities.company', name: 'Company briefing', description: 'Request as equities.company/<company>.', tier: 'basic' as const };
    const model = hosted({ read: ['equities.company', 'btc.pulse'] });
    const { engine, data } = setup(model, { tier: 'basic', catalog: async () => [...catalog, family] }, new WithCompanies());
    answered(await askBriefings(engine, 'Where does Bitcoin stand?', null));
    expect(data.reads.map((r) => r.id)).toEqual(['btc.pulse']);
  });

  it('never reads a company for a key whose catalog holds no company family', async () => {
    const model = hosted({ read: ['equities.company/nvda'] });
    const { engine, data } = setup(model, {}, new WithCompanies());
    await askBriefings(engine, 'Where does Bitcoin stand?', null);
    expect(data.reads.map((r) => r.id)).not.toContain('equities.company/nvda');
  });

  it('reads a company named with its period end as it stands now, and says why', async () => {
    const family = { id: 'equities.company', name: 'Company briefing', description: 'Request as equities.company/<company>.', tier: 'basic' as const };
    const { engine, data } = setup(local(), { tier: 'basic', catalog: async () => [...catalog, family] }, new CompaniesNowOnly());
    // As the value check asked it: the quarter's end names the quarter, not a day to read on.
    const o = answered(await askBriefings(engine, 'equities.company/odfl: What was its revenue for the quarter ended June 30, 2026?', null));
    expect(data.reads).toEqual([{ id: 'equities.company/odfl', date: null }]);
    expect(o.view.asOf).toBeNull();
    expect(o.notes).toContain("Read as it stands now: Jun 30, 2026 ends the period the question asks about, and a period's figures come out after it ends. To read the briefings as they stood on a day, write as of 2026-06-30.");
  });

  it('reads a company PreReason will not serve for a past day as it stands now, in place of failing', async () => {
    const family = { id: 'equities.company', name: 'Company briefing', description: 'Request as equities.company/<company>.', tier: 'basic' as const };
    const { engine, data } = setup(local(), { tier: 'basic', catalog: async () => [...catalog, family] }, new CompaniesNowOnly());
    // "at June 30" is a day to read on; PreReason answers 400 for a company's past day.
    const o = answered(await askBriefings(engine, 'equities.company/wipro: How many shares were issued at June 30, 2026?', null));
    expect(data.reads).toEqual([
      { id: 'equities.company/wipro', date: '2026-06-30' },
      { id: 'equities.company/wipro', date: null },
    ]);
    expect(o.view.asOf).toBeNull();
    expect(o.notes).toContain('equities.company/wipro was read as it stands now: PreReason did not serve it as it stood on Jun 30, 2026.');
    // CONTROL: a briefing that is no company's, refused with a 400 for its past day though it
    // reads now, still fails as before: only a company's briefing is read now in its place.
    class DatedRefused extends Recording {
      override async fetch(req: ContextRequest): Promise<DataBlock> {
        if (req.date) throw new PreReasonError('PreReason answered 400', 400, null);
        return super.fetch(req);
      }
    }
    await expect(askBriefings(setup(local(), {}, new DatedRefused()).engine, 'macro.snapshot as of Aug 15, 2026?', null)).resolves.toMatchObject({ kind: 'failed' });
  });

  it('takes no day from the model where the question names a period', async () => {
    const family = { id: 'equities.company', name: 'Company briefing', description: 'Request as equities.company/<company>.', tier: 'basic' as const };
    // The hosted model picks the company and names the period's end as the day.
    const model = hosted({ read: ['equities.company/csgp'], date: '2026-06-30' });
    const { engine, data } = setup(model, { tier: 'basic', catalog: async () => [...catalog, family] }, new CompaniesNowOnly());
    answered(await askBriefings(engine, 'What revenue did CoStar report for the quarter ended June 30, 2026?', null));
    expect(data.reads).toEqual([{ id: 'equities.company/csgp', date: null }]);
  });

  it('reads nothing when the hosted model finds nothing that fits, and says so with the nearest', async () => {
    const model = hosted({ read: [] });
    const { engine, data } = setup(model);
    const text = noted(await askBriefings(engine, 'What did Apple report last quarter?', null));
    expect(text).toMatch(/^The model found nothing among the \d+ briefings and \d+ metrics this key reads that answers this question, so nothing was read\./);
    expect(data.reads).toEqual([]);
    expect(model.calls).toHaveLength(1);
    expect(model.calls[0]!.packet.text).toContain('Fewer is better than one that does not fit; pick none when none fits.');
  });

  it("keeps the code's pick when everything the model named is outside the list", async () => {
    const model = hosted({ read: ['made.up', 'not-a-metric-here'] });
    const { engine, data } = setup(model);
    answered(await askBriefings(engine, 'Where does Bitcoin stand?', null));
    expect(data.reads.length).toBeGreaterThan(0);
    // A reply with no list at all is no answer, so it never reads as nothing fits.
    const broken = setup(hosted({ pick: 'btc.pulse' }));
    answered(await askBriefings(broken.engine, 'Where does Bitcoin stand?', null));
    expect(broken.data.reads.length).toBeGreaterThan(0);
  });

  it('lets a hosted model pick a metric from the one catalog of briefings and metrics', async () => {
    const model = hosted({ read: ['fed-funds-rate'] });
    const { engine } = setup(model);
    const o = answered(await askBriefings(engine, 'Where is the policy rate?', null));
    expect(o.result.packet.blocks.map((b) => b.id)).toEqual(['fed-funds-rate']);
    const pick = model.calls[0]!.packet.text;
    expect(pick).toContain('fed-funds-rate: Federal Funds Rate.');
    expect(pick).toContain('btc.pulse:');
    expect(pick).toContain('Today is 2026-10-03.');
    // The question comes after the catalog, and the catalog is the start a provider may cache.
    const sent = model.calls[0]!.packet;
    expect(sent.cachePrefix).toBeGreaterThan(0);
    expect(pick.slice(0, sent.cachePrefix)).toContain('fed-funds-rate: Federal Funds Rate.');
    expect(pick.slice(sent.cachePrefix)).toMatch(/^Question: Where is the policy rate\?/);
    // The answer's own packet keeps its question first.
    expect(o.result.packet.cachePrefix).toBeUndefined();
  });

  it('names a metric the key may not read, and one PreReason has no fresh reading for, and answers from the rest', async () => {
    const data = new Recording({
      'treasury-10y': new PreReasonError("not available on this key's tier", 403, 'EARLY_ACCESS_RESTRICTED'),
      'm2-supply': new PreReasonError("Data for 'm2-supply' is critically stale", 503, 'STALE_DATA'),
    });
    const { engine } = setup(local(), {}, data);
    const o = answered(await askBriefings(engine, 'macro.snapshot, treasury-10y and m2-supply: where is money?', null));
    expect(o.skipped).toEqual(['treasury-10y']);
    expect(o.notes).toContain("m2-supply was not read: Data for 'm2-supply' is critically stale.");
    expect(o.result.packet.blocks.map((b) => b.id)).toEqual(['macro.snapshot']);
  });

  it('offers no metric where none can be read, as in the demo', async () => {
    const saved = new FixtureConnector(BENCH_BRIEFINGS);
    const { engine } = setup(local(), { data: { id: 'prereason', has: (id) => saved.has(id), fetch: (r) => saved.fetch(r) } });
    const o = answered(await askBriefings(engine, 'What is the gold silver ratio and where does bitcoin stand?', null));
    expect(o.result.packet.blocks.every((b) => b.id.includes('.'))).toBe(true);
  });
});

describe('one past day', () => {
  it('reads the briefings as they stood on the ISO day the question names, and says so', async () => {
    const { engine, data } = setup(local());
    const o = answered(await askBriefings(engine, 'macro.snapshot as of 2026-08-15: how was liquidity?', null));
    expect(data.reads).toEqual([{ id: 'macro.snapshot', date: '2026-08-15' }]);
    expect(o.result.packet.asOf).toBe('2026-08-15');
    expect(o.result.packet.text).toContain('As of: 2026-08-15. Every line below stands as it stood on that day.');
    expect(o.result.packet.text).toContain('Briefing macro.snapshot, markdown, as it stood on 2026-08-15:');
    expect(o.view.asOf).toBe('2026-08-15');
    expect(o.result.checks.map((c) => c.id)).toContain('as_of');
    expect(renderMarkdown(ask.render!, o.view)).toContain('PR · macro.snapshot · as it stood on Aug 15, 2026 ·');
    expect(renderMarkdown(ask.render!, o.view)).toContain('✓ 6 of 6 checks: answer format · claims cite their lines · figures match the lines cited · direction words cite a change · no advice words · dated the day the briefings were read for ·');
  });

  for (const [question, day] of [
    ['Where did btc.pulse stand on Aug 15, 2026?', '2026-08-15'],
    ['btc.pulse on August 15, 2026', '2026-08-15'],
    ['btc.pulse 15 August 2026', '2026-08-15'],
    ['btc.pulse on September 1', '2026-09-01'], // no year: the latest not after today
    ['btc.pulse on December 1', '2025-12-01'],
    ['btc.pulse on Sept. 30th', '2026-09-30'],
  ] as const) {
    it(`reads "${question}" as ${day}`, async () => {
      const { engine, data } = setup(local());
      const o = answered(await askBriefings(engine, question, null));
      expect(data.reads[0]).toEqual({ id: 'btc.pulse', date: day });
      expect(o.view.asOf).toBe(day);
    });
  }

  it('takes the day a hosted model names for words code never reads, held to the same rules, and says it came from the model', async () => {
    const model = hosted({ read: ['btc.pulse'], date: '2026-10-02' });
    const { engine, data } = setup(model, { journal: new Journal(mkdtempSync(join(tmpdir(), 'pk-gaps-'))) });
    const o = answered(await askBriefings(engine, 'Where did Bitcoin stand last Friday?', null));
    expect(data.reads).toEqual([{ id: 'btc.pulse', date: '2026-10-02' }]);
    expect(o.notes[0]).toBe('Read as it stood on Oct 2, 2026, the day the model took the question to ask about. To choose the day, name it, such as as of 2026-10-02.');
    const pick = JSON.parse(readFileSync(join(o.result.journalDir!, 'pick.json'), 'utf8')) as Record<string, unknown>;
    expect(pick).toMatchObject({ briefings: ['btc.pulse'], metrics: [], picked_by: 'model', date: '2026-10-02', date_from: 'model' });
    const meta = JSON.parse(readFileSync(join(o.result.journalDir!, 'meta.json'), 'utf8')) as Record<string, unknown>;
    expect(meta.not_in_data).toEqual(['what the question asked beyond these lines']);
  });

  it("puts the question's own day before the model's, and drops a model's day still to come", async () => {
    const first = setup(hosted({ read: ['btc.pulse'], date: '2026-09-01' }));
    answered(await askBriefings(first.engine, 'How was Bitcoin on 2026-08-15?', null));
    expect(first.data.reads[0]?.date).toBe('2026-08-15');
    const later = setup(hosted({ read: ['btc.pulse'], date: '2026-10-04' }));
    const o = answered(await askBriefings(later.engine, 'Where will Bitcoin stand tomorrow?', null));
    expect(later.data.reads[0]?.date).toBeNull();
    expect(o.view.asOf).toBeNull();
  });

  it("keeps a day's own words out of the word match", async () => {
    const calendar: MetricEntry = { id: 'auction-calendar', name: 'Treasury auction calendar', description: 'Auctions scheduled for Aug 2026', category: 'macro' };
    const { engine, data } = setup(local(), { metrics: async () => [...METRICS, calendar] });
    const o = answered(await askBriefings(engine, 'Where did btc.pulse stand on Aug 15, 2026?', null));
    expect(data.reads).toEqual([{ id: 'btc.pulse', date: '2026-08-15' }]);
    // Nothing joined the named briefing on the words "Aug" and "2026".
    expect(o.added).toEqual([]);
    expect(o.notes.join(' ')).not.toContain('auction-calendar');
    // CONTROL: the same words without the day do add the calendar beside the named briefing.
    const other = setup(local(), { metrics: async () => [...METRICS, calendar] });
    answered(await askBriefings(other.engine, 'Where did btc.pulse stand: the aug 2026 auctions?', null));
    expect(other.data.reads.map((r) => r.id)).toContain('auction-calendar');
  });

  it('reads now, and says how to name a day, where a local model meets words for a day', async () => {
    const { engine, data } = setup(local());
    const o = answered(await askBriefings(engine, 'Where did btc.pulse stand yesterday?', null));
    expect(data.reads[0]?.date).toBeNull();
    expect(o.view.asOf).toBeNull();
    expect(o.notes).toContain('Read as it stands now: a past day is read when the question names it, such as as of 2026-09-03.');
  });

  it("reads today's own date as now", async () => {
    const { engine, data } = setup(local());
    const o = answered(await askBriefings(engine, 'btc.pulse as of 2026-10-03', null));
    expect(data.reads[0]?.date).toBeNull();
    expect(o.result.checks.map((c) => c.id)).not.toContain('as_of');
  });

  for (const [question, says] of [
    ['How did btc.pulse change from 2026-08-01 to 2026-09-01?', 'This question names 2 days (Aug 1, 2026, Sep 1, 2026). An answer reads one day: name one, such as as of 2026-08-01. For a span of days, /chart draws a series from one date to another.'],
    ['btc.pulse as of 2026-12-01', 'Dec 1, 2026 has not come yet, so nothing was read. A briefing reads as it stood on a past day, such as as of 2026-09-03.'],
    ['btc.pulse as of 2026-02-30', '2026-02-30 is not a day on the calendar, so nothing was read. Name a real day, such as as of 2026-09-03.'],
    ['treasury-10y as of 2026-08-15', 'treasury-10y is a metric, which PreReason serves as it stands now only, so nothing was read for Aug 15, 2026. Ask about a briefing for that day, such as macro.snapshot as of 2026-08-15.'],
  ] as const) {
    it(`gives a note and reads nothing for "${question}"`, async () => {
      const { engine, data } = setup(local());
      expect(noted(await askBriefings(engine, question, null))).toBe(says);
      expect(data.reads).toEqual([]);
    });
  }

  it('drops a metric from a question about a past day and reads the briefing for it', async () => {
    const { engine, data } = setup(local());
    const o = answered(await askBriefings(engine, 'macro.snapshot and treasury-10y as of 2026-08-15', null));
    expect(data.reads).toEqual([{ id: 'macro.snapshot', date: '2026-08-15' }]);
    expect(o.notes).toContain('treasury-10y was not read: PreReason serves a metric as it stands now, not as it stood on Aug 15, 2026.');
  });

  it("shows PreReason's own words, with the window the key reads, for a day outside it", async () => {
    const refused = new PreReasonError("Date '2026-08-15' is outside your tier's access range (Free: the last 30 days)", 403, 'DATE_RESTRICTED');
    const { engine } = setup(local(), {}, new Recording({ 'macro.snapshot': refused }));
    const o = await askBriefings(engine, 'macro.snapshot as of 2026-08-15', null);
    expect(o).toEqual({ kind: 'failed', message: 'macro.snapshot could not be read for Aug 15, 2026.', detail: "PreReason says: Date '2026-08-15' is outside your tier's access range (Free: the last 30 days)." });
  });

  it('says the saved briefings are one day, rather than pass them off as another', async () => {
    const { engine, data } = setup(local(), {}, new Saved());
    expect(noted(await askBriefings(engine, 'btc.pulse as of 2026-08-15', null))).toBe('These briefings are one saved day, so Aug 15, 2026 cannot be read here. With a key, primerkit reads a briefing as it stood on a past day.');
    expect(data.reads).toEqual([]);
  });

  it('holds data_as_of to the day: a wrong day gets one repair, and still wrong, the answer is not shown', async () => {
    const wrong = new ScriptedModel([(p) => answerFor(p, '2026-10-03')], { local: true, format: 'markdown' });
    const { engine } = setup(wrong);
    const o = await askBriefings(engine, 'macro.snapshot as of 2026-08-15', null);
    expect(o.kind).toBe('failed');
    expect(wrong.calls).toHaveLength(2);
    expect(wrong.calls[1]?.repair?.map((f) => f.message)).toEqual(['data_as_of must be 2026-08-15, the day this packet was read for, not 2026-10-03']);
    // CONTROL: the same answer read as now passes; as_of asks nothing of it.
    const now = setup(new ScriptedModel([(p) => answerFor(p, '2026-10-03')], { local: true, format: 'markdown' }));
    expect((await askBriefings(now.engine, 'macro.snapshot: how is liquidity?', null)).kind).toBe('answer');
  });
});

describe('the note when nothing matched', () => {
  it('is short however long the catalog is, and says where the whole list is', async () => {
    const many: MetricEntry[] = Array.from({ length: 150 }, (_, i) => ({ id: `metric-${i}`, name: `Metric ${i}`, description: 'a reading of something else entirely', category: 'macro' }));
    const { engine } = setup(local(), { metrics: async () => many });
    const text = noted(await askBriefings(engine, 'What is a good pasta recipe?', null));
    const free = readableBy(catalog, 'free').filter((b) => new FixtureConnector(BENCH_BRIEFINGS).has(b.id));
    expect(text).toBe(`No briefing or metric matched the words of this question. Name one in it, such as ${free[0]!.id}; /catalog lists the ${free.length} briefings and 150 metrics this key reads.`);
    expect(text.length).toBeLessThan(220);
  });

  it('names the few nearest by the same words where there are some', async () => {
    const { engine } = setup(local());
    const text = noted(await askBriefings(engine, 'Liquidities?', null));
    expect(text).toMatch(/^No briefing or metric matched the words of this question\. Nearest: [a-z0-9., -]+\. Name one in the question, such as [a-z0-9.-]+; \/catalog lists the \d+ briefings and 4 metrics this key reads\.$/);
    expect(text).toContain('macro.snapshot');
    expect(text.split('Nearest: ')[1]!.split('. Name')[0]!.split(', ').length).toBeLessThanOrEqual(5);
  });

  it('names the command where the ask runs from a terminal', async () => {
    const { engine } = setup(local(), { hints: { catalog: 'primerkit catalog', chart: 'primerkit chart' } });
    expect(noted(await askBriefings(engine, 'What is a good pasta recipe?', null))).toContain('; primerkit catalog lists');
  });
});

describe('the journal', () => {
  it('keeps what was read, who picked it and the day, and what the answer said was missing', async () => {
    const root = mkdtempSync(join(tmpdir(), 'pk-gaps-'));
    const { engine } = setup(local(), { journal: new Journal(root) });
    const o = answered(await askBriefings(engine, 'What is the gold silver ratio?', null));
    const files = readdirSync(o.result.journalDir!);
    expect(files).toContain('pick.json');
    const pick = JSON.parse(readFileSync(join(o.result.journalDir!, 'pick.json'), 'utf8')) as Record<string, unknown>;
    expect(pick).toMatchObject({ metrics: ['gold-silver-ratio'], picked_by: 'word match', date: null, date_from: null });
  });
});

describe('a packet too big to send', () => {
  const failedWith = (o: AskOutcome) => {
    if (o.kind !== 'failed') throw new Error(`not a failure: ${JSON.stringify(o)}`);
    return o;
  };

  it("names the operation's cap, not the model's context, when the cap is what the packet is over", async () => {
    const capped = { ...ask, spec: { ...ask.spec, data: { ...ask.spec.data, maxPacketTokens: 500 } } };
    const model = new ScriptedModel([(p) => answerFor(p)], { local: true, format: 'markdown', contextTokens: 200_000 });
    const { engine } = setup(model, { operation: capped });
    const o = failedWith(await askBriefings(engine, 'macro.snapshot: where are yields?', null));
    expect(o.message).toBe("The packet is over the ask operation's cap.");
    expect(o.detail).toMatch(/^Even cut down, it is [\d,]+ tokens, and the ask operation sends at most 500 tokens a packet\.$/);
    expect(model.calls).toHaveLength(0);
  });

  it("names the model's context when that is what the packet is over", async () => {
    const model = new ScriptedModel([(p) => answerFor(p)], { local: true, format: 'markdown', contextTokens: 1500 });
    const { engine } = setup(model);
    const o = failedWith(await askBriefings(engine, 'macro.snapshot: where are yields?', null));
    expect(o.message).toBe('The packet does not fit this model.');
    expect(o.detail).toMatch(/^Even cut down, it needs [\d,]+ tokens of context, and scripted test model has 1,500 tokens of context\.$/);
    expect(model.calls).toHaveLength(0);
  });
});

describe("a company's figures over several periods", () => {
  // A PreReason that serves the numbers block with statement history at the company's door,
  // or answers that it holds none yet for this company.
  class WithHistory extends WithCompanies {
    readonly readsHistory: boolean = true;
    readonly historyReads: string[] = [];
    constructor(private readonly covered = true) {
      super();
    }
    override async fetch(req: ContextRequest): Promise<DataBlock> {
      if (!req.history) return super.fetch(req);
      this.historyReads.push(req.briefing);
      if (!this.covered) throw new PreReasonError('statement history is not covered yet for this company', 404, 'HISTORY_NOT_COVERED_YET');
      return blockFromMarkdown(req.briefing, '## FICTIONAL GROUP CORP\n\n## Statement history\n\n### Quarters\n\n| Quarter ended | Net income |\n| --- | --- |\n| 2026-06-30 | $21,155M |\n| 2026-03-31 | $16,494M |\n', TODAY.toISOString());
    }
  }
  const family = { id: 'equities.company', name: 'Company briefing', description: 'Request as equities.company/<company>.', tier: 'basic' as const };
  const SERIES = 'equities.company/fxmp: what was its net income in each of its last eight quarters?';

  it('reads the statement history in place of the whole briefing, and says so in the packet and the journal', async () => {
    const data = new WithHistory();
    const root = mkdtempSync(join(tmpdir(), 'pk-history-'));
    const { engine } = setup(local(), { tier: 'basic', catalog: async () => [...catalog, family], journal: new Journal(root) }, data);
    const o = answered(await askBriefings(engine, SERIES, null));
    expect(data.historyReads).toEqual(['equities.company/fxmp']);
    expect(data.reads).toEqual([]);
    expect(o.result.packet.text).toContain('Company briefing equities.company/fxmp, its numbers block with statement history (quarters and fiscal years), markdown, as it stands now:');
    expect(o.result.packet.text).toContain('| 2026-03-31 | $16,494M |');
    const pick = JSON.parse(readFileSync(join(o.result.journalDir!, 'pick.json'), 'utf8')) as Record<string, unknown>;
    expect(pick.statement_history).toEqual(['equities.company/fxmp']);
  });

  it('reads the whole briefing where PreReason holds no history for the company yet, and says why', async () => {
    const data = new WithHistory(false);
    const { engine } = setup(local(), { tier: 'basic', catalog: async () => [...catalog, family] }, data);
    const o = answered(await askBriefings(engine, SERIES, null));
    expect(data.historyReads).toEqual(['equities.company/fxmp']);
    expect(data.reads.map((r) => r.id)).toEqual(['equities.company/fxmp']);
    expect(o.notes).toContain('equities.company/fxmp: PreReason holds no statement history for this company yet, so its whole briefing was read, which gives its latest period.');
  });

  it('reads the whole briefing for a question about one period, and where history cannot be read', async () => {
    const data = new WithHistory();
    const { engine } = setup(local(), { tier: 'basic', catalog: async () => [...catalog, family] }, data);
    answered(await askBriefings(engine, 'equities.company/fxmp: what did it report last quarter?', null));
    expect(data.historyReads).toEqual([]);
    expect(data.reads.map((r) => r.id)).toEqual(['equities.company/fxmp']);
    // Saved briefings, as in the demo, read no history.
    const saved = new WithCompanies();
    const plain = setup(local(), { tier: 'basic', catalog: async () => [...catalog, family] }, saved).engine;
    answered(await askBriefings(plain, SERIES, null));
    expect(saved.reads.map((r) => r.id)).toEqual(['equities.company/fxmp']);
  });
});

describe('the note under an answer that failed', () => {
  it('names a field the format does not allow, so a person sees a trade field was refused', async () => {
    const failedWith = async (extra: Record<string, unknown>) => {
      const model = new ScriptedModel([(p) => JSON.stringify({ ...(JSON.parse(answerFor(p)) as object), ...extra })], { local: true, format: 'markdown' });
      const o = await askBriefings(setup(model).engine, 'macro.snapshot: how is liquidity?', null);
      if (o.kind !== 'failed') throw new Error(`not failed: ${o.kind}`);
      return o;
    };
    // What the screen shows, and what primerkit ask prints after its message.
    expect(await failedWith({ action: 'buy' })).toEqual({ kind: 'failed', message: 'The answer did not pass its checks, so it is not shown.', detail: 'It failed on: the response holds a field its format does not allow: action' });
    expect((await failedWith({ action: 'buy', size: 0.5 })).detail).toBe('It failed on: the response holds fields its format does not allow: action, size');
  });
});

// The request check of 2026-10-15 (row E6): "PreReason could not be reached. the catalog
// answered 503" said the reason as a second sentence in lower case.
describe('a reason said after one of ours', () => {
  it('says why PreReason could not be reached as a sentence of its own', async () => {
    const { engine } = setup(local(), { catalog: async () => { throw new Error('the catalog answered 503'); } });
    expect(await askBriefings(engine, 'Where does Bitcoin stand?', null)).toEqual({ kind: 'failed', message: 'PreReason could not be reached.', detail: 'The catalog answered 503.' });
  });

  it('says why the model could not be reached as a sentence of its own, with one full stop', async () => {
    const down = (reason: string) => new ScriptedModel([() => { throw new Error(reason); }], { local: true, format: 'markdown' });
    expect(await askBriefings(setup(down('connect ECONNREFUSED 127.0.0.1:11434')).engine, 'Where does Bitcoin stand?', null)).toEqual({ kind: 'failed', message: 'The model could not be reached.', detail: 'Is it running? Connect ECONNREFUSED 127.0.0.1:11434.' });
    expect(await askBriefings(setup(down('fetch failed.')).engine, 'Where does Bitcoin stand?', null)).toMatchObject({ detail: 'Is it running? Fetch failed.' });
  });
});
