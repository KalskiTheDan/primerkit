// Speed loops: how fast primerkit draws and how much it sends, measured on this machine, into
// docs/gallery/perf. Free, with no key:
//   1. every screen of the first run, drawn again and again from the session's state, in
//      colour and in ASCII, and its picture (the SVG, and a raster frame);
//   2. the packet of each first question on the saved briefings, in JSON and Markdown: its
//      tokens, and the share before the question that a provider can cache;
//   3. the pick's packet, which a hosted model reads before it answers, on the saved catalog
//      and on any catalog file named with --catalog, with what it costs on Claude Sonnet 5.5.
// With --live N, each first question is also asked N times on the local model (qwen2.5:7b in
// Ollama) on the PreReason key in PREREASON_API_KEY: seconds, tokens read and checks. No model
// is paid for. Run with `npm run perf [-- --live 3] [-- --catalog <catalog.json> --metrics <metrics.json>]`.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildPacket, loadOperation, tokenCount, writeConfig, type DataBlock } from '@primerkit/core';
import { FixtureConnector, parseCatalog, type MetricEntry, type Pickable } from '@primerkit/connector-prereason';
import { ASK_DIR, BENCH_BRIEFINGS, DEMO_CATALOG, FIRST_QUESTIONS, FIRST_RUN_WALK, Session, demoDeps, pickPacket, realDeps, screen, type Key } from '@primerkit/session';
import { GALLERY_MACHINE, SONNET, rasterise, screenSvg } from './gallery';
import { spread } from './storyboard';

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const OUT = join(ROOT, 'docs', 'gallery', 'perf');
const COLUMNS = 100;
const ROWS = 30;
const DRAWS = 200;
const PICTURES = 5;
const LOCAL_MODEL = 'qwen2.5:7b';
const PACE_MS = 20_000;
const REST_MS = 65_000;

export interface Drawing {
  screen: string;
  colourMs: ReturnType<typeof spread>;
  asciiMs: ReturnType<typeof spread>;
  svgMs: ReturnType<typeof spread>;
  rasterMs: ReturnType<typeof spread>;
}
export interface PacketSize {
  question: string;
  briefings: string[];
  json: number;
  markdown: number;
  cacheable: number; // the tokens before the question, in the smaller format
}
export interface PickSize {
  catalog: string;
  entries: number;
  tokens: number;
  usd: number; // at Claude Sonnet 5.5's list price, read whole
  usdCached: number; // with the catalog read from a provider's cache
}
export interface LiveAnswer {
  round: number;
  question: string;
  outcome: string;
  seconds: number | null;
  tokens: number | null;
  checks: string;
  read: string[];
  why?: string; // a failure's own words: its checks, or a read PreReason refused
}

const enter: Key = { name: 'enter' };
const typed = (text: string): Key[] => Array.from(text, (char): Key => ({ name: 'char', char }));
const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));
const timed = async (n: number, f: () => unknown): Promise<number[]> => {
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    const t0 = performance.now();
    await f();
    out.push(performance.now() - t0);
  }
  return out;
};

// What the pick costs on Claude Sonnet 5.5, read whole and read from a cache, with a short reply.
export function pickCost(tokens: number, reply = 60): { usd: number; usdCached: number } {
  const round = (n: number) => Math.round(n * 10_000) / 10_000;
  return { usd: round((tokens * SONNET.input + reply * SONNET.output) / 1e6), usdCached: round((tokens * SONNET.cacheRead + reply * SONNET.output) / 1e6) };
}

async function drawings(): Promise<Drawing[]> {
  const session = new Session({ ...demoDeps({ version: 'perf' }), checkMachine: async () => GALLERY_MACHINE });
  session.resize(COLUMNS, ROWS);
  session.start();
  const out: Drawing[] = [];
  for (const step of FIRST_RUN_WALK) {
    for (const k of step.keys) session.key(k);
    if (step.wait !== false) await session.idle();
    const lines = screen(session.state, false);
    const svg = screenSvg(lines, COLUMNS, ROWS, step.title);
    out.push({
      screen: step.title,
      colourMs: spread(await timed(DRAWS, () => screen(session.state, false))),
      asciiMs: spread(await timed(DRAWS, () => screen(session.state, true))),
      svgMs: spread(await timed(PICTURES * 4, () => screenSvg(lines, COLUMNS, ROWS, step.title))),
      rasterMs: spread(await timed(PICTURES, () => rasterise(svg))),
    });
  }
  await session.idle();
  return out;
}

async function packets(): Promise<PacketSize[]> {
  const operation = loadOperation(ASK_DIR);
  const saved = new FixtureConnector(BENCH_BRIEFINGS);
  const out: PacketSize[] = [];
  for (const q of FIRST_QUESTIONS) {
    const of = async (format: 'json' | 'markdown'): Promise<DataBlock[]> => Promise.all(q.briefings.map((briefing) => saved.fetch({ briefing, format })));
    const sized = async (format: 'json' | 'markdown') => {
      const packet = buildPacket({ operation, question: q.question, blocks: await of(format), questionLast: true });
      return { tokens: tokenCount(packet.text), cacheable: tokenCount(packet.text.slice(0, packet.cachePrefix ?? 0)) };
    };
    const json = await sized('json');
    const markdown = await sized('markdown');
    out.push({ question: q.question, briefings: q.briefings, json: json.tokens, markdown: markdown.tokens, cacheable: Math.min(json.tokens, markdown.tokens) === json.tokens ? json.cacheable : markdown.cacheable });
  }
  return out;
}

export function pickSize(catalog: string, entries: Pickable[], today: string): PickSize {
  const tokens = tokenCount(pickPacket('Where does Bitcoin stand?', entries, today).text);
  return { catalog, entries: entries.length, tokens, ...pickCost(tokens) };
}

async function live(rounds: number): Promise<{ answers: LiveAnswer[]; callsUsed: number | null }> {
  const env = { ...process.env };
  if (!env.PREREASON_API_KEY) throw new Error('--live reads PreReason with the key in PREREASON_API_KEY, and none is set');
  delete env.ANTHROPIC_API_KEY; // the local model answers: nothing is paid for
  const home = mkdtempSync(join(tmpdir(), 'pk-perf-'));
  const answers: LiveAnswer[] = [];
  try {
    writeConfig(home, { first_run_done_at: new Date().toISOString(), disclaimer_accepted_at: new Date().toISOString(), model: { kind: 'ollama', name: LOCAL_MODEL } });
    const session = new Session(realDeps({ version: 'perf', env: { ...env, PRIMERKIT_HOME: home } }));
    session.resize(COLUMNS, ROWS);
    session.start();
    let first: number | null = null;
    for (let round = 1; round <= rounds; round++) {
      for (const q of FIRST_QUESTIONS) {
        if (answers.length) await sleep(PACE_MS);
        // A question PreReason's per-minute limit refused is asked once more after a rest.
        for (let attempt = 0; attempt < 2; attempt++) {
          for (const k of [...typed('/clear'), enter, ...typed(q.question), enter]) session.key(k);
          await session.idle();
          const last = session.state.feed.at(-1);
          if (!(last?.kind === 'failed' && /rate limit|wait/i.test(`${last.message} ${last.detail ?? ''}`)) || attempt) break;
          console.log(`round ${round}: ${q.question}: PreReason's limit; asked again after a rest`);
          await sleep(REST_MS);
        }
        first ??= session.state.callsLeft;
        const e = session.state.feed.at(-1);
        answers.push(
          e?.kind === 'answer'
            ? { round, question: q.question, outcome: e.view.partial ? 'partial' : 'answered', seconds: e.view.seconds, tokens: e.view.tokens, checks: `${e.view.checks.passed} of ${e.view.checks.total}`, read: e.view.briefings }
            : { round, question: q.question, outcome: e?.kind ?? 'nothing', seconds: null, tokens: null, checks: '', read: [], why: e?.kind === 'failed' ? [e.message, e.detail].filter(Boolean).join(' ') : e?.kind === 'note' ? e.text : '' },
        );
        console.log(`round ${round}: ${q.question} ${answers.at(-1)!.outcome} ${answers.at(-1)!.seconds ?? '-'} s ${answers.at(-1)!.why ?? ''}`);
      }
    }
    await session.idle();
    const last = session.state.callsLeft;
    return { answers, callsUsed: first !== null && last !== null ? first - last : null };
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

const ms = (s: ReturnType<typeof spread>) => `${s.p50} / ${s.p95} / ${s.max}`;

export function perfReadme(at: string, d: Drawing[], p: PacketSize[], picks: PickSize[], l: { answers: LiveAnswer[]; callsUsed: number | null } | null): string {
  return [
    '# Speed loops',
    '',
    `Measured ${at} on ${process.platform} with Node ${process.version} by \`npm run perf\`. Milliseconds are median / 95th / most.`,
    '',
    `## Drawing (${DRAWS} draws of each screen, ${PICTURES * 4} SVGs, ${PICTURES} rasters)`,
    '',
    '| screen | colour, ms | ASCII, ms | SVG, ms | raster, ms |',
    '|---|---|---|---|---|',
    ...d.map((x) => `| ${x.screen} | ${ms(x.colourMs)} | ${ms(x.asciiMs)} | ${ms(x.svgMs)} | ${ms(x.rasterMs)} |`),
    '',
    '## Packets of the first questions, on the saved briefings',
    '',
    'Tokens by the o200k_base count, a proxy. Cacheable: the tokens before the question, which a provider can serve from its cache when the same briefings are asked again.',
    '',
    '| question | briefings | JSON | Markdown | cacheable |',
    '|---|---|---|---|---|',
    ...p.map((x) => `| ${x.question} | ${x.briefings.join(', ')} | ${x.json.toLocaleString('en-US')} | ${x.markdown.toLocaleString('en-US')} | ${x.cacheable.toLocaleString('en-US')} |`),
    '',
    "## The pick, a hosted model's first step",
    '',
    `The catalog the model picks from, read before every question it is not named in. Cost at Claude Sonnet 5.5's list price (${SONNET.model}), with a 60 token reply; cached is the catalog read from the provider's cache.`,
    '',
    '| catalog | entries | tokens | read whole | cached |',
    '|---|---|---|---|---|',
    ...picks.map((x) => `| ${x.catalog} | ${x.entries} | ${x.tokens.toLocaleString('en-US')} | $${x.usd.toFixed(4)} | $${x.usdCached.toFixed(4)} |`),
    '',
    ...(l
      ? [
          `## Live, on ${LOCAL_MODEL} in Ollama and a PreReason key`,
          '',
          `${l.answers.length} questions${l.callsUsed !== null ? `, ${l.callsUsed} PreReason calls` : ''}.`,
          '',
          '| round | question | outcome | read | seconds | tokens read | checks |',
          '|---|---|---|---|---|---|---|',
          ...l.answers.map((a) => `| ${a.round} | ${a.question} | ${a.outcome}${a.why ? `: ${a.why.replace(/\|/g, '\\|')}` : ''} | ${a.read.join(', ') || '-'} | ${a.seconds === null ? '-' : a.seconds.toFixed(1)} | ${a.tokens?.toLocaleString('en-US') ?? '-'} | ${a.checks || '-'} |`),
          '',
        ]
      : []),
  ].join('\n');
}

async function main(): Promise<void> {
  const flag = (name: string) => {
    const i = process.argv.indexOf(name);
    return i < 0 ? undefined : process.argv[i + 1];
  };
  const today = new Date().toISOString().slice(0, 10);
  const d = await drawings();
  console.log(`drew ${d.length} screens`);
  const p = await packets();
  const picks = [pickSize('the saved catalog (2026-09-26)', parseCatalog(JSON.parse(readFileSync(DEMO_CATALOG, 'utf8'))), today)];
  // A catalog as PreReason serves it ({ briefings }), or as primerkit's cache keeps it ({ value }).
  const listOf = <T>(file: string, raw: (body: unknown) => T[]): T[] => {
    const body = JSON.parse(readFileSync(file, 'utf8')) as { value?: T[] };
    return Array.isArray(body.value) ? body.value : raw(body);
  };
  const catalogFile = flag('--catalog');
  if (catalogFile) {
    const briefings = listOf(catalogFile, parseCatalog);
    const metricsFile = flag('--metrics');
    const metrics = metricsFile ? listOf<MetricEntry>(metricsFile, (body) => (body as { metrics?: MetricEntry[] }).metrics ?? []) : [];
    picks.push(pickSize(`a key's catalog: ${briefings.length} briefings${metrics.length ? ` and ${metrics.length} metrics` : ''}`, [...briefings, ...metrics], today));
  }
  const rounds = Number(flag('--live') ?? 0);
  const l = rounds > 0 ? await live(rounds) : null;
  const at = new Date().toISOString().slice(0, 16).replace('T', ' ') + ' UTC';
  mkdirSync(OUT, { recursive: true });
  writeFileSync(join(OUT, 'perf.json'), JSON.stringify({ at, node: process.version, platform: process.platform, drawings: d, packets: p, picks, live: l }, null, 1));
  writeFileSync(join(OUT, 'README.md'), perfReadme(at, d, p, picks, l));
  console.log(`Speed loops in ${OUT}`);
}

// Run as a script (npm run perf), not when a test imports what it measures with.
if (/perf\.ts$/.test(process.argv[1] ?? '')) await main();
