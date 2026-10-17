import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Journal, Snapshots, blockFromMarkdown, loadOperation, readConfig, writeConfig, type DataBlock, type Packet } from '@primerkit/core';
import { FixtureConnector, NewsError, parseCatalog, parseNews, type ContextRequest, type NewsAnswer, type NewsQuery } from '@primerkit/connector-prereason';
import { ExtractiveModel, ScriptedModel, repairMessage } from '@primerkit/models';
import { maker, type Line } from '@primerkit/ui';
import {
  ASK_DIR,
  BENCH_BRIEFINGS,
  DEMO_CATALOG,
  DEMO_NEWS,
  DIGEST_DIR,
  GRID,
  NAME_THE_COMPANY,
  ROOT,
  Session,
  askBriefings,
  digestEntry,
  emptyLines,
  entryLines,
  initialState,
  journalOpen,
  journalRows,
  newsCredit,
  newsRead,
  noneLine,
  pickPacket,
  readLatestDigest,
  recordLine,
  screen,
  sideLines,
  type AskEngine,
  type AskOutcome,
  type Briefings,
  type Entry,
  type Key,
  type SessionDeps,
} from '../src/index';

// PrimerKit reading PreReason's news door: which questions read it, the window each names,
// the records as one block of numbered lines under the ask's own checks, and every word the
// screen says of it, from fixtures shaped as PreReason serves the answer. No key, no model,
// nothing sent anywhere.

const ask = loadOperation(ASK_DIR);
const catalog = parseCatalog(JSON.parse(readFileSync(DEMO_CATALOG, 'utf8')));
const NEWS = join(ROOT, 'packages', 'connectors', 'prereason', 'test', 'fixtures', 'news');
const served = (name: string, change: (body: Record<string, unknown>) => void = () => {}): NewsAnswer => {
  const body = JSON.parse(readFileSync(join(NEWS, name), 'utf8')) as Record<string, unknown>;
  change(body);
  return parseNews(JSON.stringify(body))!;
};
const FILED = 'filed-fxmp-2026-10-09.json';
const EMPTY = 'filed-fxmp-empty-2026-10-09.json';
const OFFICIAL = 'official-2026-10-09.json';
const NOW = new Date('2026-10-12T14:02:00.000Z');

// A PreReason that serves one news answer, or refuses, and records every read: the news
// asked for, and any briefing or metric read beside it.
class Newsroom implements Briefings {
  readonly id = 'prereason';
  readonly readsDates = true;
  readonly asked: NewsQuery[] = [];
  readonly reads: string[] = [];
  private readonly saved = new FixtureConnector(BENCH_BRIEFINGS);
  constructor(private readonly answer: NewsAnswer | Error = served(FILED)) {}
  has(id: string): boolean {
    return this.saved.has(id);
  }
  async fetch(req: ContextRequest): Promise<DataBlock> {
    this.reads.push(req.briefing);
    if (req.briefing.startsWith('equities.company/')) return blockFromMarkdown(req.briefing, '# Company briefing\n\n**Close:** 61.20 (+4.1%)\n', NOW.toISOString());
    return this.saved.fetch(req);
  }
  async metricBlock(id: string): Promise<DataBlock> {
    this.reads.push(id);
    return blockFromMarkdown(id, `# ${id}\n\n**Latest reading:** 4.12%\n`, NOW.toISOString());
  }
  async news(query: NewsQuery): Promise<NewsAnswer> {
    this.asked.push(query);
    if (this.answer instanceof Error) throw this.answer;
    return this.answer;
  }
}

// The same PreReason, whose catalog holds the company family too.
class NewsroomWithCompanies extends Newsroom {
  override has(id: string): boolean {
    return id === 'equities.company' || super.has(id);
  }
}

// An answer citing the record that holds item 2.02, [news L3], in the words of its line.
const cites = (claims: Array<{ text: string; line: number; quote: string }>, answer = 'Fictional Group Corp reported item 2.02, results of operations, in an 8-K filed on Oct 1, 2026.') =>
  JSON.stringify({ answer, claims: claims.map((c) => ({ text: c.text, citations: [{ block: 'news', line: c.line, quote: c.quote }] })), not_in_data: [] });
const ITEM_202 = { text: 'Fictional Group Corp filed an 8-K on Oct 1, 2026 reporting item 2.02, results of operations.', line: 3, quote: '8-K item 2.02, results of operations' };
const local = (...texts: Array<string | ((p: Packet) => string)>) => new ScriptedModel(texts.length ? texts : [cites([ITEM_202])], { local: true, format: 'markdown' });
const hosted = (pick: object, ...texts: string[]) => new ScriptedModel([JSON.stringify(pick), ...(texts.length ? texts : [cites([ITEM_202])])], { local: false, format: 'markdown' });

function setup(model: ScriptedModel, data: Briefings = new Newsroom(), over: Partial<AskEngine> = {}) {
  let catalogReads = 0;
  const engine: AskEngine = {
    operation: ask,
    model,
    data,
    catalog: async () => {
      catalogReads += 1;
      return catalog;
    },
    metrics: async () => [],
    tier: 'free',
    now: () => NOW,
    ...over,
  };
  return { engine, model, data, catalogReads: () => catalogReads };
}

const answered = (o: AskOutcome) => {
  if (o.kind !== 'answer') throw new Error(`not an answer: ${JSON.stringify(o)}`);
  return o;
};
const noted = (o: AskOutcome): string => {
  if (o.kind !== 'note') throw new Error(`not a note: ${JSON.stringify(o)}`);
  return o.text;
};

// The screen as a person reads it: each row's text, and the block's words run together.
const rows = (lines: Line[]): string[] => lines.map((l) => l.map(([, s]) => s).join(''));
const words = (lines: Line[]): string => rows(lines).map((r) => r.replace(/^ [│└|`]-? ?/, '')).join(' ').replace(/\s+/g, ' ');
const drawn = (entry: Entry, ascii = false): Line[] => entryLines({ ...initialState(null), size: GRID }, maker(ascii), entry);
const entryOf = (question: string, o: AskOutcome): Entry => {
  if (o.kind === 'answer') return { kind: 'answer', question, view: o.view, skipped: o.skipped, notes: o.notes, added: o.added, ...(o.news ? { news: o.news } : {}) };
  if (o.kind === 'no-records') return { kind: 'no-records', question, news: o.news };
  if (o.kind === 'note') return { kind: 'note', question, text: o.text };
  return { kind: 'failed', question, message: o.message, detail: o.detail };
};

describe('when news is read', () => {
  it('reads what a company filed over the window the question names, and nothing beside it', async () => {
    const { engine, data, catalogReads } = setup(local());
    const q = 'equities.company/fxmp: what did it file between September 28 and October 9?';
    const o = answered(await askBriefings(engine, q, null));
    expect((data as Newsroom).asked).toEqual([{ about: 'fxmp', kind: 'filed', since: '2026-09-28', until: '2026-10-09', limit: 25 }]);
    // No briefing, metric or catalog is read for a news question, and no get_changes.
    expect((data as Newsroom).reads).toEqual([]);
    expect(catalogReads()).toBe(0);
    expect(o.result.packet.blocks.map((b) => b.id)).toEqual(['news']);
    expect(o.result.outcome).toBe('passed');
    expect(o.view.sources).toEqual([{ n: 1, block: 'news', line: 3 }]);
    expect(o.news).toMatchObject({ kind: 'filed', company: 'Fictional Group Corp', since: '2026-09-28', until: '2026-10-09', readAt: NOW.toISOString() });
  });

  it('reads official records for an official act, and never names a company with them', async () => {
    const data = new Newsroom(served(OFFICIAL));
    const { engine } = setup(local(cites([{ text: 'The Example Central Bank released the minutes of the Example Policy Committee on Oct 7, 2026.', line: 3, quote: 'Minutes of the Example Policy Committee' }], 'The minutes were released on Oct 7, 2026.')), data);
    answered(await askBriefings(engine, 'Between September 28 and October 9, on what date did the Federal Reserve release the FOMC minutes?', null));
    expect(data.asked).toEqual([{ kind: 'official', since: '2026-09-28', until: '2026-10-09', limit: 25 }]);
    expect(data.asked[0]).not.toHaveProperty('about');
  });

  it('reads one named day as the window that ends on it, and no named day as PreReason\'s own', async () => {
    const day = setup(local());
    await askBriefings(day.engine, 'equities.company/fxmp: which items did it report in its 8-K filed on October 1, 2026?', null);
    expect((day.data as Newsroom).asked).toEqual([{ about: 'fxmp', kind: 'filed', asOf: '2026-10-01', limit: 25 }]);
    const none = setup(local(), new Newsroom(served(OFFICIAL)));
    await askBriefings(none.engine, 'What did the Federal Register publish on trade?', null);
    expect((none.data as Newsroom).asked).toEqual([{ kind: 'official', limit: 25 }]);
  });

  it('refuses a window over 92 days in plain words, before any call, local or hosted', async () => {
    const q = 'What did the Federal Register publish between January 2 and October 9, 2026?';
    for (const model of [local(), hosted({ read: [], news: { kind: 'official' } })]) {
      const { engine, data } = setup(model);
      expect(noted(await askBriefings(engine, q, null))).toBe("From Jan 2, 2026 to Oct 9, 2026 is more than 92 days, and PreReason's news reads at most 92 days at a time, so nothing was read. Name a shorter span, such as Jul 9, 2026 to Oct 9, 2026.");
      expect((data as Newsroom).asked).toEqual([]);
      expect(model.calls).toEqual([]);
    }
  });

  it('asks for the company by its code where a filing question names it in words, and sends nothing', async () => {
    const { engine, data } = setup(local());
    expect(noted(await askBriefings(engine, 'Which items did Fictional Group Corp report in its Form 8-K filed on October 1, 2026?', null))).toBe(NAME_THE_COMPANY);
    expect((data as Newsroom).asked).toEqual([]);
  });

  it('says plainly that the demo holds no news, as its other key-only reads do', async () => {
    const { engine } = setup(local(), new FixtureConnector(BENCH_BRIEFINGS));
    expect(noted(await askBriefings(engine, 'equities.company/fxmp: what did it file this week?', null))).toBe(DEMO_NEWS);
  });

  it('reads a briefing question from briefings, as before, and names that the news door was not read', async () => {
    const { engine, data } = setup(local((p) => cites([{ text: 'The first line names what was read.', line: 1, quote: p.blocks[0]!.lines[0]!.slice(0, 8) }], 'The packet reads as its first line says.').replace(/"news"/g, JSON.stringify(p.blocks[0]!.id))));
    const o = answered(await askBriefings(engine, 'Where does Bitcoin stand?', null));
    expect((data as Newsroom).asked).toEqual([]);
    expect(o.news).toBeUndefined();
    expect(o.result.packet.blocks[0]?.id).toMatch(/^btc\./);
  });

  it('reads a briefing the question names by its id, though it asks what was announced, local or hosted', async () => {
    // The recheck of 10-13: "macro.rates: how did yields move after the Fed announced the cut?"
    // read the news door, and the briefing it named was never read.
    const q = 'macro.snapshot: how did yields move after the Fed announced the cut?';
    const fromBlock = (p: Packet) => cites([{ text: 'The briefing reads as its first line says.', line: 1, quote: p.blocks[0]!.lines[0]!.slice(0, 8) }], 'The briefing reads as its first line says.').replace(/"news"/g, JSON.stringify(p.blocks[0]!.id));
    for (const model of [local(fromBlock), new ScriptedModel([fromBlock], { local: false, format: 'markdown' })]) {
      const { engine, data } = setup(model);
      const o = answered(await askBriefings(engine, q, null));
      expect((data as Newsroom).asked).toEqual([]);
      expect((data as Newsroom).reads[0]).toBe('macro.snapshot');
      expect(o.result.packet.blocks[0]?.id).toBe('macro.snapshot');
      expect(o.news).toBeUndefined();
    }
    // CONTROL: the same question naming no id reads the news door.
    const plain = setup(local());
    await askBriefings(plain.engine, 'How did yields move after the Fed announced the cut?', null);
    expect((plain.data as Newsroom).asked).toEqual([{ kind: 'official', limit: 25 }]);
  });

  it("reads the company's briefing for a 10-Q, which the news door does not hold", async () => {
    // The recheck of 10-13: a 10-Q question read 8-K items alone, and never the company's briefing.
    const family = { id: 'equities.company', name: 'Company briefing', description: 'Request as equities.company/<company>.', tier: 'free' as const };
    const data = new NewsroomWithCompanies();
    const fromBlock = (p: Packet) => cites([{ text: 'The briefing reads as its first line says.', line: 1, quote: p.blocks[0]!.lines[0]!.slice(0, 8) }], 'The briefing reads as its first line says.').replace(/"news"/g, JSON.stringify(p.blocks[0]!.id));
    const { engine } = setup(local(fromBlock), data, { catalog: async () => [...catalog, family] });
    const o = answered(await askBriefings(engine, 'equities.company/fxmp: what revenue did it report in its latest 10-Q?', null));
    expect(data.asked).toEqual([]);
    expect(data.reads).toEqual(['equities.company/fxmp']);
    expect(o.news).toBeUndefined();
  });

  it('gives the hosted model one more choice, the news door, told the same rule', async () => {
    const pick = pickPacket('What did Fictional Group Corp put out in early October?', catalog, '2026-10-12');
    expect(pick.text).toContain('the news door, with a company or official records and a window');
    expect(pick.text).toContain('filed, filing, 8-K, Form, Federal Register, minutes, release, announced, enforcement action, proclamation, notice). Its filings are 8-K items only: for a 10-Q, 10-K, 6-K or 20-F, pick the company\'s briefing instead.');
    expect(JSON.stringify(pick.schema)).toContain('"news"');
    const { engine, data } = setup(hosted({ read: [], news: { kind: 'filed', company: 'FXMP', since: '2026-09-28', until: '2026-10-09' } }));
    const o = answered(await askBriefings(engine, 'What did Fictional Group Corp put out in early October?', null));
    expect((data as Newsroom).asked).toEqual([{ about: 'fxmp', kind: 'filed', since: '2026-09-28', until: '2026-10-09', limit: 25 }]);
    expect(o.result.packet.blocks.map((b) => b.id)).toEqual(['news']);
    // A company in words is no code: the model's pick of it reads nothing.
    const words = setup(hosted({ read: [], news: { kind: 'filed', company: 'Fictional Group Corp' } }));
    expect(noted(await askBriefings(words.engine, 'What did Fictional Group Corp file?', null))).toBe(NAME_THE_COMPANY);
    expect((words.data as Newsroom).asked).toEqual([]);
  });

  it("reads the question's own span before the model's window, and the model's window before one named day", async () => {
    const span = setup(hosted({ read: [], news: { kind: 'official', since: '2026-09-01', until: '2026-09-30' } }), new Newsroom(served(OFFICIAL)));
    await askBriefings(span.engine, 'Between September 28 and October 9, what did the Federal Register publish?', null);
    expect((span.data as Newsroom).asked[0]).toMatchObject({ since: '2026-09-28', until: '2026-10-09' });
    // The minutes of a meeting named by its day come out weeks after it: the model's window.
    const day = setup(hosted({ read: [], news: { kind: 'official', since: '2026-09-16', until: '2026-10-12' } }), new Newsroom(served(OFFICIAL)));
    await askBriefings(day.engine, 'On what date did the Federal Reserve release the minutes of the FOMC meeting of September 16, 2026?', null);
    expect((day.data as Newsroom).asked[0]).toMatchObject({ since: '2026-09-16', until: '2026-10-12' });
  });

  it('still refuses a briefing question that names two days, without asking the model', async () => {
    const model = hosted({ read: ['btc.pulse'] });
    const { engine } = setup(model);
    expect(noted(await askBriefings(engine, 'Where did Bitcoin stand on Aug 15 and Aug 20?', null))).toMatch(/^This question names 2 days/);
    expect(model.calls).toEqual([]);
  });

  it('says what was read when the window holds no record, and asks no model', async () => {
    const model = local();
    const { engine } = setup(model, new Newsroom(served(EMPTY)));
    const o = await askBriefings(engine, 'equities.company/fxmp: what did it file between September 28 and October 9?', null);
    expect(o.kind).toBe('no-records');
    expect(model.calls).toEqual([]);
  });
});

describe('the block of records', () => {
  it('is one numbered line a record, cited as a briefing line is, under the same checks', async () => {
    const { engine, model } = setup(local());
    const o = answered(await askBriefings(engine, 'equities.company/fxmp: what did it file between September 28 and October 9?', null));
    const text = model.calls[0]!.packet.text;
    expect(text).toContain("PreReason's news (block news): 3 records filed by Fictional Group Corp, from 2026-09-28 to 2026-10-09 (each record by the date it shows), newest first, one record a line:");
    expect(text).toContain('[news L3] Oct 1, 2026 · FILED · Fictional Group Corp · 8-K item 2.02, results of operations · Sample Filings Registry 8-K items\n');
    expect(text).toContain('Never set a price, a change or a move beside a record');
    expect(o.result.checks.map((c) => [c.id, c.failures.length])).toEqual([['schema', 0], ['citations', 0], ['grounded_numbers', 0], ['grounded_directions', 0], ['scope', 0]]);
    // CONTROL: a quote the record's line does not hold fails its citation, as on a briefing.
    const wrong = setup(local(cites([{ ...ITEM_202, quote: '8-K item 5.02, departure of directors' }])));
    const failed = await askBriefings(wrong.engine, 'equities.company/fxmp: what did it file between September 28 and October 9?', null);
    expect(failed.kind).toBe('failed');
    expect(wrong.model.calls[1]?.repair?.map((f) => f.message)).toContain('the quote "8-K item 5.02, departure of directors" is not in [news L3]');
  });

  it("states a timed record in its source's own clock, and a record by its date alone otherwise", () => {
    const official = served(OFFICIAL);
    expect(recordLine(official.records[2]!)).toBe("Oct 7, 2026 14:00 Sample City time · OFFICIAL · Example Central Bank · Minutes of the Example Policy Committee, September 15-16, 2026 · the Example Central Bank's monetary policy releases");
    expect(recordLine(official.records[0]!)).toBe("Oct 9, 2026 · OFFICIAL · Sample Export Control Office · Additions to the sample restricted parties list · the Sample Gazette's trade actions and export controls");
  });

  it('keeps the link out of the line the model cites and the checks read, so its digits ground no figure', async () => {
    // The recheck of 10-13: a link's digits, a gazette's /2026/10/07/0000-00002/ or an
    // accession's -26-000047, grounded figures no record states.
    const { engine, model } = setup(local());
    const o = answered(await askBriefings(engine, 'equities.company/fxmp: what did it file between September 28 and October 9?', null));
    expect(o.result.packet.blocks[0]!.lines.join('\n')).not.toMatch(/https?:|sample-filings\.example|000047/);
    expect(model.calls[0]!.packet.text).not.toMatch(/sample-filings\.example|-26-000047/);
    // A figure only the link held: 47 from the accession, and 26 from its -26-.
    const fromLink = { text: 'Fictional Group Corp filed an 8-K on Oct 1, 2026 reporting results of operations for 47 stores.', line: 3, quote: '8-K item 2.02, results of operations' };
    const linked = setup(local(cites([ITEM_202, fromLink], 'Fictional Group Corp filed an 8-K on Oct 1, 2026.')));
    const held = answered(await askBriefings(linked.engine, 'equities.company/fxmp: what did it file between September 28 and October 9?', null));
    expect(held.view.dropped).toEqual([{ text: fromLink.text, reasons: ['47 is not in the lines this claim cites'] }]);
    const official = new Newsroom(served(OFFICIAL));
    const notice = { text: 'The Example Trade Representative Office published its notice of action on steel products on Oct 7, 2026, covering 10 products.', line: 4, quote: 'Notice of action under sample rule 301: steel products' };
    const gazette = setup(local(cites([notice], 'The notice was published on Oct 7, 2026.')), official);
    const out = await askBriefings(gazette.engine, 'Between September 28 and October 9, what did the Federal Register publish on steel?', null);
    expect(out.kind).toBe('failed');
    expect(gazette.model.calls[1]?.repair?.map((f) => f.message)).toEqual(['10 is not in the lines this claim cites']);
  });

  it('still shows the link to the person beside each cited record, and keeps every link in the journal', async () => {
    const root = mkdtempSync(join(tmpdir(), 'primerkit-news-journal-'));
    const { engine } = setup(local(), new Newsroom(), { journal: new Journal(root) });
    const q = 'equities.company/fxmp: what did it file between September 28 and October 9?';
    const o = answered(await askBriefings(engine, q, null));
    const link = 'https://sample-filings.example/data/0000000000/000000000026000047/0000000000-26-000047-index.htm';
    // On screen the link breaks after a slash, so the rows are read with their spaces taken out.
    const squeezed = (s: string) => s.replace(/\s+/g, '');
    expect(squeezed(words(drawn(entryOf(q, o))))).toContain(squeezed(`[1] Oct 1, 2026 · FILED · Fictional Group Corp · 8-K item 2.02, results of operations · Sample Filings Registry 8-K items · ${link}`));
    const dir = o.result.journalDir!;
    expect(readFileSync(join(dir, 'render.md'), 'utf8')).toContain(`[1] Oct 1, 2026 · FILED · Fictional Group Corp · 8-K item 2.02, results of operations · Sample Filings Registry 8-K items · ${link}`);
    const kept = JSON.parse(readFileSync(join(dir, 'news.json'), 'utf8')) as { records: Array<{ line: number; record: string; link: string | null }> };
    expect(kept.records).toHaveLength(3);
    expect(kept.records[2]).toEqual({ line: 3, record: 'Oct 1, 2026 · FILED · Fictional Group Corp · 8-K item 2.02, results of operations · Sample Filings Registry 8-K items', link });
    expect(kept.records[0]?.link).toBe('https://sample-filings.example/data/0000000000/000000000026000052/0000000000-26-000052-index.htm');
  });

  it('sets no price, change or move beside a record, and reads no briefing beside it', async () => {
    // A record served with more than it states keeps only its date, mark, who, what and source.
    const withPrice = served(FILED, (b) => Object.assign((b.records as Array<Record<string, unknown>>)[2]!, { close: 61.2, change: '+4.1%', move: 'up' }));
    const data = new Newsroom(withPrice);
    const priced = { text: 'Fictional Group Corp filed an 8-K on Oct 1, 2026, and its shares rose 4.1% that day.', line: 3, quote: '8-K item 2.02' };
    const { engine } = setup(local(cites([ITEM_202, priced], 'Fictional Group Corp filed an 8-K on Oct 1, 2026.')), data);
    const o = answered(await askBriefings(engine, 'equities.company/fxmp: what did it file between September 28 and October 9?', null));
    const lines = o.result.packet.blocks[0]!.lines;
    expect(lines.join('\n')).not.toMatch(/61\.2|4\.1|%|\bup\b/);
    // Every record names a briefing; none is read beside the records, so no price is in the packet.
    expect(withPrice.records.every((r) => r.briefing)).toBe(true);
    expect(data.reads).toEqual([]);
    // A claim that sets a move beside a record holds a figure no record holds, and a move: the
    // checks take it out, and name both.
    expect(o.view.sentences.map((s) => s.text).join(' ')).not.toContain('4.1');
    // Its "rose" is a direction no record's line holds, so the direction check names it too.
    expect(o.view.dropped[0]).toMatchObject({ text: priced.text, reasons: [expect.stringContaining('4.1 is not in the lines this claim cites'), '"rose" is a direction the lines this claim cites do not hold: none of them states a change', 'a price or move beside a news record: "rose 4.1%"'] });
  });
});

describe('no price or move beside a record, held in code', () => {
  // The wording review's rulings of 10-14: a move verb, a market price phrase, or a $ or %
  // figure next to a move verb or to higher or lower, or a % figure after up or down (or up by, down by),
  // in a claim that cites a record; the verbs and phrases in a news answer's background. Its
  // sentences, with the company made up as every fixture's is.
  const Q = 'equities.company/fxmp: what did it file between September 28 and October 9?';
  const PLAIN = { text: 'Fictional Group Corp filed an 8-K on Oct 1, 2026.', line: 3, quote: '8-K item 2.02, results of operations' };
  const SAY_WHAT = 'Say what the record is and when instead';

  it("takes out the recheck's claim, which passed every check, and names why, telling the model alone what to do instead", async () => {
    // The recheck of 10-13: with the link in the line, its accession's -26- grounded the 26.
    const moved = { text: "Fictional Group Corp's shares rose 26% after its 8-K.", line: 3, quote: '8-K item 2.02, results of operations' };
    const root = mkdtempSync(join(tmpdir(), 'primerkit-news-moved-'));
    const { engine, model } = setup(local(cites([PLAIN, moved], PLAIN.text)), new Newsroom(), { journal: new Journal(root) });
    const o = answered(await askBriefings(engine, Q, null));
    // The repair turn tells the model what failed and what to do instead.
    expect(repairMessage(model.calls[1]?.repair)).toContain(`- scope: a price or move beside a news record: "rose 26%". ${SAY_WHAT}`);
    expect(o.result.outcome).toBe('partial');
    expect(o.view.sentences.map((s) => s.text)).toEqual([PLAIN.text]);
    // The person reads only what failed: on screen, and in the markdown the CLI prints and the journal keeps.
    expect(o.view.dropped).toEqual([{ text: moved.text, reasons: ['26 is not in the lines this claim cites', '"rose" is a direction the lines this claim cites do not hold: none of them states a change', 'a price or move beside a news record: "rose 26%"'] }]);
    const screenWords = words(drawn(entryOf(Q, o)));
    expect(screenWords).toContain(`Not supported by the data: "${moved.text}"`);
    expect(screenWords).not.toContain(SAY_WHAT);
    expect(readFileSync(join(o.result.journalDir!, 'render.md'), 'utf8')).not.toContain(SAY_WHAT);
  });

  it("takes out each of the wording review's failing sentences, as a failing claim is taken out", async () => {
    for (const [text, found] of [
      ['The stock fell after the filing on Oct 1, 2026.', 'fell'],
      ['Fictional Group Corp was trading at $41 after the release of its 8-K.', 'trading at'],
      ['Fictional Group Corp fell $3 after its 8-K of Oct 1, 2026.', 'fell $3'],
      ['Fictional Group Corp ended $4 lower after its 8-K of Oct 1, 2026.', '$4 lower'],
      ['Fictional Group Corp was down 3% after its 8-K of Oct 1, 2026.', 'down 3%'],
      ['Fictional Group Corp was up by 26% after its 8-K of Oct 1, 2026.', 'up by 26%'],
      ['Fictional Group Corp was down by 3% after its 8-K of Oct 1, 2026.', 'down by 3%'],
    ]) {
      const claim = { text: text!, line: 3, quote: '8-K item 2.02, results of operations' };
      const o = answered(await askBriefings(setup(local(cites([PLAIN, claim], PLAIN.text))).engine, Q, null));
      expect(o.view.dropped.map((d) => d.text), text).toEqual([text]);
      expect(o.view.dropped[0]?.reasons, text).toContain(`a price or move beside a news record: "${found}"`);
    }
  });

  it('passes a debt drawn or paid down and a value written down, where the record states them', async () => {
    const stated = served(FILED, (b) => {
      const records = b.records as Array<Record<string, unknown>>;
      records[0]!.line = '8-K item 2.03, creation of a direct financial obligation: drew down $500 million under its credit facility';
      records[1]!.line = '8-K item 8.01, other events: paid down $1.2 billion of its notes';
      records[2]!.line = '8-K item 2.06, material impairments: wrote down $80 million of goodwill';
    });
    const claims = [
      { text: 'Fictional Group Corp drew down $500 million under its credit facility, as its 8-K of Oct 8, 2026 says.', line: 1, quote: 'drew down $500 million under its credit facility' },
      { text: 'Fictional Group Corp paid down $1.2 billion of its notes, as its 8-K of Oct 1, 2026 says.', line: 2, quote: 'paid down $1.2 billion of its notes' },
      { text: 'Fictional Group Corp wrote down $80 million of goodwill, as its 8-K of Oct 1, 2026 says.', line: 3, quote: 'wrote down $80 million of goodwill' },
    ];
    const o = answered(await askBriefings(setup(local(cites(claims, 'Fictional Group Corp filed three 8-K items.')), new Newsroom(stated)).engine, Q, null));
    expect(o.result.outcome).toBe('passed');
    expect(o.view.sentences.map((s) => s.text)).toEqual(claims.map((c) => c.text));
  });

  it('takes a price or move out of a news answer\'s background, and says background holds none', async () => {
    const MOVED = 'The stock fell after the filing.';
    const WHAT = 'A current report names events a company discloses.';
    const root = mkdtempSync(join(tmpdir(), 'primerkit-news-background-'));
    const text = JSON.stringify({ ...JSON.parse(cites([PLAIN], PLAIN.text)), background: [WHAT, MOVED] });
    const { engine, model } = setup(local(text), new Newsroom(), { journal: new Journal(root) });
    const o = answered(await askBriefings(engine, Q, null));
    expect(repairMessage(model.calls[1]?.repair)).toContain('- scope: a price or move beside a news record: "fell". Background sentence 2 explains, and sets no price or move beside a record');
    expect(o.result.outcome).toBe('partial');
    expect(o.view.background).toEqual([WHAT]);
    expect(o.view.dropped).toEqual([{ text: MOVED, reasons: ['a price or move beside a news record: "fell"'], background: true }]);
    const screenWords = words(drawn(entryOf(Q, o)));
    expect(screenWords).toContain(`Taken out of the background: "${MOVED}". a price or move beside a news record: "fell"`);
    expect(screenWords).not.toContain('Background sentence 2 explains');
    // The background line, in the markdown the CLI prints and the journal keeps.
    expect(readFileSync(join(o.result.journalDir!, 'render.md'), 'utf8')).toContain(`Taken out of the background, which holds no number, no advice and no price or move: "${MOVED}".`);
  });

  it("passes a plain filing description, and the wording review's passing sentences where the record states their figures", async () => {
    const plain = answered(await askBriefings(setup(local(cites([PLAIN], PLAIN.text))).engine, Q, null));
    expect(plain.result.outcome).toBe('passed');
    expect(plain.result.checks.map((c) => [c.id, c.failures.length])).toEqual([['schema', 0], ['citations', 0], ['grounded_numbers', 0], ['grounded_directions', 0], ['scope', 0]]);
    // Records that state a departure, a repurchase and an offering's price.
    const stated = served(FILED, (b) => {
      const records = b.records as Array<Record<string, unknown>>;
      records[0]!.line = '8-K item 5.02, departure of directors or certain officers: the CEO stepped down';
      records[1]!.line = '8-K item 8.01, other events: a $2 billion share repurchase';
      records[2]!.line = '8-K item 8.01, other events: its offering priced at $20 per share';
    });
    const claims = [
      { text: "Fictional Group Corp's 8-K of Oct 8, 2026 says the CEO stepped down.", line: 1, quote: 'the CEO stepped down' },
      { text: 'Fictional Group Corp announced a $2 billion share repurchase in an 8-K filed on Oct 1, 2026.', line: 2, quote: 'a $2 billion share repurchase' },
      { text: 'Fictional Group Corp priced its offering at $20 per share, as its 8-K of Oct 1, 2026 says.', line: 3, quote: 'its offering priced at $20 per share' },
    ];
    const o = answered(await askBriefings(setup(local(cites(claims, 'Fictional Group Corp filed three 8-K items.')), new Newsroom(stated)).engine, Q, null));
    expect(o.result.outcome).toBe('passed');
    expect(o.view.sentences.map((s) => s.text)).toEqual(claims.map((c) => c.text));
  });

  it('fails an answer that sums its records up with a move, and names why', async () => {
    const { engine } = setup(local(cites([PLAIN], 'Fictional Group Corp filed an 8-K on Oct 1, 2026, and the stock fell.')));
    const o = await askBriefings(engine, Q, null);
    expect(o).toEqual({ kind: 'failed', message: 'The answer did not pass its checks, so it is not shown.', detail: 'It failed on: a price or move beside a news record: "fell"' });
  });
});

describe('the screens of a news answer', () => {
  const fxmp = async (answer: NewsAnswer, model = local()) => {
    const q = 'equities.company/fxmp: what did it file between September 28 and October 9?';
    return drawn(entryOf(q, await askBriefings(setup(model, new Newsroom(answer)).engine, q, null)));
  };
  const official = async (answer: NewsAnswer, model: ScriptedModel) => {
    const q = 'Between September 28 and October 9, did the Federal Register publish a tariff on steel?';
    return drawn(entryOf(q, await askBriefings(setup(model, new Newsroom(answer)).engine, q, null)));
  };
  const noClaim = () => local(JSON.stringify({ answer: 'No record read names a tariff on steel.', claims: [], not_in_data: ['a record that sets a tariff on steel'] }));

  it("credits the door, whose records, the window and the time it was read, as the wording review cleared it", async () => {
    const read = newsRead(served(FILED), 'filed', NOW.toISOString());
    expect(newsCredit(read)).toBe('news · filed by Fictional Group Corp · Sep 28 to Oct 9, 2026 · read 14:02 UTC');
    expect(newsCredit(newsRead(served(OFFICIAL), 'official', NOW.toISOString()))).toBe('news · official records · Sep 28 to Oct 9, 2026 · read 14:02 UTC');
    // On screen: the mark leads it, and where it is wider than the block it goes on under the
    // mark, broken between its parts, with no word cut.
    const filed = rows(await fxmp(served(FILED)));
    expect(filed).toContain(' │  PR  news · filed by Fictional Group Corp · Sep 28 to Oct 9, 2026');
    expect(filed.at(-1)).toBe(' └      read 14:02 UTC');
    const off = rows(await official(served(OFFICIAL), noClaim()));
    expect(off.at(-1)).toBe(' └  PR  news · official records · Sep 28 to Oct 9, 2026 · read 14:02 UTC');
  });

  it('shows each cited record as its line reads, under the number the answer gives it', async () => {
    const lines = await fxmp(served(FILED));
    expect(rows(lines).some((r) => r.startsWith(' │ ↳ [1] Oct 1, 2026 · FILED · Fictional Group Corp · 8-K item 2.02,'))).toBe(true);
    expect(words(lines)).toContain('[1] Oct 1, 2026 · FILED · Fictional Group Corp · 8-K item 2.02, results of operations · Sample Filings Registry 8-K items · https://');
    expect(words(lines)).toContain('Fictional Group Corp filed an 8-K on Oct 1, 2026 reporting item 2.02, results of operations [1].');
  });

  it('names its checks as every answer does', async () => {
    expect(words(await fxmp(served(FILED)))).toContain('✓ 5 of 5 checks: answer format · claims cite their lines · figures match the lines cited · direction words cite a change · no advice words');
  });

  it('says what was read when the window holds no record, never that nothing happened', async () => {
    const read = newsRead(served(EMPTY), 'filed', NOW.toISOString());
    expect(emptyLines(read)).toEqual(["PreReason's news holds no record filed by Fictional Group Corp from Sep 28 to Oct 9, 2026.", 'Sources read: Sample Filings Registry 8-K items.']);
    const screenWords = words(await fxmp(served(EMPTY)));
    expect(screenWords).toContain("PreReason's news holds no record filed by Fictional Group Corp from Sep 28 to Oct 9, 2026. Sources read: Sample Filings Registry 8-K items.");
    expect(screenWords).not.toMatch(/nothing happened|no news/i);
  });

  it('says none of the records read answers a topic no record answers', async () => {
    expect(words(await official(served(OFFICIAL), noClaim()))).toContain('None of the 12 official records from Sep 28 to Oct 9, 2026 answers this.');
    expect(noneLine(newsRead(served(FILED, (b) => (b.records = (b.records as unknown[]).slice(0, 1))), 'filed', NOW.toISOString()))).toBe('The one record filed by Fictional Group Corp from Sep 28 to Oct 9, 2026 does not answer this.');
  });

  it('prints the sources not read and every notice, whenever the answer holds them', async () => {
    const notRead = served(EMPTY, (b) => (b.not_read = ['Sample Overseas Registry (fictional companies, for tests)']));
    expect(words(await fxmp(notRead))).toContain('Not read for this answer: Sample Overseas Registry. A record from it would not show here.');
    const noticed = words(await official(served(OFFICIAL), noClaim()));
    expect(noticed).toContain('Notice: Source: Sample Gazette (Office of the Sample Gazette, Fictionland), naming the issuing office.');
    expect(noticed).toContain('Notice: Source: Board of the Example Central Bank.');
    // CONTROL: an answer that holds neither prints neither.
    const plain = words(await fxmp(served(FILED)));
    expect(plain).not.toContain('Not read for this answer');
    expect(plain).not.toContain('Notice:');
  });

  it("says the door's refusals in their own words, and names no data host for an Indian company", async () => {
    const said = async (error: Error, company = 'fxmp') => {
      const q = `equities.company/${company}: what did it file this week?`;
      return askBriefings(setup(local(), new Newsroom(error)).engine, q, null);
    };
    expect(noted(await said(new NewsError('No company PreReason covers matches "zzzz".', 404, 'NOT_COVERED', 'not-covered'), 'zzzz'))).toBe('PreReason\'s news does not cover "equities.company/zzzz".');
    const india = noted(await said(new NewsError('This version reads no filings for Reliance Industries.', 404, 'NO_SOURCE', 'no-source'), 'ine002a01018'));
    expect(india).toBe('PreReason reads no filings for Indian companies yet.');
    expect(india).not.toMatch(/NSE|BSE|SEBI|\.in\b|exchange/i);
    expect(noted(await said(new NewsError('No source could be read right now. Try again shortly.', 503, 'NEWS_UNAVAILABLE', 'unavailable')))).toBe("PreReason's news could not be read just now. Nothing was answered.");
  });

  it('names the sources as PreReason served them, so one the screen does not know still prints', async () => {
    // The wording review's condition: "Sources read" and the credit come from the served answer.
    const more = served(EMPTY, (b) => {
      b.coverage = "Nothing found in Sample Filings Registry 8-K items (fictional companies, for tests) and the Sample Northern Bank's notices from 2026-09-28 to 2026-10-09 (each record by the date it shows).";
      b.not_read = ['Example Exchange announcements (fictional companies, for tests)'];
    });
    const screenWords = words(await fxmp(more));
    expect(screenWords).toContain("Sources read: Sample Filings Registry 8-K items and the Sample Northern Bank's notices.");
    expect(screenWords).toContain('Not read for this answer: Example Exchange announcements. A record from it would not show here.');
    // CONTROL: a source the answer did not read is never named as read.
    // An answer with no records holds no notice: a notice comes with a source's records.
    const nothing = served(OFFICIAL, (b) => {
      b.records = [];
      delete b.notices;
      b.coverage = "Nothing found in the Sample Gazette's trade actions and export controls from 2026-09-28 to 2026-10-09 (each record by the date it shows).";
    });
    const official = words(drawn({ kind: 'no-records', question: 'q', news: newsRead(nothing, 'official', NOW.toISOString()) }));
    expect(official).toContain("Sources read: the Sample Gazette's trade actions and export controls.");
    expect(official).not.toMatch(/Sample Filings Registry|Sample Overseas Registry|DART|Treasury|Central Bank/);
    // A coverage sentence worded otherwise is shown whole, never replaced by names typed here.
    const reworded = newsRead(served(EMPTY, (b) => (b.coverage = 'Searched Sample Filings Registry 8-K items for 2026-09-28 to 2026-10-09.')), 'filed', NOW.toISOString());
    expect(emptyLines(reworded)[1]).toBe('Searched Sample Filings Registry 8-K items for 2026-09-28 to 2026-10-09.');
  });

  it('says a read cut at the most records PreReason serves, and draws in plain text too', async () => {
    const many = served(OFFICIAL, (b) => (b.records = Array.from({ length: 25 }, () => (b.records as unknown[])[0])));
    expect(sideLines(newsRead(many, 'official', NOW.toISOString()))[0]).toBe('Only the newest 25 records of this window were read; a shorter span reads older ones.');
    const ascii = rows(drawn(entryOf('q', await askBriefings(setup(noClaim(), new Newsroom(served(OFFICIAL))).engine, 'What did the Federal Register publish on trade?', null)), true));
    expect(/^[\x00-\x7f]*$/.test(ascii.join('\n'))).toBe(true);
    for (const row of ascii) expect(row.length).toBeLessThanOrEqual(GRID.width);
  });
});

describe('a news question in the session', () => {
  // A session at home with a key, a local model (the demo's stand in, which cites what it
  // lifts) and a PreReason that serves one news answer.
  function newsSession(answer: NewsAnswer) {
    const home = mkdtempSync(join(tmpdir(), 'primerkit-news-'));
    const journal = new Journal(join(home, 'journal'));
    const data = new Newsroom(answer);
    const deps: SessionDeps = {
      demo: null,
      env: {},
      platform: 'win32',
      config: { read: () => readConfig(home), write: (c) => writeConfig(home, c) },
      checkMachine: async () => ({ apps: [], keys: [], local: [], ollama: 'running' }),
      catalog: async () => catalog,
      resolveKey: () => ({ key: `pr_test_${'s'.repeat(20)}`, source: 'env' }),
      connect: () => ({ cancel: () => {} }),
      briefings: () => data,
      model: () => new ExtractiveModel('markdown'),
      listModels: async () => [],
      pull: async (_name, onProgress) => onProgress({ status: 'success' }),
      fitness: async () => {
        throw new Error('no check here');
      },
      fitnessPlan: () => ({ calls: 0, tokens: 0 }),
      operation: ask,
      digestOperation: loadOperation(DIGEST_DIR),
      journal,
      snapshots: new Snapshots(join(home, 'snapshots')),
      latestDigest: () => readLatestDigest(home),
      scheduler: { add: async () => {}, remove: async () => false, exists: async () => false },
      scheduleEntry: (time) => digestEntry({ time, platform: 'win32', node: 'C:\\node\\node.exe', script: 'C:\\pk\\bin\\primerkit.js', cwd: 'C:\\pk', now: NOW }),
      journalRows: () => journalRows(journal.root),
      journalOpen,
      openLink: () => true,
      copy: () => true,
      now: () => NOW,
      home,
    };
    writeConfig(home, { disclaimer_accepted_at: 'x', first_run_done_at: 'x', model: { kind: 'ollama', base_url: 'http://127.0.0.1:11434', name: 'qwen2.5:7b' }, prereason: { tier: 'free' } });
    const s = new Session(deps);
    s.start();
    return { s, data };
  }
  const askIn = async (s: Session, question: string) => {
    for (const char of question) s.key({ name: 'char', char } as Key);
    s.key({ name: 'enter' } as Key);
    await s.idle();
  };
  const shown = (s: Session) => words(screen(s.state, false));

  it('puts a news answer in the feed with its records and its credit', async () => {
    const { s, data } = newsSession(served(FILED));
    await askIn(s, 'equities.company/fxmp: what did it file between September 28 and October 9?');
    expect(data.asked).toHaveLength(1);
    expect(s.state.feed.at(-1)).toMatchObject({ kind: 'answer', news: { kind: 'filed', company: 'Fictional Group Corp' } });
    expect(shown(s)).toContain('PR news · filed by Fictional Group Corp · Sep 28 to Oct 9, 2026');
  });

  it('puts a window with no record in the feed as what was read', async () => {
    const { s } = newsSession(served(EMPTY));
    await askIn(s, 'equities.company/fxmp: what did it file between September 28 and October 9?');
    expect(s.state.feed.at(-1)).toMatchObject({ kind: 'no-records' });
    expect(shown(s)).toContain('Sources read: Sample Filings Registry 8-K items.');
  });
});
