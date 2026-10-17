// The storyboard: primerkit as a person uses it, one journey for each angle a persona test
// reads (the first five minutes, choosing a model, asking, a company, the daily reading, a
// later start, building rules), each a run of screens with a line under each and a GIF of the
// same steps, into docs/gallery/storyboard with a page to open in a browser, and how fast
// each went. Run with `npm run storyboard`.
//
// The first journey is the demo, with no key. The others are a real session in a scratch home,
// on the PreReason key in PREREASON_API_KEY and the local model qwen2.5:7b in Ollama, so no
// model is paid for. PreReason's reads are paced to the calls it allows a minute.
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { newRoutine, writeConfig, type Config } from '@primerkit/core';
import { FIRST_RUN_WALK, Session, demoDeps, realDeps, screen, type Key, type SessionDeps, type WalkStep, type WalkedScreen } from '@primerkit/session';
import { GALLERY_MACHINE, gifOf, rasterise, refuseKeys, screenSvg } from './gallery';

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const OUT = join(ROOT, 'docs', 'gallery', 'storyboard');
const COLUMNS = 100;
const ROWS = 30;
const PACE_MS = 125_000;
const LOCAL_MODEL = 'qwen2.5:7b';

// A step of a journey: the keys pressed, the line shown under its screen (a still is drawn
// only for a step with one), its time in the GIF, a rest before it for PreReason's limit, and
// for work that runs, frames after it a moment apart with the spinner turning, as it turns in
// a terminal.
export type Step = WalkStep & { caption?: string; hold?: number; pause?: number; spin?: number };
const SPIN_MS = 150;

export interface Journey {
  id: string;
  title: string;
  who: string; // the person this angle reads for
  data: 'demo' | 'live';
  home: 'demo' | 'model' | 'no-model'; // the demo; a home with the local model chosen; one with none
  routine?: boolean; // the rule builder's routine is made first, with a backtest
  homeFrom?: string; // a later start in the home an earlier journey left: its journal and digest
  steps: Step[];
}

const enter: Key = { name: 'enter' };
const esc: Key = { name: 'escape' };
const typed = (text: string): Key[] => Array.from(text, (char): Key => ({ name: 'char', char }));
// Typed a few characters a frame, as a person types.
const typing = (text: string, every = 5): Step[] => Array.from({ length: Math.ceil(text.length / every) }, (_, i) => ({ title: `typing ${i}`, keys: typed(text.slice(i * every, (i + 1) * every)), wait: false, hold: 80 }));
// A command typed and run, its screen held, then closed. A slow one is shown while it runs.
const run = (text: string, caption: string, hold = 3500, pause?: number, slow = false): Step[] => [
  ...typing(text).map((s, i) => (i === 0 && pause ? { ...s, pause } : s)),
  ...(slow ? [{ title: `${text}, running`, keys: [enter], wait: false, hold: SPIN_MS, spin: 8 }, { title: text, keys: [], caption, hold }] : [{ title: text, keys: [enter], caption, hold }]),
  { title: `${text}, closed`, keys: [esc, esc] },
];
// A question typed and asked, its run shown as it goes, and its answer.
const ask = (question: string, captions: { running: string; answer: string }): Step[] => [
  ...typing(question),
  { title: `${question}, choosing`, keys: [enter], wait: false, caption: captions.running, hold: SPIN_MS, spin: 8 },
  { title: `${question}, running 1`, keys: [], wait: false, pause: 1000, hold: SPIN_MS, spin: 8 },
  { title: `${question}, running 2`, keys: [], wait: false, pause: 1500, hold: SPIN_MS, spin: 8 },
  { title: `${question}, answered`, keys: [], caption: captions.answer, hold: 6000 },
];

const FIRST_RUN_CAPTIONS: Record<string, string> = {
  '1. Welcome': 'The welcome: what primerkit is and is not, accepted with one Enter.',
  '2. Step 1: where the model runs': 'Step 1 looks at this machine and offers where the model runs.',
  '4. Step 2: connect PreReason': 'Step 2 connects PreReason, where the data comes from. The demo uses saved briefings.',
  '5. Step 3: the first question': 'Step 3 offers a first question.',
  'Step 3 while the answer runs': 'While it runs: the briefings it reads, and how many tokens.',
  '6. Step 3: the answer arrives': 'The answer: each claim cited to a line of a briefing, its checks passed.',
  '7. Step 4: a morning digest': "Step 4 offers a morning digest on this machine's own scheduler.",
  '8. Step 4: the entry, before it is added': 'The scheduler entry is shown before anything is added.',
  '9. Home': 'Home: ask in plain words, or type / for a command.',
  '10. A question while it runs': 'A question of your own, while it runs.',
  '11. The same question, answered': 'Answered, with its citations.',
};

// Example rules for the rule builder's screens. primerkit ships none: a person writes their own.
export const EXAMPLE_RULES = `# Example rules, written for the storyboard. primerkit ships none.

Give enter when net liquidity rose over the last 7 days and the 10 year Treasury yield fell.
Give exit when net liquidity fell over the last 7 days.
Give watch otherwise.
`;

export const JOURNEYS: Journey[] = [
  {
    id: 'first-five-minutes',
    title: 'The first five minutes',
    who: 'A person who has just installed it: from the first screen to a first cited answer, with no key and no model.',
    data: 'demo',
    home: 'demo',
    steps: FIRST_RUN_WALK.map((s) => ({ ...s, ...(FIRST_RUN_CAPTIONS[s.title] ? { caption: FIRST_RUN_CAPTIONS[s.title] } : {}), hold: s.wait === false ? 1200 : 3000 })),
  },
  {
    id: 'choosing-a-model',
    title: 'Choosing a model',
    who: 'A person deciding where the model runs: what this machine has, a local model picked, and its check before any answer is trusted.',
    data: 'live',
    home: 'no-model',
    steps: [
      { title: 'Where the model runs', keys: [], caption: 'With no model chosen, primerkit looks at this machine: the AI apps, which keys are set (by name only), and the local models running.', hold: 4000 },
      { title: 'The check starts', keys: [enter], wait: false, caption: 'Picking the local model starts its check: questions whose answers are known.', hold: SPIN_MS, spin: 8 },
      { title: 'The check runs 1', keys: [], wait: false, pause: 2500, hold: SPIN_MS, spin: 8 },
      { title: 'The check runs 2', keys: [], wait: false, pause: 3500, caption: 'Each part as it runs: the answer shape, the citations, the reading, the speed.', hold: SPIN_MS, spin: 8 },
      { title: 'The verdict', keys: [], caption: 'The verdict, part by part, kept in the journal.', hold: 5000 },
      { title: 'Home with the model', keys: [enter], caption: 'Home, with the model named at the top.', hold: 3000 },
    ],
  },
  {
    id: 'asking',
    title: 'Asking questions',
    who: 'A person asking in plain words: how the briefings are chosen, read and answered, and what each claim rests on.',
    data: 'live',
    home: 'model',
    steps: [
      { title: 'Home', keys: [], caption: 'Home, on a PreReason key and the local model.', hold: 2500 },
      ...ask('Is net liquidity rising or falling this week?', {
        running: 'The question goes: primerkit chooses what can answer it, a fact from its own series.',
        answer: 'The answer, each claim cited and checked, and the briefing that holds what drives it named.',
      }),
      ...ask('macro.snapshot: which series moved most over 7 days?', {
        running: 'Naming a briefing reads that briefing.',
        answer: 'Answered from the named briefing alone.',
      }),
      ...typing('/journal'),
      { title: '/journal', keys: [enter], caption: 'Every run is kept on this machine, in the journal.', hold: 4000 },
      { title: 'A run opened', keys: [enter], caption: 'A run opened from the journal: the question, what was read, and the answer, as kept.', hold: 5000 },
      { title: 'The journal, closed', keys: [esc, esc, esc] },
    ],
  },
  {
    id: 'a-company',
    title: 'A company',
    who: 'A person asking about one company: its briefing named in the question, read, and answered with each figure cited.',
    data: 'live',
    home: 'model',
    steps: [
      { title: 'Home', keys: [], caption: 'Home, on a PreReason key and the local model.', hold: 2000 },
      ...ask('equities.company/odfl: how did revenue change in the latest quarter?', {
        running: 'Naming a company reads its briefing alone: equities.company/ and its code.',
        answer: "What the local model made of the company's briefing, held to its checks: an answer that fails them is not shown.",
      }),
      ...ask('equities.company/odfl: what was revenue for the quarter ended June 30, 2026?', {
        running: "A quarter's end names the quarter: the briefing is read as it stands now.",
        answer: 'Read as it stands now, held to the same checks.',
      }),
    ],
  },
  {
    id: 'daily-reader',
    title: 'The daily reading',
    who: 'A person who reads the markets each morning: the digest, a board, and the charts.',
    data: 'live',
    home: 'model',
    steps: [
      ...run('/digest', 'The digest: what changed in the watchlist since the last one.', 6000, undefined, true),
      ...run('/brief macro.snapshot fill', 'A briefing as a board: each level, its 7 and 30 day change, 30 days of it, and where it sits in its history.', 6000),
      ...typing('/chart '),
      { title: 'The chart menu', keys: [], wait: false, caption: 'Typing /chart lists every chart, each with what it shows.', hold: 4000 },
      { title: 'The chart menu, closed', keys: [esc, esc] },
      ...run('/chart yield curve', 'The yield curve now, and 30 days ago.', 5000, PACE_MS),
      ...run('/chart liquidity', 'Net liquidity and the parts it is made of, each with a bar to scale, reverse repo too.', 5000),
      ...run('/chart treasury', 'The Bitcoin treasury holders: the companies that hold Bitcoin, and how much each holds.', 5000, PACE_MS),
      ...run('/chart correlations', 'How Bitcoin correlates with equities, volatility and the dollar.', 5000),
      ...run('/chart etf flows', 'The spot Bitcoin ETFs: the flows in and out, fund by fund.', 5000, PACE_MS),
      ...run('/chart bitcoin', "Bitcoin's price over 90 days.", 5000),
      ...run('/chart hashprice', "Hashprice, what a miner earns for its hash, from the days the journal has kept.", 5000, PACE_MS),
      // The market map reads nine metrics, the markets eighteen and positioning five, so each comes after a rest.
      ...run('/chart market map', 'Nine markets by their 7 day change, in equal tiles never sized or ordered by value, each source named.', 5000, PACE_MS),
      ...run('/chart markets', 'The markets by asset class, a tile each, green for a rise and red for a fall, crypto last.', 5000, PACE_MS),
      ...run('/chart positioning', 'SPY beside the speculative net position in S&P 500 futures, marked futures, with where it sits in its own history.', 5000, PACE_MS),
      ...run('/catalog', 'Everything this key can ask about, as a table by area.', 4000),
    ],
  },
  {
    id: 'a-later-start',
    title: 'A later start',
    who: 'A person coming back the next morning: the opening, with what changed since last time and the next steps, then a question.',
    data: 'live',
    home: 'model',
    homeFrom: 'daily-reader',
    steps: [
      { title: 'The opening', keys: [], caption: "A later start opens calmly: a greeting by the hour, the model and PreReason as they stand, today's digest, and three next steps.", hold: 7000 },
      ...ask('Is the yield curve still inverted?', {
        running: 'A question: the opening gives the answers its room.',
        answer: 'Answered, with its citations.',
      }),
    ],
  },
  {
    id: 'rule-builder',
    title: 'Building rules',
    who: 'A person with rules of their own: a routine that applies them, its forward record, and a backtest. The model only picks a label; the sizes are the person\'s.',
    data: 'live',
    home: 'model',
    routine: true,
    steps: [
      ...run('/routine', 'Your routines.', 3000),
      ...run('/routine example', 'A routine: what it reads, its model, its rules and what each label holds.', 5000),
      ...run('/routine example rules', 'Its rules, in the person\'s own words (these are an example; primerkit ships none).', 5000),
      ...run('/routine example track run', 'The forward record: the routine once now, its label written before the outcome exists.', 6000),
      ...run('/routine example track', 'The record so far, a label a day.', 4000),
      ...run('/routine example replay', 'A backtest over a past window, in three arms, through a simulated account.', 6000),
    ],
  },
];

// The steps walked, a screen after each, with a rest where a step asks for one. The session's
// clock is ticked as a terminal ticks it, so a spinner turns from one frame to the next.
const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));
interface Shot extends WalkedScreen {
  step: number;
  hold: number | undefined;
}
// How fast it went: each screen drawn from the session's state, each picture made of it, and
// each answer's time, tokens and checks as the session measured them.
export interface Speed {
  journey: string;
  seconds: number; // the journey walked, its rests for PreReason's limit included
  screens: number;
  drawMs: { p50: number; p95: number; max: number }; // a screen drawn from the session's state
  pictureMs: { p50: number; p95: number; max: number }; // its SVG and the raster of a GIF frame
  answers: Array<{ question: string; seconds: number; tokens: number; checks: string; read: string[] }>;
}

export function spread(ms: number[]): Speed['drawMs'] {
  if (!ms.length) return { p50: 0, p95: 0, max: 0 };
  const sorted = [...ms].sort((a, b) => a - b);
  const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1)]!;
  const round = (n: number) => Math.round(n * 100) / 100;
  return { p50: round(at(0.5)), p95: round(at(0.95)), max: round(sorted.at(-1)!) };
}

async function walkJourney(deps: SessionDeps, steps: Step[]): Promise<{ shots: Shot[]; drawMs: number[]; answers: Speed['answers'] }> {
  const session = new Session(deps);
  session.resize(COLUMNS, ROWS);
  session.start();
  const out: Shot[] = [];
  const drawMs: number[] = [];
  const drawn = () => {
    const t0 = performance.now();
    const lines = screen(session.state, false);
    drawMs.push(performance.now() - t0);
    return lines;
  };
  for (const [i, step] of steps.entries()) {
    if (step.pause) await sleep(step.pause);
    for (const k of step.keys) session.key(k);
    if (step.wait !== false) await session.idle();
    session.tick();
    out.push({ step: i, title: step.title, lines: drawn(), hold: step.hold });
    for (let s = 0; s < (step.spin ?? 0); s++) {
      await sleep(SPIN_MS);
      session.tick();
      out.push({ step: i, title: `${step.title}, ${s + 1}`, lines: drawn(), hold: SPIN_MS });
    }
  }
  await session.idle();
  const answers = session.state.feed.flatMap((e) => (e.kind === 'answer' ? [{ question: e.question, seconds: e.view.seconds, tokens: e.view.tokens, checks: `${e.view.checks.passed} of ${e.view.checks.total}`, read: e.view.briefings }] : []));
  return { shots: out, drawMs, answers };
}

const slug = (s: string) => s.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').toLowerCase();
const html = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export interface Drawn {
  journey: Journey;
  stills: Array<{ file: string; caption: string }>;
  gif: string | null;
}

// The page that shows every journey: who it reads for, its GIF, and its stills with their
// lines, then what is not here and why. Plain HTML and its own CSS; nothing is fetched.
export function storyboardHtml(drawn: Drawn[], missing: Array<{ title: string; why: string }>, at: string, speeds: Speed[] = []): string {
  const ms = (s: Speed['drawMs']) => `${s.p50} / ${s.p95} / ${s.max}`;
  const speed = speeds.length
    ? [
        '<section id="speed"><h2>Speed</h2>',
        '<p class="note">Measured as the storyboard was drawn, on this machine: a screen drawn from the session\'s state, its picture (the SVG, and the raster of a GIF frame), and each answer as the session timed it. Milliseconds are median / 95th / most.</p>',
        '<table><tr><th>journey</th><th>walked</th><th>screens</th><th>draw a screen, ms</th><th>its picture, ms</th></tr>',
        ...speeds.map((s) => `<tr><td>${html(s.journey)}</td><td>${s.seconds} s</td><td>${s.screens}</td><td>${ms(s.drawMs)}</td><td>${ms(s.pictureMs)}</td></tr>`),
        '</table>',
        ...(speeds.some((s) => s.answers.length)
          ? ['<table><tr><th>question</th><th>read</th><th>answered in</th><th>tokens read</th><th>checks</th></tr>', ...speeds.flatMap((s) => s.answers.map((a) => `<tr><td>${html(a.question)}</td><td>${html(a.read.join(', '))}</td><td>${a.seconds.toFixed(1)} s</td><td>${a.tokens.toLocaleString('en-US')}</td><td>${a.checks}</td></tr>`)), '</table>']
          : []),
        '</section>',
      ]
    : [];
  const section = (d: Drawn) => [
    `<section id="${d.journey.id}">`,
    `<h2>${html(d.journey.title)}</h2>`,
    `<p class="who">${html(d.journey.who)}</p>`,
    `<p class="data">${d.journey.data === 'demo' ? 'The demo: saved briefings, no key, no model.' : `Live: a PreReason key and the local model ${LOCAL_MODEL}.`}</p>`,
    ...(d.gif ? [`<figure class="gif"><img src="${d.gif}" alt="${html(d.journey.title)}, as it moves"></figure>`] : []),
    '<div class="stills">',
    ...d.stills.map((s, i) => `<figure><img src="${s.file}" alt="${html(s.caption)}"><figcaption><b>${i + 1}.</b> ${html(s.caption)}</figcaption></figure>`),
    '</div>',
    '</section>',
  ];
  return [
    '<!doctype html>',
    '<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">',
    '<title>primerkit storyboard</title>',
    '<style>',
    ':root{--bg:#16120f;--panel:#201a16;--text:#e9e3d8;--dim:#a89f92;--accent:#d9a77c}',
    'body{margin:0;background:var(--bg);color:var(--text);font:16px/1.5 system-ui,sans-serif}',
    'main{max-width:1100px;margin:0 auto;padding:24px 16px}',
    'h1{color:var(--accent);margin:0 0 4px}h2{color:var(--accent);margin:48px 0 4px}',
    'nav a{color:var(--text);margin-right:16px}.who{margin:0 0 4px}.data,.note{color:var(--dim);margin:0 0 16px}',
    'figure{margin:0;background:var(--panel);border-radius:8px;padding:8px}img{width:100%;height:auto;display:block;border-radius:6px}',
    '.gif{margin-bottom:16px}.stills{display:grid;grid-template-columns:repeat(auto-fill,minmax(320px,1fr));gap:16px}',
    'figcaption{color:var(--text);font-size:14px;padding:8px 4px 2px}',
    'table{border-collapse:collapse;margin:0 0 16px;font-size:14px}th,td{text-align:left;padding:4px 12px 4px 0;border-bottom:1px solid var(--panel)}th{color:var(--dim);font-weight:normal}',
    '</style></head><body><main>',
    '<h1>primerkit, as a person uses it</h1>',
    `<p class="note">A storyboard for persona tests: each journey is the session walked key by key, every screen drawn from the session itself. Drawn ${html(at)} by <code>npm run storyboard</code>. Private: kept out of a release.</p>`,
    `<nav>${drawn.map((d) => `<a href="#${d.journey.id}">${html(d.journey.title)}</a>`).join('')}${speeds.length ? '<a href="#speed">Speed</a>' : ''}<a href="#not-here">Not here yet</a></nav>`,
    ...drawn.flatMap(section),
    ...speed,
    '<section id="not-here"><h2>Not here yet</h2>',
    ...missing.map((m) => `<p><b>${html(m.title)}.</b> ${html(m.why)}</p>`),
    '</section>',
    '</main></body></html>',
    '',
  ].join('\n');
}

export const MISSING = [
  { title: 'Connecting PreReason, live', why: "The real step shows a one-time approval link of the person's own and waits for them to sign in. The first five minutes show the demo's connect step in its place, with the same screen and the tile." },
  { title: 'Inside an AI app', why: 'primerkit inside Claude Code (its MCP door) has to be a real screen recording of a Claude Code session, with vhs or asciinema, not frames drawn from primerkit\'s own session.' },
  { title: 'Order intents on paper', why: "An order intent from a routine's label, its 17 pre-trade checks, the yes typed at a terminal, the fill and the standing exit need the person's own Alpaca paper keys, typed at a terminal, which a drawing made by code never holds." },
];

// The home a live journey starts from: the first run done, the local model chosen or none.
function liveHome(journey: Journey, root: string, env: Record<string, string | undefined>): string {
  // A later start opens the home an earlier journey left, with its journal and its digest.
  if (journey.homeFrom) return join(root, journey.homeFrom);
  const home = join(root, journey.id);
  mkdirSync(home, { recursive: true });
  const config: Config = { disclaimer_accepted_at: new Date().toISOString(), first_run_done_at: new Date().toISOString(), ...(journey.home === 'model' ? { model: { kind: 'ollama', name: LOCAL_MODEL } } : {}) };
  writeConfig(home, config);
  if (journey.routine) makeRoutine(home, env);
  return home;
}

// The rule builder's routine: the example rules, a size and a fee of the person's, and a
// backtest over the last four weeks on the local model, run as primerkit backtest runs it.
function makeRoutine(home: string, env: Record<string, string | undefined>): void {
  const { dir } = newRoutine(home, 'example');
  writeFileSync(join(dir, 'rules.md'), EXAMPLE_RULES);
  writeFileSync(join(dir, 'routine.yaml'), ['rules: rules.md', 'every: week', 'data:', '  briefings: [macro.snapshot]', '  price_days: 30', 'labels:', '  watch: { hold: true }', '  enter: { target: 0.5 }', '  exit: { target: 0 }', 'fees:', '  per_trade: 0.001', `model: { kind: ollama, name: ${LOCAL_MODEL} }`, ''].join('\n'));
  const day = (ago: number) => new Date(Date.now() - ago * 86_400_000).toISOString().slice(0, 10);
  const r = spawnSync(process.execPath, [join(ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs'), join(ROOT, 'packages', 'cli', 'src', 'main.ts'), 'backtest', 'example', '--from', day(29), '--to', day(1), '--plain'], { env: { ...env, PRIMERKIT_HOME: home }, encoding: 'utf8', timeout: 900_000 });
  console.log(`backtest for the rule builder: exit ${r.status}${r.status ? `: ${(r.stderr || r.stdout).trim().split('\n').slice(-3).join(' / ')}` : ''}`);
}

async function drawJourney(journey: Journey, deps: SessionDeps): Promise<{ drawn: Drawn; svgs: string[]; speed: Speed }> {
  const started = performance.now();
  const { shots, drawMs, answers } = await walkJourney(deps, journey.steps);
  const walked = (performance.now() - started) / 1000;
  const pictureMs: number[] = [];
  const dir = join(OUT, journey.id);
  mkdirSync(dir, { recursive: true });
  for (const f of readdirSync(dir)) rmSync(join(dir, f));
  const stills: Drawn['stills'] = [];
  const svgs: string[] = [];
  const frames: Parameters<typeof gifOf>[0] = [];
  const stilled = new Set<number>();
  for (const shot of shots) {
    const step = journey.steps[shot.step]!;
    const t0 = performance.now();
    const svg = screenSvg(shot.lines, COLUMNS, ROWS, step.caption ?? step.title, true);
    pictureMs.push(performance.now() - t0);
    svgs.push(svg);
    // A still is the step's first screen; the frames after it are for the GIF alone.
    if (step.caption && !stilled.has(shot.step)) {
      stilled.add(shot.step);
      const file = `${String(stills.length + 1).padStart(2, '0')}-${slug(step.title)}.svg`;
      writeFileSync(join(dir, file), svg);
      stills.push({ file: `${journey.id}/${file}`, caption: step.caption });
    }
    if (shot.hold) {
      const t1 = performance.now();
      frames.push({ ...(await rasterise(svg)), delay: shot.hold });
      pictureMs[pictureMs.length - 1]! += performance.now() - t1;
    }
  }
  const gif = frames.length > 1 ? `${journey.id}.gif` : null;
  if (gif) writeFileSync(join(OUT, gif), gifOf(frames));
  console.log(`${journey.title}: ${stills.length} stills, ${frames.length} frames`);
  const speed: Speed = { journey: journey.id, seconds: Math.round(walked * 10) / 10, screens: shots.length, drawMs: spread(drawMs), pictureMs: spread(pictureMs), answers };
  return { drawn: { journey, stills, gif }, svgs, speed };
}

// The speed of every journey, as a section of the page and the README: how long a screen took
// to draw from the session's state, how long its picture took, and each answer's time and size.
export function speedLines(speeds: Speed[]): string[] {
  const ms = (s: Speed['drawMs']) => `${s.p50} / ${s.p95} / ${s.max}`;
  return [
    '| journey | walked | screens | draw a screen, ms (median / 95th / most) | its picture, ms (median / 95th / most) |',
    '|---|---|---|---|---|',
    ...speeds.map((s) => `| ${s.journey} | ${s.seconds} s | ${s.screens} | ${ms(s.drawMs)} | ${ms(s.pictureMs)} |`),
    '',
    ...(speeds.some((s) => s.answers.length)
      ? ['| journey | question | read | answered in | tokens read | checks |', '|---|---|---|---|---|---|', ...speeds.flatMap((s) => s.answers.map((a) => `| ${s.journey} | ${a.question.replace(/\|/g, '\\|')} | ${a.read.join(', ')} | ${a.seconds.toFixed(1)} s | ${a.tokens.toLocaleString('en-US')} | ${a.checks} |`)), '']
      : []),
  ];
}

async function main(): Promise<void> {
  const env = { ...process.env };
  if (!env.PREREASON_API_KEY) throw new Error('the live journeys read PreReason with the key in PREREASON_API_KEY, and none is set');
  delete env.ANTHROPIC_API_KEY; // no hosted model is asked: the live journeys run on the local model
  const root = mkdtempSync(join(tmpdir(), 'pk-storyboard-'));
  mkdirSync(OUT, { recursive: true });
  const drawn: Drawn[] = [];
  const svgs: string[] = [];
  const speeds: Speed[] = [];
  try {
    for (const [i, journey] of JOURNEYS.entries()) {
      if (journey.data === 'live' && i > 1) await new Promise((done) => setTimeout(done, PACE_MS));
      const deps: SessionDeps =
        journey.home === 'demo'
          ? { ...demoDeps({ version: 'storyboard' }), checkMachine: async () => GALLERY_MACHINE }
          : realDeps({ version: 'storyboard', env: { ...env, PRIMERKIT_HOME: liveHome(journey, root, env) } });
      const out = await drawJourney(journey, deps);
      drawn.push(out.drawn);
      svgs.push(...out.svgs);
      speeds.push(out.speed);
    }
    refuseKeys(svgs, [env.PREREASON_API_KEY]);
    const at = new Date().toISOString().slice(0, 16).replace('T', ' ') + ' UTC';
    writeFileSync(join(OUT, 'speed.json'), JSON.stringify({ at, node: process.version, platform: process.platform, model: LOCAL_MODEL, speeds }, null, 1));
    writeFileSync(join(OUT, 'index.html'), storyboardHtml(drawn, MISSING, at, speeds));
    writeFileSync(
      join(OUT, 'README.md'),
      [
        '# The storyboard',
        '',
        `primerkit as a person uses it, journey by journey. Drawn ${at} by \`npm run storyboard\`; open \`index.html\` in a browser for the page with every line.`,
        '',
        ...drawn.flatMap((d) => [`## ${d.journey.title}`, '', d.journey.who, '', ...(d.gif ? [`![${d.journey.title}](${d.gif})`, ''] : []), ...d.stills.flatMap((s, i) => [`${i + 1}. ${s.caption}`, '', `![${s.caption}](${s.file})`, ''])]),
        '## Speed',
        '',
        `Measured as it was drawn, on ${process.platform} with Node ${process.version} and ${LOCAL_MODEL} in Ollama: a screen drawn from the session's state, its picture, and each answer as the session timed it. Also in \`speed.json\`.`,
        '',
        ...speedLines(speeds),
        '## Not here yet',
        '',
        ...MISSING.flatMap((m) => [`- **${m.title}.** ${m.why}`]),
        '',
      ].join('\n'),
    );
    console.log(`The storyboard is in ${OUT}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// Run as a script (npm run storyboard), not when a test imports what it draws with.
if (/storyboard\.ts$/.test(process.argv[1] ?? '')) await main();
