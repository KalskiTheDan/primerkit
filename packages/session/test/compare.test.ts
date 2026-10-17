import { existsSync, mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { Journal, Snapshots, blockFromMarkdown, loadOperation, readConfig, runOperation, writeConfig, type ConfigModel, type ModelCapabilities, type ModelReply, type Packet } from '@primerkit/core';
import { FixtureConnector, parseCatalog, type MetricEntry, type Tier } from '@primerkit/connector-prereason';
import { AnthropicWebSearch, ExtractiveModel, ModelError, ScriptedModel, listPrice, priceOf } from '@primerkit/models';
import { maker, type Line } from '@primerkit/ui';
import {
  ASK_DIR,
  COMPARE_FOOTER,
  BENCH_BRIEFINGS,
  DEMO_CATALOG,
  DIGEST_DIR,
  PLAN_SIZES,
  ROOT,
  Session,
  compareCost,
  comparePlan,
  digestEntry,
  dollars,
  entryLines,
  figuresLine,
  figuresOf,
  journalOpen,
  journalRows,
  menuRows,
  screen,
  webSpent,
  webStatus,
  webSystem,
  type Key,
  type SessionDeps,
  type State,
} from '../src/index';

const ASK = loadOperation(ASK_DIR);
const DIGEST = loadOperation(DIGEST_DIR);
const RECORDED = readFileSync(join(ROOT, 'packages', 'models', 'test', 'fixtures', 'web-search-net-liquidity.json'), 'utf8');
const WEB_TEXT = "Net liquidity has been drifting lower. The central bank's balance sheet stood at $6.61 trillion in the week to October 8, while the government's cash balance rose to $842 billion.\n\nReverse repo use stayed near zero, so it added little either way.";
const QUESTION = 'Is net liquidity rising or falling?';
const NOW = new Date('2026-10-13T00:30:00Z');

const text = (lines: Line[]): string => lines.map((l) => l.map(([, s]) => s).join('')).join('\n');
const shown = (s: Session, ascii = false): string => text(screen(s.state, ascii));
// Wrapped words read back as one paragraph.
const flat = (out: string): string => out.split('\n').map((l) => l.trim()).filter(Boolean).join(' ');
// The same, with the rule down the side of each column taken off.
const unruled = (out: string): string => flat(out.split('\n').map((l) => l.replace(/^\s*[│└]/, '')).join('\n'));
const press = (s: Session, ...keys: Key[]): void => keys.forEach((k) => s.key(k));
const typed = (words: string): Key[] => Array.from(words, (char): Key => ({ name: 'char', char }));
const enter: Key = { name: 'enter' };
const esc: Key = { name: 'escape' };
const step = (s: Session) => s.state.step as Extract<State['step'], { name: 'compare' }>;

// Words the compare view never uses (the wording review's list, 2026-10-12), with "checked" banned
// unless it is "not checked", and primerkit's own: no advice anywhere.
const BANNED = [/\bbetter\b/i, /more accurate/i, /\bwins?\b/i, /\bwinner/i, /\bverified\b/i, /\brecommend/i, /\btrust/i, /\breliab/i, /\bscore/i, /\brank/i, /\brating/i, /\bgrade/i, /\bshould\b/i, /\bbuy\b/i, /\bsell\b/i, /(?<!not )\bchecked\b/i];
const noBanned = (out: string, where: string): void => {
  for (const word of BANNED) expect(out, `${where}: ${word}`).not.toMatch(word);
};

// The stand in, as a hosted Claude model that reports what each call used.
class HostedReader extends ExtractiveModel {
  override readonly id = 'anthropic:claude-sonnet-5-5';
  override readonly label = 'claude-sonnet-5-5, Anthropic';
  calls = 0;
  constructor() {
    super('markdown');
  }
  override async capabilities(): Promise<ModelCapabilities> {
    return { ...(await super.capabilities()), local: false };
  }
  override async complete(packet: Packet): Promise<ModelReply> {
    this.calls += 1;
    return { ...(await super.complete(packet)), usage: { inputTokens: 900, outputTokens: 49 } };
  }
}

// Saved briefings that count each read.
class Counted extends FixtureConnector {
  readonly calls: string[] = [];
  override async fetch(req: { briefing: string; format: 'json' | 'markdown'; date?: string }) {
    this.calls.push(req.briefing);
    return super.fetch(req);
  }
}

// Anthropic's side as a recorded response, or a status, or a request that waits until it is
// stopped; every request is kept.
function webSide(answer: { status?: number; json?: string; hold?: boolean } = { json: RECORDED }) {
  const sent: Array<{ url: string; body: Record<string, unknown> }> = [];
  const f = ((input: string | URL | Request, init?: RequestInit) => {
    sent.push({ url: String(input), body: JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown> });
    if (answer.hold) return new Promise<Response>((_, reject) => init?.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true }));
    return Promise.resolve(new Response(answer.json ?? JSON.stringify({ type: 'error', error: { type: 'api_error', message: 'Internal server error' } }), { status: answer.status ?? 200, headers: { 'Content-Type': 'application/json' } }));
  }) as typeof fetch;
  return { fetch: f, sent };
}

// Anthropic's side over several turns, one answer a request, the last again for any after it.
function scriptedWeb(answers: Array<{ status?: number; json?: unknown }>) {
  const sent: Array<{ url: string; body: Record<string, unknown> }> = [];
  let next = 0;
  const f = ((input: string | URL | Request, init?: RequestInit) => {
    sent.push({ url: String(input), body: JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown> });
    const a = answers[Math.min(next++, answers.length - 1)]!;
    return Promise.resolve(new Response(JSON.stringify(a.json ?? { type: 'error', error: { type: 'api_error', message: 'Internal server error' } }), { status: a.status ?? 200, headers: { 'Content-Type': 'application/json' } }));
  }) as typeof fetch;
  return { fetch: f, sent };
}

// A first turn the server's loop paused after 2 paid searches, and each way a turn after it
// ends without an answer, with what the whole side used.
const PAUSED = {
  model: 'claude-sonnet-5-5',
  content: [
    { type: 'server_tool_use', id: 's1', name: 'web_search', input: { query: 'net liquidity this week' } },
    { type: 'web_search_tool_result', tool_use_id: 's1', content: [{ type: 'web_search_result', url: 'https://sample-central-bank.example/releases/weekly-balance-sheet/', title: 'Weekly balance sheet - Sample Central Bank', page_age: 'October 9, 2026', encrypted_content: 'fixture-body' }] },
    { type: 'server_tool_use', id: 's2', name: 'web_search', input: { query: 'Treasury cash balance this week' } },
    { type: 'web_search_tool_result', tool_use_id: 's2', content: [] },
  ],
  stop_reason: 'pause_turn',
  usage: { input_tokens: 1000, output_tokens: 50, server_tool_use: { web_search_requests: 2 } },
};
const ended = (stop_reason: string, text: string, searches = 0) => ({
  model: 'claude-sonnet-5-5',
  content: [{ type: 'text', text }, ...(searches ? [{ type: 'server_tool_use', id: 's3', name: 'web_search', input: { query: 'cash balance' } }, { type: 'web_search_tool_result', tool_use_id: 's3', content: [] }] : [])],
  stop_reason,
  usage: { input_tokens: 1200, output_tokens: 300, ...(searches ? { server_tool_use: { web_search_requests: searches } } : {}) },
});
const AFTER_PAID: Array<{ where: string; script: Array<{ status?: number; json?: unknown }>; reason: string; used: { searches: number; inputTokens: number; outputTokens: number } }> = [
  { where: 'a later turn that fails', script: [{ json: PAUSED }, { status: 500 }], reason: 'Anthropic answered 500: Internal server error', used: { searches: 2, inputTokens: 1000, outputTokens: 50 } },
  { where: 'a reply cut off', script: [{ json: PAUSED }, { json: ended('max_tokens', 'Net liquidity has been') }], reason: 'Claude ran out of room before its answer was finished (stop reason: max_tokens)', used: { searches: 2, inputTokens: 2200, outputTokens: 350 } },
  { where: 'a refusal', script: [{ json: PAUSED }, { json: ended('refusal', 'The balance sheet stood at') }], reason: 'Claude declined to answer (stop reason: refusal)', used: { searches: 2, inputTokens: 2200, outputTokens: 350 } },
  { where: 'a pause at the cap', script: [{ json: PAUSED }, { json: ended('pause_turn', "I'll search for the cash balance too.", 1) }], reason: 'Claude did not finish its answer in 3 rounds (stop reason: pause_turn)', used: { searches: 4, inputTokens: 3400, outputTokens: 650 } },
];

// A journal whose disk fills before the compare's own record is written.
class FullDisk extends Journal {
  override open(operationId: string, runId: string, now = new Date()) {
    const run = super.open(operationId, runId, now);
    const write = run.write.bind(run);
    run.write = (name, content) => {
      if (name === 'render.md') throw new Error(`ENOSPC: no space left on device, write '${name}'`);
      write(name, content);
    };
    return run;
  }
}

// A session at home on a hosted Claude model, with saved briefings and Anthropic's side faked.
function comparing(o: { model?: ConfigModel; web?: ReturnType<typeof webSide>; over?: Partial<SessionDeps>; tier?: Tier } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'primerkit-compare-'));
  const journal = new Journal(join(home, 'journal'));
  const data = new Counted(BENCH_BRIEFINGS);
  const reader = new HostedReader();
  const web = o.web ?? webSide();
  const deps: SessionDeps = {
    demo: null,
    env: {},
    platform: 'win32',
    config: { read: () => readConfig(home), write: (c) => writeConfig(home, c) },
    checkMachine: async () => ({ apps: [], keys: ['ANTHROPIC_API_KEY'], local: [], ollama: 'absent' }),
    catalog: async () => parseCatalog(JSON.parse(readFileSync(DEMO_CATALOG, 'utf8'))),
    resolveKey: () => ({ key: 'not-a-key', source: 'env' }),
    connect: () => ({ cancel: () => {} }),
    briefings: () => data,
    model: () => reader,
    listModels: async () => [],
    pull: async () => {},
    fitness: async () => {
      throw new Error('no check in these tests');
    },
    fitnessPlan: () => ({ calls: 0, tokens: 0 }),
    operation: ASK,
    digestOperation: DIGEST,
    journal,
    snapshots: new Snapshots(join(home, 'snapshots')),
    home,
    latestDigest: () => null,
    scheduler: null,
    scheduleEntry: (time) => digestEntry({ time, platform: 'win32', node: 'C:\\node\\node.exe', script: 'C:\\pk\\bin\\primerkit.js', cwd: 'C:\\pk' }),
    journalRows: () => journalRows(journal.root),
    journalOpen,
    openLink: () => false,
    copy: () => false,
    webSearch: (spec) => (spec.kind === 'hosted' && spec.provider === 'anthropic' ? new AnthropicWebSearch({ apiKey: 'not-a-key', model: spec.name, fetch: web.fetch }) : null),
    now: () => NOW,
    ...o.over,
  };
  writeConfig(home, { disclaimer_accepted_at: 'x', first_run_done_at: 'x', model: o.model ?? { kind: 'hosted', provider: 'anthropic', name: 'claude-sonnet-5-5' }, prereason: { tier: o.tier ?? 'free' } });
  const s = new Session(deps);
  s.start();
  return { s, deps, data, reader, web, journal };
}

async function planned(s: Session, question = QUESTION): Promise<void> {
  press(s, ...typed(`/compare ${question}`), enter);
  await s.idle();
}

async function answered(s: Session, question = QUESTION): Promise<void> {
  await planned(s, question);
  press(s, enter);
  await s.idle();
}

// The two columns of a side by side compare, as the rows between its headings and its footer.
function columns(lines: Line[], width: number): { left: string[]; right: string[]; rightSegments: Line[] } {
  const col = Math.floor((width - 2) / 2);
  const rows = lines.map((l) => l.map(([, s]) => s).join(''));
  const from = rows.findIndex((r) => r.startsWith(" From PreReason's briefings")) + 1;
  const to = rows.findIndex((r, i) => i > from && /^ [└+]/.test(r)) + 1;
  const body = rows.slice(from, to).map((r) => Array.from(r));
  // The web column's segments: those after the last rule of the row, the web column's own.
  const rightSegments = lines.slice(from, to).map((l) => l.slice(l.map(([role]) => role).lastIndexOf('rule') + 1));
  return { left: body.map((r) => r.slice(1, 1 + col).join('')), right: body.map((r) => r.slice(col + 2).join('')), rightSegments };
}

describe('the compare view, before it runs', () => {
  it('says everything it spends, each count from the plan, and runs nothing until Enter; Esc goes back', async () => {
    const { s, data, reader, web } = comparing();
    await planned(s);
    expect(step(s)).toMatchObject({ name: 'compare', phase: 'confirm' });
    const plan = step(s).plan!;
    expect(plan.read.length).toBeGreaterThan(0);
    expect(plan.preReasonCalls).toBe(plan.read.length);
    expect(plan.searches).toBe(5);
    const cost = compareCost(plan);
    expect(cost).toMatch(/^This asks claude-sonnet-5-5 twice: once with PreReason's briefings, once with its web search and no briefings\. About [\d,]+ tokens and up to 5 searches on your model key, about \$\d+\.\d{2} at list prices, and \d+ PreReason calls? on your plan\.$/);
    expect(cost).toContain(`and ${plan.read.length} PreReason ${plan.read.length === 1 ? 'call' : 'calls'} on your plan.`);
    const out = shown(s);
    expect(out).toContain(` › /compare ${QUESTION}\n\n Compare  two answers to one question\n`);
    expect(flat(out)).toContain(`two answers to one question ${cost} Enter runs it · Esc goes back`);
    expect(shown(s, true)).toContain('Enter runs it | Esc goes back');
    // Nothing has run: no model call, no search, no PreReason call.
    expect(reader.calls).toBe(0);
    expect(web.sent).toHaveLength(0);
    expect(data.calls).toEqual([]);
    press(s, esc);
    await s.idle();
    expect(s.state.step.name).toBe('home');
    expect(s.state.feed).toEqual([]);
    expect(reader.calls + web.sent.length + data.calls.length).toBe(0);
  });

  it('builds the cost line from the plan: the counts are the plan\'s, and every search is in the price', () => {
    const price = listPrice('claude-sonnet-5-5')!;
    const base = { model: 'claude-sonnet-5-5', price, question: 'Q?', operation: ASK, blockTokens: () => 2_000 };
    const one = comparePlan({ ...base, read: ['macro.snapshot'] });
    const three = comparePlan({ ...base, read: ['macro.snapshot', 'btc.pulse', 'treasury-10y'], searches: 2 });
    expect(compareCost(one)).toContain('up to 5 searches on your model key');
    expect(compareCost(one)).toContain(', and 1 PreReason call on your plan.');
    expect(compareCost(three)).toContain('up to 2 searches on your model key');
    expect(compareCost(three)).toContain(', and 3 PreReason calls on your plan.');
    expect(compareCost({ ...one, searches: 1 })).toContain('up to 1 search on your model key');
    // The tokens: the packet around the question, each briefing, the web side's words and
    // the pages each search adds, and both answers.
    expect(three.tokens.input - one.tokens.input).toBe(2 * 2_000 - 3 * PLAN_SIZES.search);
    expect(one.tokens.output).toBe(2 * PLAN_SIZES.answer);
    // The price is the plan's tokens at list prices and each search it may run at $0.01.
    expect(one.usd).toBeCloseTo(priceOf({ inputTokens: one.tokens.input, outputTokens: one.tokens.output }, price) + 0.05, 10);
    expect(three.usd).toBeCloseTo(priceOf({ inputTokens: three.tokens.input, outputTokens: three.tokens.output }, price) + 0.02, 10);
    expect(compareCost(one)).toContain(`about ${dollars(one.usd)} at list prices`);
    expect(compareCost(one)).toContain(`About ${(Math.round((one.tokens.input + one.tokens.output) / 1000) * 1000).toLocaleString('en-US')} tokens`);
    expect([dollars(0.08), dollars(0.004), dollars(0.0004)]).toEqual(['$0.08', '$0.004', 'under $0.001']);
  });

  it("says about what runs cost: five searches on Sonnet plan near the two live runs of 2026-10-16 ($0.22 and $0.19)", () => {
    const plan = comparePlan({ model: 'claude-sonnet-5-5', price: listPrice('claude-sonnet-5-5')!, question: QUESTION, read: ['macro.snapshot'], operation: ASK, blockTokens: () => 6_000 });
    expect(plan.searches).toBe(5);
    expect(plan.usd).toBeGreaterThan(0.16);
    expect(plan.usd).toBeLessThan(0.25);
  });

  it('counts the calls the run makes: a question naming two briefings says two, and the run reads those two only', async () => {
    const { s, data } = comparing();
    s.resize(77, 80);
    await planned(s, 'How do macro.snapshot and cross.correlations stand?');
    expect(step(s).plan!.read).toEqual(['macro.snapshot', 'cross.correlations']);
    expect(flat(shown(s))).toContain('and 2 PreReason calls on your plan.');
    expect(data.calls).toEqual([]);
    press(s, enter);
    await s.idle();
    expect([...data.calls].sort()).toEqual(['cross.correlations', 'macro.snapshot']);
    const { left } = columns(screen(s.state, false), 76);
    expect(flat(left.map((x) => x.replace(/^[│└] ?/, '')).join('\n'))).toContain('read: macro.snapshot, cross.correlations');
  });

  it("reads, on a Free key, the briefing that carries a metric for a question about a change, as ask does; a Basic key reads the metric", async () => {
    // The live run of 2026-10-16: on a Free key the compare read a metric alone, its latest
    // reading, and the briefing side said it supports no direction, beside a week of web pages.
    const METRICS: MetricEntry[] = [{ id: 'net-liquidity', name: 'Net Liquidity', description: 'Net liquidity proxy - Fed balance sheet minus reverse repo and Treasury account balances', category: 'macro' }];
    for (const [tier, read] of [['free', ['macro.snapshot']], ['basic', ['net-liquidity']]] as const) {
      const { s, data } = comparing({ tier, over: { metricCatalog: async () => METRICS } });
      Object.assign(data, { metricBlock: async (id: string) => blockFromMarkdown(id, '# Net Liquidity\n\n**Latest reading:** $5.87T\n', NOW.toISOString()) });
      s.resize(77, 80);
      await planned(s);
      expect(step(s).plan!.read, tier).toEqual(read);
    }
  });

  it('reads the briefings the plan names and never the news door, even for a question about what was filed', async () => {
    const { s, data } = comparing();
    const news = vi.fn();
    Object.assign(data, { news });
    s.resize(77, 80);
    await planned(s, 'What did macro.snapshot say was filed and released?');
    expect(step(s).plan!.read).toEqual(['macro.snapshot']);
    press(s, enter);
    await s.idle();
    expect(data.calls).toEqual(['macro.snapshot']);
    expect(news).not.toHaveBeenCalled();
    expect(flat(shown(s))).not.toContain('The briefings were not read.');
  });

  it('refuses in one plain line where it cannot run, and nothing runs', async () => {
    const said = async (model: ConfigModel | undefined, question = QUESTION, over: Partial<SessionDeps> = {}) => {
      const { s, data, reader, web } = comparing({ ...(model ? { model } : {}), over });
      await planned(s, question);
      expect(s.state.step.name).toBe('home');
      expect(reader.calls + web.sent.length + data.calls.length).toBe(0);
      return s.state.notice;
    };
    expect(await said({ kind: 'ollama', base_url: 'http://127.0.0.1:11434', name: 'qwen2.5:7b' })).toBe('/compare runs on hosted models only, and qwen2.5:7b is not one, so nothing runs.');
    expect(await said({ kind: 'openai-compatible', base_url: 'http://127.0.0.1:1234/v1', name: 'local-model' })).toBe('/compare runs on hosted models only, and local-model is not one, so nothing runs.');
    expect(await said({ kind: 'hosted', provider: 'openai', name: 'gpt-x' })).toBe('The web side of /compare runs on Anthropic models only, so nothing runs on gpt-x.');
    expect(await said({ kind: 'hosted', provider: 'anthropic', name: 'claude-test-2' })).toBe('primerkit has no list price for claude-test-2, so it cannot say what /compare costs before it runs, and nothing runs.');
    expect(await said(undefined, '')).toBe('Type a question after /compare, such as /compare Is net liquidity rising or falling?');
    expect(await said(undefined, QUESTION, { webSearch: undefined })).toBe('The web side of /compare cannot run here, so nothing runs.');
    expect(await said(undefined, QUESTION, { resolveKey: () => null })).toBe('PreReason is not connected, so there is nothing to compare yet.');
  });

  it('is in the menu, and choosing it waits for the question', () => {
    const row = menuRows('/com', { briefings: null, hosted: true }).find((r) => r.text === '/compare');
    expect(row).toEqual({ text: '/compare', about: 'one question, from the briefings and by web search', opens: true });
    noBanned(row!.about, 'the menu row');
  });
});

describe('the compare view, after it runs', () => {
  it('shows both answers side by side, each with what it read, what it spent and its time, and the footer', async () => {
    const { s, web, reader } = comparing();
    s.resize(77, 80);
    await answered(s);
    expect(step(s).phase).toBe('done');
    expect(reader.calls).toBe(1);
    expect(web.sent).toHaveLength(1);
    const lines = screen(s.state, false);
    const out = text(lines);
    expect(out).toContain(` › /compare ${QUESTION}\n\n From PreReason's briefings            From the model's web search\n`);
    const { left, right } = columns(lines, 76);
    const l = flat(left.map((r) => r.replace(/^[│└] ?/, '')).join('\n'));
    const r = flat(right.map((x) => x.replace(/^[│└] ?/, '')).join('\n'));
    const result = step(s).result!;
    const b = result.briefings;
    if (b.kind !== 'answer' || !b.figures) throw new Error('the briefing side did not answer');
    expect(b.figures.total).toBeGreaterThan(0);
    expect(l).toContain(`✓ ${b.figures.total} of ${b.figures.total} figures match the briefing lines cited`);
    expect(l).toContain(`read: ${b.view.briefings.join(', ')}`);
    expect(l).toMatch(/949 tokens · \d+\.\d s · \$0\.002/);
    expect(left.at(-1)).toMatch(/^└ {2}PR {2}/);
    // A line of parts breaks between its parts, where the column is too narrow for it whole.
    expect(right).toContain('│ figures not checked');
    expect(r).toContain('figures not checked cites 2 web pages');
    expect(r).toMatch(/3 searches · 4 pages · 7,800 tokens \d+\.\d s · \$0\.05/);
    expect(r).toContain('pages: sample-central-bank.example, sample-statistics.example, sample-reserve-desk.example, example-treasury.example');
    expect(right.at(-1)?.trim()).toBe('└');
    // Each column closes on the same row.
    expect(left.at(-1)?.startsWith('└')).toBe(true);
    expect(out.indexOf(` ${COMPARE_FOOTER}`)).toBeGreaterThan(out.lastIndexOf('└'));
    // The feed keeps it, as it was drawn.
    press(s, esc);
    expect(s.state.step.name).toBe('home');
    expect(s.state.feed.at(-1)).toMatchObject({ kind: 'compare', question: `/compare ${QUESTION}` });
  });

  it("shows the web side's text as the model returned it: every word in order, in one colour, nothing restated or marked", async () => {
    const { s } = comparing();
    s.resize(77, 80);
    await answered(s);
    const lines = screen(s.state, false);
    const { right, rightSegments } = columns(lines, 76);
    const end = right.findIndex((x) => x.includes('figures not checked'));
    const answerRows = right.slice(0, end).map((x) => x.replace(/^│ ?/, '')).filter((x) => x.trim());
    expect(answerRows.join(' ').replace(/\s+/g, ' ').trim()).toBe(WEB_TEXT.replace(/\s+/g, ' '));
    // The model's own paragraph break is kept as a blank row.
    expect(right.slice(0, end).some((x) => x.trim() === '│')).toBe(true);
    for (const segments of rightSegments.slice(0, end).filter((x) => x.length)) {
      expect(segments.map(([role]) => role)).toEqual(['fg']);
    }
    const result = step(s).result!;
    expect(result.web.kind === 'answer' ? result.web.text : '').toBe(WEB_TEXT);
  });

  it('never marks the web side, and no word of the view weighs one answer against the other, in every rendered fixture', async () => {
    const fixtures: Array<[string, string]> = [];
    const keep = (where: string, s: Session) => {
      for (const ascii of [false, true]) fixtures.push([`${where}${ascii ? ', ascii' : ''}`, shown(s, ascii)]);
    };
    for (const [columnsWide, rows] of [[77, 22], [77, 80], [60, 80], [49, 16]] as const) {
      const { s, journal } = comparing();
      s.resize(columnsWide, rows);
      await planned(s);
      keep(`the cost line at ${columnsWide}x${rows}`, s);
      press(s, enter);
      await s.idle();
      keep(`both answers at ${columnsWide}x${rows}`, s);
      for (let i = 0; i < 200; i++) press(s, { name: 'down' });
      keep(`both answers scrolled to the end at ${columnsWide}x${rows}`, s);
      const entry = s.state.feed.at(-1)!;
      for (const ascii of [false, true]) fixtures.push([`the feed entry at ${columnsWide}`, text(entryLines(s.state, maker(ascii), entry))]);
      const dir = readdirSync(join(journal.root, '2026-10-13', 'compare'))[0]!;
      fixtures.push(['render.md', readFileSync(join(journal.root, '2026-10-13', 'compare', dir, 'render.md'), 'utf8')]);
      // The web column holds no mark, beside the briefings or under them.
      for (const ascii of [false, true]) {
        const lines = screen({ ...s.state, step: { ...step(s), top: 0 } }, ascii);
        const webRows = columnsWide >= 73 ? columns(lines, columnsWide - 1).right : (() => {
          const rows2 = text(lines).split('\n');
          const from = rows2.findIndex((x) => x.startsWith(" From the model's web search"));
          return rows2.slice(from);
        })();
        for (const row of webRows) expect(row, `${columnsWide}x${rows}${ascii ? ' ascii' : ''}`).not.toMatch(ascii ? /\bok\b|\bx\b/ : /[✓✗]/);
      }
    }
    // A side that failed, and one whose web search failed.
    const failedWeb = comparing({ web: webSide({ status: 500 }) });
    failedWeb.s.resize(77, 60);
    await answered(failedWeb.s);
    keep('a web side that failed', failedWeb.s);
    const { right } = columns(screen(failedWeb.s.state, false), 76);
    expect(flat(right.map((x) => x.replace(/^[│└] ?/, '')).join('\n'))).toContain("The model's web search did not answer: Anthropic answered 500: Internal server error.");
    for (const row of right) expect(row).not.toMatch(/[✓✗]/);
    // A web side that failed after paid searches, each way, on screen and in the journal.
    for (const { where, script } of AFTER_PAID) {
      const f = comparing({ web: scriptedWeb(script) });
      f.s.resize(77, 60);
      await answered(f.s);
      keep(`a web side that failed after paid searches: ${where}`, f.s);
      for (const row of columns(screen(f.s.state, false), 76).right) expect(row, where).not.toMatch(/[✓✗]/);
      fixtures.push([`render.md, ${where}`, readFileSync(join(step(f.s).result!.journalDir!, 'render.md'), 'utf8')]);
    }
    // A journal that could not be written.
    const unkept = comparing({ over: { journal: new FullDisk(join(mkdtempSync(join(tmpdir(), 'primerkit-full-')), 'journal')) } });
    unkept.s.resize(77, 60);
    await answered(unkept.s);
    keep('a journal that could not be written', unkept.s);
    const failedLeft = comparing({ over: { model: () => Object.assign(new HostedReader(), { complete: async () => Promise.reject(new ModelError('Anthropic answered 529: Overloaded')) }) } });
    failedLeft.s.resize(77, 60);
    await answered(failedLeft.s);
    keep('a briefing side that failed', failedLeft.s);
    const failed = columns(screen(failedLeft.s.state, false), 76).left;
    expect(flat(failed.map((x) => x.replace(/^[│└] ?/, '')).join('\n'))).toContain('✗ The model did not answer: Anthropic answered 529: Overloaded.');
    // The refusals.
    for (const model of [{ kind: 'ollama', name: 'qwen2.5:7b' }, { kind: 'hosted', provider: 'openai', name: 'gpt-x' }, { kind: 'hosted', provider: 'anthropic', name: 'claude-test-2' }] as ConfigModel[]) {
      const { s } = comparing({ model });
      await planned(s);
      fixtures.push([`the refusal on ${model.name}`, s.state.notice ?? '']);
    }
    expect(fixtures.length).toBeGreaterThan(30);
    for (const [where, out] of fixtures) noBanned(out, where);
    // Each finished fixture keeps the footer whole.
    for (const [where, out] of fixtures.filter(([w]) => w.startsWith('both answers scrolled') || w.startsWith('render') || w.startsWith('the feed entry'))) expect(flat(out), where).toContain(COMPARE_FOOTER);
  }, 60_000);

  it('stacks the two on a narrow window, the briefings first, within the width', async () => {
    const { s } = comparing();
    s.resize(61, 120);
    await answered(s);
    const out = shown(s);
    const at = (words: string) => out.indexOf(words);
    expect(at(" From PreReason's briefings\n")).toBeGreaterThan(0);
    expect(at(" From the model's web search\n")).toBeGreaterThan(at('figures match the briefing lines cited'));
    expect(at('figures not checked · cites 2 web pages')).toBeGreaterThan(at(" From the model's web search"));
    for (const ascii of [false, true]) for (const line of screen(s.state, ascii)) expect(line.map(([, x]) => x).join('').length).toBeLessThanOrEqual(60);
  });

  it('asks the web side the question alone: no briefing, no line, only the day and the no advice rule', async () => {
    const { s, web, data } = comparing();
    await answered(s);
    const body = web.sent[0]!.body;
    expect(body.messages).toEqual([{ role: 'user', content: QUESTION }]);
    expect(body.system).toBe(webSystem(NOW));
    expect(webSystem(NOW)).toBe('Today is 2026-10-13. Answer the question with web search, describing conditions as the pages you read state them, and say which page each figure comes from. Add no advice, no forecast and no position.');
    const sent = JSON.stringify(body);
    for (const id of step(s).plan!.read) expect(sent).not.toContain(id);
    expect(sent).not.toContain('Net liquidity stable at $5.77T');
    expect(sent).not.toContain('[macro.snapshot');
    // The PreReason calls are the briefing side's, as the plan counted them.
    expect(data.calls).toEqual(step(s).plan!.read);
  });

  it('keeps both answers in the journal on this machine, with what each read, as one run', async () => {
    const { s, journal } = comparing();
    await answered(s);
    const days = readdirSync(journal.root);
    expect(days).toEqual(['2026-10-13']);
    // One folder: the briefing side is kept with the compare, not as an ask of its own.
    expect(readdirSync(join(journal.root, '2026-10-13'))).toEqual(['compare']);
    const dir = step(s).result!.journalDir!;
    expect(existsSync(dir)).toBe(true);
    const files = readdirSync(dir).sort();
    expect(files).toEqual(expect.arrayContaining(['compare.json', 'meta.json', 'render.md', 'web.request.json', 'web.response.json', 'briefings.packet.md', 'briefings.response.json', 'briefings.checks.json', 'briefings.pick.json']));
    const record = JSON.parse(readFileSync(join(dir, 'compare.json'), 'utf8')) as { question: string; briefings: { read: string[]; answer: string }; web: { text: string; pages: Array<{ url: string }>; cited: Array<{ url: string }> } };
    expect(record.question).toBe(QUESTION);
    expect(record.briefings.read).toEqual(step(s).plan!.read);
    expect(record.briefings.answer.length).toBeGreaterThan(0);
    expect(record.web.text).toBe(WEB_TEXT);
    expect(record.web.pages).toHaveLength(4);
    expect(record.web.cited.map((p) => p.url)).toEqual(['https://sample-central-bank.example/releases/weekly-balance-sheet/', 'https://example-treasury.example/datasets/daily-statement/']);
    expect(readFileSync(join(dir, 'web.response.json'), 'utf8')).not.toContain('encrypted');
    expect(readFileSync(join(dir, 'web.request.json'), 'utf8')).not.toContain('not-a-key');
    const render = readFileSync(join(dir, 'render.md'), 'utf8');
    expect(render).toContain(WEB_TEXT);
    expect(render).toContain(COMPARE_FOOTER);
    expect(journalRows(journal.root)[0]).toMatchObject({ operation: 'compare', title: QUESTION, outcome: 'two answers' });
    expect(journalOpen(dir).text).toBe(render);
    // The briefing side runs the ask's own checks, the direction check among them.
    const checks = JSON.parse(readFileSync(join(dir, 'briefings.checks.json'), 'utf8')) as Array<{ id: string }>;
    expect(checks.map((c) => c.id)).toEqual(['schema', 'citations', 'grounded_numbers', 'grounded_directions', 'scope']);
  });

  it('shows what a web side spent when it fails after paid searches, at list prices, with the reason; the journal keeps the same', async () => {
    const price = listPrice('claude-sonnet-5-5')!;
    for (const { where, script, reason, used } of AFTER_PAID) {
      const { s, web, journal } = comparing({ web: scriptedWeb(script) });
      s.resize(61, 120);
      await answered(s);
      expect(web.sent.length, where).toBeGreaterThan(1);
      const result = step(s).result!;
      const w = result.web;
      if (w.kind !== 'failed') throw new Error(`${where}: the web side was shown as an answer`);
      expect(w.message, where).toBe(reason);
      const usd = priceOf({ inputTokens: used.inputTokens, outputTokens: used.outputTokens }, price, used.searches);
      expect(w.spent, where).toMatchObject({ searches: used.searches, pages: 1, tokens: used.inputTokens + used.outputTokens });
      expect(w.spent.usd, where).toBeCloseTo(usd, 10);
      expect(usd, where).toBeGreaterThan(0.02);
      // The column: the reason, then what it spent, in the words a side that answered uses.
      const out = text(entryLines(s.state, maker(false), s.state.feed.at(-1)!));
      expect(unruled(out), where).toContain(`The model's web search did not answer: ${reason}.`);
      expect(out, where).toContain(webSpent(w.spent));
      expect(webSpent(w.spent), where).toContain(`${used.searches} searches · 1 page · ${(used.inputTokens + used.outputTokens).toLocaleString('en-US')} tokens · `);
      expect(webSpent(w.spent).endsWith(` · ${dollars(usd)}`), where).toBe(true);
      // The journal: the same spent in the record and the page, and what came back as far as it came.
      const dir = result.journalDir!;
      const record = JSON.parse(readFileSync(join(dir, 'compare.json'), 'utf8')) as { web: { outcome: string; message: string; spent: object } };
      expect(record.web, where).toEqual({ outcome: 'failed', message: reason, spent: w.spent });
      const render = readFileSync(join(dir, 'render.md'), 'utf8');
      expect(render, where).toContain(`The model's web search did not answer: ${reason}.\n\n${webSpent(w.spent)}\n`);
      const response = JSON.parse(readFileSync(join(dir, 'web.response.json'), 'utf8')) as { searches: number; usage: object };
      expect(response, where).toMatchObject({ searches: used.searches, usage: { inputTokens: used.inputTokens, outputTokens: used.outputTokens } });
      expect(readFileSync(join(dir, 'web.response.json'), 'utf8')).not.toContain('encrypted');
      expect(journalRows(journal.root)[0], where).toMatchObject({ operation: 'compare', outcome: 'one answer' });
    }
  });

  it('says the journal could not be written, and where, and still shows both answers', async () => {
    const root = join(mkdtempSync(join(tmpdir(), 'primerkit-full-')), 'journal');
    const { s } = comparing({ over: { journal: new FullDisk(root) } });
    s.resize(61, 120);
    await answered(s);
    expect(s.state.notice).not.toBe('Stopped. Nothing from this compare was kept.');
    expect(step(s).phase).toBe('done');
    const result = step(s).result!;
    expect(result.journalDir).toBeNull();
    expect(result.web.kind).toBe('answer');
    expect(result.briefings.kind).toBe('answer');
    const [dir] = readdirSync(join(root, '2026-10-13', 'compare'));
    const where = join(root, '2026-10-13', 'compare', dir!);
    expect(result.journalError).toBe(`The journal could not be written at ${where}: ENOSPC: no space left on device, write 'render.md'.`);
    // The part written before the failure is where the line says.
    expect(readdirSync(where)).toContain('compare.json');
    expect(readdirSync(where)).not.toContain('render.md');
    // Over the footer; a long folder name may break across lines, so it is read without spaces.
    const out = text(entryLines(s.state, maker(false), s.state.feed.at(-1)!));
    const tight = (x: string) => x.replace(/\s+/g, '');
    expect(tight(out)).toContain(tight(`${result.journalError} ${COMPARE_FOOTER}`));
    expect(unruled(out)).toContain('Reverse repo use stayed near zero, so it added little either way.');
  });

  it('stops both on Ctrl+C, and keeps nothing', async () => {
    const { s, journal, data } = comparing({ web: webSide({ hold: true }) });
    await planned(s);
    press(s, enter);
    await vi.waitFor(() => expect(step(s).progress?.done.briefings).toBe(true));
    expect(step(s).phase).toBe('running');
    const out = shown(s);
    expect(out).toContain('briefings: done');
    expect(out).toContain('web search: claude-sonnet-5-5 is searching and answering');
    expect(out).toContain('Ctrl+C stops both, and nothing from this compare is kept');
    noBanned(out, 'the running screen');
    expect(data.calls.length).toBe(step(s).plan!.read.length);
    press(s, { name: 'ctrl-c' });
    await s.idle();
    expect(s.state.step.name).toBe('home');
    expect(s.state.notice).toBe('Stopped. Nothing from this compare was kept.');
    expect(s.state.feed).toEqual([]);
    expect(existsSync(journal.root) ? readdirSync(journal.root) : []).toEqual([]);
  });
});

describe('the figures line', () => {
  const md = readFileSync(join(BENCH_BRIEFINGS, 'macro.snapshot.md'), 'utf8');
  const block = blockFromMarkdown('macro.snapshot', md, '2026-09-25T09:06:00.000Z');
  const line = (start: string) => block.lines.findIndex((l) => l.startsWith(start)) + 1;
  const net = line('Net liquidity stable');
  const tga = line('Treasury General Account at');

  it('counts the figures the claims state that their cited lines hold, the claims taken out included, by the check that ran', async () => {
    const answer = JSON.stringify({
      answer: 'Net liquidity is stable at $5.77T.',
      claims: [
        { text: 'Net liquidity is stable at $5.77T.', citations: [{ block: 'macro.snapshot', line: net, quote: 'Net liquidity stable at $5.77T' }] },
        { text: 'The Treasury General Account is at $977.08B, up 9.9% over 30d.', citations: [{ block: 'macro.snapshot', line: tga, quote: 'Treasury General Account at $977.08B' }] },
      ],
      not_in_data: [],
    });
    const result = await runOperation({ operation: ASK, question: QUESTION, blocks: [block], model: new ScriptedModel([answer]) });
    expect(result.outcome).toBe('partial');
    const figures = figuresOf(result)!;
    // 5.77 is held; 977.08 and 30 are held and 9.9 is not, in the claim taken out.
    expect(figures).toEqual({ matched: 3, total: 4, lines: 1 });
    expect(figuresLine(figures)).toEqual({ mark: 'failed', text: '3 of 4 figures match the briefing lines cited' });
    expect(figuresLine({ matched: 4, total: 4, lines: 2 })).toEqual({ mark: 'held', text: '4 of 4 figures match the briefing lines cited' });
    expect(figuresLine({ matched: 1, total: 1, lines: 1 }).text).toBe('1 of 1 figure matches the briefing lines cited');
    // The web side: an answer with no linked citation may name its pages in its words (the live
    // run of 2026-10-16 named three), so the line says what it lacks.
    expect(webStatus(0)).toBe('figures not checked · no linked citations');
    expect(webStatus(1)).toBe('figures not checked · cites 1 web page');
    expect(webStatus(2)).toBe('figures not checked · cites 2 web pages');
    expect(figuresLine({ matched: 0, total: 0, lines: 3 })).toEqual({ mark: null, text: 'no figures stated · cites 3 briefing lines' });
    // Where grounded_numbers did not run, there is no figures line at all.
    const unchecked = { ...ASK, spec: { ...ASK.spec, checks: ['schema', 'citations'] } };
    expect(figuresOf(await runOperation({ operation: unchecked, question: QUESTION, blocks: [block], model: new ScriptedModel([answer]) }))).toBeNull();
  });
});
