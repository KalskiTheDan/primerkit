import { IDS_SHOWN } from '@primerkit/connector-prereason';
import { BACKGROUND_LABEL, NEWS_BLOCK, bestLine, checksText, hhmm, longDay, withRefs, type BenchResult } from '@primerkit/core';
import { PROVIDERS, fitnessLines, keyNameFor, providerById, type FitnessResult, type LocalModel, type MachineCheck } from '@primerkit/models';
import {
  SPINNER,
  SPINNER_PLAIN,
  TAGLINE,
  askLine,
  bar,
  block,
  clip,
  inputLine,
  lastColumns,
  lockup,
  lockupWidth,
  maker,
  pkMark,
  pad,
  prLine,
  prMarkLead,
  prTile,
  markSize,
  rail,
  RAIL_STEPS,
  statusStrip,
  textWidth,
  titleBar,
  widthOf,
  wrap,
  duo,
  type Line,
  type Maker,
  type Segment,
} from '@primerkit/ui';
import type { Board } from './boards';
import { COMPARE_FOOTER, COMPARE_HEADINGS, COMPARE_TITLE, briefingSpent, compareCost, figuresLine, hostsOf, webSpent, webStatus, type CompareResult } from './compare';
import type { DigestLine, DigestView } from './digest';
import { DEMO_SAMPLE } from './engine';
import { POSITIONS_FOOT, positionsLines } from './positions';
import { BOARD_ROOM, besideTitle, fitLines, reflow, wrapIn, wrapWords } from './fit';
import { DISCLAIMER_POINTS, FIRST_QUESTIONS } from './first-run';
import { NO_ADVICE, ONBOARDING } from './onboarding';
import { FUNCTIONS, type Menu } from './menu';
import { emptyLines, newsCredit, noneLine, recordShown, sideLines, type NewsRead } from './news';
import { RESEARCH_CLOSING, SIGNATURE_HINT, endWords } from './research';
import { rulesFileLine, shortTime } from './routine';
import { GRID, WIDE_COLUMNS, type CheckLine, type Entry, type ModelChoice, type Opening, type State } from './state';

// Every screen of the session, drawn from the state in the window's size (state.size:
// every row the window has, down to 48 by 16). Text written for the grid is kept as
// written where it fits and wrapped where the window is narrower, and each screen has an
// ASCII version.

// A screen of text keeps to the grid's 76 columns, where lines read best; a board or
// chart takes the window's whole width, so it is drawn as if the screen were that wide.
// Every screen sits in a panel: its first row the title bar, which names the function and
// its subject and, on the right, the date and source of what it shows, and its last row the
// status strip, which keeps the model, PreReason, the data's day, the tokens read and today's
// runs in view. The screen between them is drawn a row shorter for the strip.
export function screen(state: State, ascii: boolean): Line[] {
  const t = maker(ascii);
  const width = state.step.name === 'board' ? state.size.columns : state.size.width;
  const sized = { ...state, size: { ...state.size, width, height: state.size.height - 1 } };
  const lines = draw(sized, t, ascii).map((line, i) => clip(line, i ? width : band(state)));
  return [...lines, statusStrip(t, statusParts(state), band(state))];
}

// The panel's band, its title bar and status strip, runs across the whole window where the
// window is wide, and across the screen's own width where it is not.
const band = (state: State): number => (state.size.columns >= WIDE_COLUMNS ? state.size.columns : state.size.width);

// The rows a step has inside the panel: the window's, less the status strip.
export function panelState(state: State): State {
  return { ...state, size: { ...state.size, height: state.size.height - 1 } };
}

// The width a screen is drawn in, and the room inside a block after " │ ".
const W = (state: State): number => state.size.width;
const inside = (state: State): number => state.size.width - 4;

// A screen filled to the window's height, with blank lines at `at`. One taller than the
// window gives up its blank lines first, from the bottom up; one taller still keeps its
// first lines and its last three, the prompt and its keys, and leaves out the lines
// between that do not fit.
function fill(state: State, lines: Line[], at?: number): Line[] {
  const h = state.size.height;
  if (lines.length <= h) return pad(lines, at, h);
  const out = lines.slice();
  for (let i = out.length - 1; i >= 0 && out.length > h; i--) if (!out[i]?.length) out.splice(i, 1);
  if (out.length <= h) return out;
  return [...out.slice(0, h - 3), ...out.slice(-3)];
}

// The first of a screen's layouts, the fullest first, that fits the window's height, and
// the last where none does. A layout is drawn only when the ones before it did not fit.
function fitting(state: State, ...layouts: Array<() => Line[]>): Line[] {
  let lines: Line[] = [];
  for (const layout of layouts) {
    lines = layout();
    if (lines.length <= state.size.height) return lines;
  }
  return lines;
}

// A title and what it shows on one line, or the title on a line of its own and the rest
// wrapped under it where the two do not fit one.
function titled(state: State, t: Maker, title: string, subtitle: string): Line[] {
  const one: Line = [t('accentBold', ` ${title}`), t('muted', `  ${subtitle}`)];
  if (widthOf(one) <= W(state)) return [one];
  // What of the subtitle fits beside the title stays there, and the rest goes under it.
  const { beside, under } = besideTitle(title, subtitle, W(state));
  return [[t('accentBold', ` ${title}`), ...(beside ? [t('muted', `  ${beside}`)] : [])], ...under.flatMap((u) => wrapWords(u, W(state) - 1)).map((l): Line => [t('muted', ` ${l}`)])];
}

function draw(state: State, t: Maker, plain: boolean): Line[] {
  switch (state.step.name) {
    case 'welcome':
      return welcome(state, t, plain);
    case 'model':
      return modelStep(state, t, plain);
    case 'model-none':
      return modelNone(state, t, plain);
    case 'model-list':
      return modelList(state, t, plain);
    case 'model-custom':
      return modelCustom(state, t, plain);
    case 'fitness':
      return fitness(state, t, plain);
    case 'connect':
      return connect(state, t, plain);
    case 'first-question':
      return firstQuestion(state, t, plain);
    case 'digest':
      return digestStep(state, t, plain);
    case 'journal':
      return journal(state, t);
    case 'board':
      return boardScreen(state, t, plain);
    case 'install':
      return installScreen(state, t, plain);
    case 'compare':
      return compareScreen(state, t);
    case 'home':
      return home(state, t, plain);
  }
}

// The first row of a first run screen: the title bar, naming the step and, in the demo,
// what the demo is.
function banner(state: State, t: Maker): Line {
  return top(state, t);
}

// The title bar of the step on screen.
function top(state: State, t: Maker): Line {
  const { code, subject, right } = titleOf(state);
  return titleBar(t, code, subject, right, band(state));
}

// What a title bar names: the function's code, its subject, and the date and source of what
// the screen shows, or in the demo the day its briefings were saved.
export function titleOf(state: State): { code: string; subject: string; right: string } {
  const step = state.step;
  const day = dataDay(state);
  const right = state.demo ? `demo · saved ${state.demo.date}` : day ? `${day} · PreReason` : '';
  const setup = (i: number) => ({ code: 'SETUP', subject: `${RAIL_STEPS[i] ?? ''} · step ${i + 1} of ${RAIL_STEPS.length}`, right });
  switch (step.name) {
    case 'welcome':
      return { code: 'PRIMERKIT', subject: 'before you start', right: state.demo ? 'demo · nothing is sent or kept' : '' };
    case 'model':
    case 'model-none':
    case 'model-list':
    case 'model-custom':
    case 'fitness':
    case 'install':
      if (state.firstRun) return setup(0);
      if (step.name === 'fitness') return { code: 'CHECK', subject: step.label, right };
      if (step.name === 'install') return { code: 'INSTALL', subject: step.app, right };
      return { code: 'MODEL', subject: 'switch the model', right };
    case 'connect':
      return state.firstRun ? setup(1) : { code: 'CONNECT', subject: 'PreReason', right };
    case 'first-question':
      return setup(2);
    case 'digest':
      return state.firstRun ? setup(3) : { code: 'SCHEDULE', subject: 'the morning digest', right };
    case 'journal':
      return { code: 'JOURNAL', subject: step.open?.title ?? 'every run on this machine', right: '' };
    case 'board':
      return { code: step.request.kind === 'brief' ? (step.request.heat ? 'HEATMAP' : 'BRIEF') : 'CHART', subject: step.view ? step.view.unicode.title : step.status, right };
    case 'compare':
      return { code: 'COMPARE', subject: step.question, right };
    case 'home': {
      const last = [...state.feed].reverse().find((e) => e.kind !== 'running') ?? state.feed.at(-1);
      if (!last) return { code: 'PRIMERKIT', subject: 'launchpad', right };
      return { code: ENTRY_CODES[last.kind] ?? 'ASK', subject: last.question, right };
    }
  }
}

// The code each kind of answer in the feed is titled with.
const ENTRY_CODES: Partial<Record<Entry['kind'], string>> = {
  running: 'ASK',
  answer: 'ASK',
  failed: 'ASK',
  note: 'NOTE',
  'no-records': 'NEWS',
  catalog: 'CATALOG',
  digest: 'DIGEST',
  check: 'CHECK',
  bench: 'BENCH',
  connections: 'CONNECT',
  routine: 'ROUTINE',
  rules: 'RULES',
  'routine-test': 'TESTS',
  hypothesis: 'RESEARCH',
  research: 'RESEARCH',
  registry: 'REGISTRY',
  compare: 'COMPARE',
};

// The day the data on screen stood: the demo's saved day, a board's, or the newest answer's.
export function dataDay(state: State): string | null {
  if (state.demo) return state.demo.date;
  const step = state.step;
  const iso = (stamp: string | null | undefined): string | null => (stamp && /^\d{4}-\d{2}-\d{2}/.test(stamp) ? longDay(stamp.slice(0, 10)) : null);
  if (step.name === 'board') return iso(step.view?.unicode.generated ?? step.view?.unicode.readAt ?? null);
  for (const e of [...state.feed].reverse()) {
    if (e.kind === 'answer') return iso(e.view.asOf ?? e.view.generated);
    if (e.kind === 'digest') return iso(e.view.generated);
  }
  return null;
}

// The status strip's parts, the most needed first: the model, PreReason's tier and calls,
// the data's day, the tokens read on screen and today's runs.
export function statusParts(state: State): Array<[string, string]> {
  const model = state.model ? (state.model.label.split(',')[0] ?? state.model.label) : 'none yet';
  // The demo holds no key: PreReason's part names its saved briefings, not a tier.
  const prereason = state.demo ? 'saved briefings' : !state.connected ? 'not connected' : (state.tier ?? 'connected');
  const parts: Array<[string, string]> = [['model', model], ['PreReason', prereason]];
  if (state.callsLeft != null && !state.demo) parts.push(['calls left', state.callsLeft.toLocaleString('en-US')]);
  const day = dataDay(state);
  if (day) parts.push(['data', day]);
  const tokens = tokensRead(state);
  if (tokens) parts.push(['tokens', tokens.toLocaleString('en-US')]);
  // The cost, when every answer on screen recorded one: never a guess.
  const cost = costOf(state);
  if (cost !== null) parts.push(['cost', cost < 0.01 && cost > 0 ? `$${cost.toFixed(4)}` : `$${cost.toFixed(2)}`]);
  // The demo keeps no journal, so it counts no runs.
  if (!state.firstRun && !state.demo) parts.push(['runs today', String(state.runs)]);
  return parts;
}

// What the answers on screen cost, summed, where each recorded its cost; null where any did not.
function costOf(state: State): number | null {
  const answers = (state.step.name === 'first-question' && state.step.entry ? [state.step.entry] : state.feed).filter((e) => e.kind === 'answer');
  if (!answers.length || answers.some((e) => e.kind !== 'answer' || typeof e.cost !== 'number')) return null;
  return answers.reduce((n, e) => n + (e.kind === 'answer' ? (e.cost ?? 0) : 0), 0);
}

// The tokens the answers on screen read.
function tokensRead(state: State): number {
  const entries = state.step.name === 'first-question' && state.step.entry ? [state.step.entry] : state.feed;
  return entries.reduce((n, e) => n + (e.kind === 'answer' ? e.view.tokens : 0), 0);
}

// The head of a step: the title bar, and during the first run the rail and the step's two
// strips, what you do and what the agent does, where the window has the rows for them.
function head(state: State, t: Maker, plain: boolean, step: number): Line[] {
  return state.firstRun ? [banner(state, t), rail(t, plain, step, W(state)), [], ...strips(state, t, step)] : [top(state, t), []];
}

// A setup step's two strips and a blank under them, or nothing where the window is short.
function strips(state: State, t: Maker, step: number): Line[] {
  const words = ONBOARDING[step];
  if (!words || state.size.height < 20) return [];
  return [...duo(t, words.you, words.agent, W(state)), []];
}

const help = (t: Maker, text: string, plainText?: string): Line => [t('dim', ` ${text}`, plainText === undefined ? undefined : ` ${plainText}`)];
const headline = (t: Maker, text: string): Line => [t('accentBold', ` ${text}`)];
const lead = (t: Maker, text: string): Line => [t('muted', ` ${text}`)];
const option = (t: Maker, text: string, chosen: boolean): Line => (chosen ? askLine(t, text) : [t('fg', `   ${text}`)]);
const spin = (t: Maker, frame: number): Segment => t('accent', SPINNER[frame % SPINNER.length] ?? '', SPINNER_PLAIN[frame % SPINNER_PLAIN.length]);

// A headline or a lead, on as many lines as the width needs.
const headlines = (state: State, t: Maker, text: string): Line[] => wrapWords(text, W(state) - 1).map((l) => headline(t, l));
const leads = (state: State, t: Maker, text: string): Line[] => wrapWords(text, W(state) - 1).map((l) => lead(t, l));

// A choice on as many lines as the width needs, its later lines under its first word.
const options = (state: State, t: Maker, text: string, chosen: boolean): Line[] =>
  wrapWords(text, W(state) - 3).map((l, i): Line => (i === 0 ? option(t, l, chosen) : [t(chosen ? 'bright' : 'fg', `   ${l}`)]));

// A spinner and what it is doing, the words wrapped under themselves.
const spinning = (state: State, t: Maker, text: string): Line[] =>
  wrapWords(text, W(state) - 3).map((l, i): Line => (i === 0 ? [t('fg', ' '), spin(t, state.frame), t('muted', ` ${l}`)] : [t('muted', `   ${l}`)]));

// The keys a screen takes, on as many lines as the width needs, broken between keys and
// never inside one; the plain version, which spells arrows out, decides where.
function keys(state: State, t: Maker, text: string, plainText?: string): Line[] {
  const parts = text.split(' · ');
  const plainParts = plainText?.split(' | ') ?? parts;
  const out: Line[] = [];
  let a: string[] = [];
  let b: string[] = [];
  const width = (xs: string[], sep: string) => Array.from(xs.join(sep)).length + 1;
  const flush = () => out.push(help(t, a.join(' · '), plainText === undefined ? undefined : b.join(' | ')));
  parts.forEach((p, i) => {
    const q = plainParts[i] ?? p;
    if (a.length && Math.max(width([...a, p], ' · '), width([...b, q], ' | ')) > W(state)) {
      flush();
      a = [];
      b = [];
    }
    a.push(p);
    b.push(q);
  });
  if (a.length) flush();
  return out;
}

// Typing: the text, or the placeholder, and the cursor. Text longer than the line shows
// its end, where the cursor is.
function typing(state: State, t: Maker, text: string, placeholder: string): Line {
  const room = W(state) - 4;
  // The end of what is typed that fits, by the columns its characters take.
  const over = textWidth(text) > room;
  const tail = lastColumns(text, room - 1);
  const shown = over ? `…${tail}` : text;
  return [t('accentBold', ' › '), ...(text ? [t('bright', shown, over ? `~${Array.from(tail).slice(-(room - 1)).join('')}` : undefined)] : [t('ph', placeholder)]), t('cursor', '█', '_')];
}

// A block whose closing words wrap too: all but their last line hang inside the block.
function closed(state: State, t: Maker, body: Line[], closing: string, role = 'muted'): Line[] {
  const words = wrapWords(closing, inside(state));
  return block(t, [...body, ...words.slice(0, -1).map((l): Line => [t(role, l)])], [t(role, words.at(-1) ?? '')]);
}

// Text after a glyph, such as ✓ or ✗, wrapped with its later lines under its first word.
function marked(state: State, t: Maker, glyph: Segment, role: string, text: string): Line[] {
  const indent = ' '.repeat(Array.from(glyph[1]).length);
  return wrapWords(text, W(state) - indent.length).map((l, i): Line => (i === 0 ? [glyph, t(role, l)] : [t(role, `${indent}${l}`)]));
}

function joinAnd(parts: string[]): string {
  if (parts.length <= 1) return parts.join('');
  return `${parts.slice(0, -1).join(', ')}, and ${parts.at(-1)}`;
}

// Shows at most `size` choices, around the one highlighted.
function windowed<T>(items: T[], cursor: number, size: number): { first: number; shown: T[] } {
  const first = Math.max(0, Math.min(cursor - Math.floor(size / 2), items.length - size));
  return { first, shown: items.slice(first, first + size) };
}

// ------------------------------------------------------------------ first run

// The points agreed to are never left out: in a smaller window the logo draws smaller, then
// gives way to the name, then the tagline goes, then the name. Plain text has no mark, so it
// starts with the name.
function welcome(state: State, t: Maker, plain: boolean): Line[] {
  const points = DISCLAIMER_POINTS.flatMap((point) => reflow(point, W(state) - 3).map((line, i): Line => (i === 0 ? [t('dim', ' · ', ' * '), t('fg', line)] : [t('fg', `   ${line}`)])));
  const tagline = wrapWords(TAGLINE, W(state) - 1).map((l): Line => [t('tag', ` ${l}`)]);
  const agree: Line[] = [headline(t, 'Before you start'), [], ...points, [], askLine(t, 'Enter to agree and start'), help(t, 'Esc to leave')];
  const name: Line = [t('accentBold', ' primerkit')];
  return fill(
    state,
    fitting(
      state,
      // Each mark with the headline, then without it: the title bar already says "before you start".
      ...(plain ? [] : (['large', 'small'] as const).filter((size) => W(state) > lockupWidth(size)).flatMap((size) => [() => [banner(state, t), ...lockup(t, plain, size), [], ...agree], () => [banner(state, t), ...lockup(t, plain, size), [], ...agree.slice(2)]])),
      () => [banner(state, t), name, ...tagline, [], ...agree],
      () => [banner(state, t), name, [], ...agree],
      () => [banner(state, t), ...agree],
      // The title bar already says "before you start": the smallest window keeps every point.
      () => [banner(state, t), ...agree.slice(2)],
    ),
  );
}

export function runtimeName(m: { runtime?: string; kind?: string; baseUrl?: string }): string {
  if (m.runtime === 'ollama' || m.kind === 'ollama') return 'Ollama';
  return /:1234(\/|$)/.test(m.baseUrl ?? '') ? 'LM Studio' : 'a local server';
}

export function choiceLabel(choice: ModelChoice, env: Record<string, string | undefined> = {}): string {
  if (choice.kind === 'app') return `Inside ${choice.app}, on your subscription`;
  if (choice.kind === 'kept') return `Continue with ${choice.spec.name}, checked ${longDay(choice.checkedAt.slice(0, 10))}: ${choice.verdict}`;
  if (choice.kind === 'demo') return 'The demo stand in: no model, saved briefings';
  if (choice.kind === 'custom') return 'Another model: type its name';
  if (choice.kind === 'provider') {
    const p = providerById(choice.provider);
    return p ? `${p.models}, through your ${keyNameFor(p, env) ?? p.keyEnv[0]}` : choice.provider;
  }
  const spec = choice.spec;
  if (spec.kind === 'hosted') return `${spec.name} on ${providerById(spec.provider)?.name ?? spec.provider}`;
  return `Here, with ${spec.name} on ${runtimeName(spec)}`;
}

export function foundLine(check: MachineCheck): string {
  const parts = [...check.apps, ...check.keys];
  const counts = new Map<string, number>();
  for (const m of check.local) counts.set(runtimeName(m as LocalModel), (counts.get(runtimeName(m as LocalModel)) ?? 0) + 1);
  for (const [name, n] of counts) parts.push(`${name} with ${n} ${n === 1 ? 'model' : 'models'}`);
  return parts.length ? `Found on this machine: ${joinAnd(parts)}.` : 'Nothing that runs a model was found on this machine.';
}


function choiceDetail(state: State, t: Maker, choice: ModelChoice | undefined): Line[] {
  if (!choice) return [];
  const detail = (lines: string[], closing: string): Line[] => closed(state, t, reflow(lines, inside(state)).map((l): Line => [t('fg', l)]), closing);
  if (choice.kind === 'app') {
    return detail([`primerkit puts its skills and its local server into ${choice.app}. The model`, `there answers on your subscription, and primerkit checks each answer`, 'on this machine.'], 'The next screen shows every change before any is made.');
  }
  if (choice.kind === 'kept') {
    return detail([`The model checked here last time, on ${longDay(choice.checkedAt.slice(0, 10))}, and kept in config.yaml.`], 'Choosing it goes on without checking it again.');
  }
  if (choice.kind === 'demo') {
    return detail(['No model runs. Each answer lifts sentences from briefings saved on', `${state.demo?.date ?? "the demo's day"}, to show the flow. It does not read your question.`], 'Nothing is sent anywhere in the demo.');
  }
  if (choice.kind === 'custom') {
    return detail(['Any model by its name: one Ollama has or can pull, such as qwen3:8b', 'or deepseek-r1:14b, one on a server that speaks the OpenAI API, or a', "hosted model's id."], 'A short check runs first, to see that it answers and cites correctly.');
  }
  if (choice.kind === 'provider') {
    const p = providerById(choice.provider);
    const name = p?.name ?? choice.provider;
    return detail([`Runs at ${name} on your key. Each question sends its packet (the primer,`, `your question and the briefing lines) to ${name}, which charges for it.`], 'Next, pick one of its models. A short check runs first.');
  }
  if (choice.spec.kind === 'hosted') return detail([`Runs at ${providerById(choice.spec.provider)?.name ?? choice.spec.provider} on your key.`], 'A short check runs first.');
  return detail(['Runs on this machine, at no cost. Your questions stay here; only the', 'requests for briefings go to PreReason.'], 'A short check runs first, to see that it answers and cites correctly.');
}

function modelStep(state: State, t: Maker, plain: boolean): Line[] {
  const step = state.step;
  if (step.name !== 'model') return [];
  const lines = [...head(state, t, plain, 0), ...headlines(state, t, 'Where should your model run?')];
  if (!step.check) {
    return fill(state, [...lines, ...spinning(state, t, 'Checking this machine for AI apps, API keys and local models.'), [], help(t, 'Esc to leave')]);
  }
  // Why the model is being chosen again, where it is (the kept model cannot be used).
  const found = [...(state.notice ? leads(state, t, state.notice) : []), ...leads(state, t, foundLine(step.check))];
  const detail = choiceDetail(state, t, step.choices[step.cursor]);
  const esc = state.firstRun ? 'Esc to leave' : 'Esc goes back';
  const keyLines = keys(state, t, `Enter to choose · ↑ ↓ to move · ${esc}`, `Enter to choose | up and down to move | ${esc}`);
  const bare = state.firstRun ? [banner(state, t), rail(t, plain, 0, W(state)), [], ...headlines(state, t, 'Where should your model run?')] : lines;
  const layout = (size: number, withDetail: boolean, top = lines) => (): Line[] => {
    const { first, shown } = windowed(step.choices, step.cursor, size);
    const list = shown.flatMap((c, i) => options(state, t, choiceLabel(c, envOf(state)), first + i === step.cursor));
    return [...top, ...found, [], ...list, [], ...(withDetail ? [...detail, []] : []), ...keyLines];
  };
  // Seven choices at a time where the window has the rows, fewer where it does not; the
  // detail of the one highlighted goes before fewer than three would show, and the setup's
  // strips go before the detail does.
  const sizes = [7, 6, 5, 4, 3];
  return fill(state, fitting(state, ...sizes.flatMap((n) => [layout(n, true), layout(n, true, bare)]), ...sizes.map((n) => layout(n, false, bare))));
}

// The environment variable names the machine check found, for the choice labels.
function envOf(state: State): Record<string, string | undefined> {
  return Object.fromEntries((state.machine?.keys ?? []).map((k) => [k, 'set']));
}

function modelNone(state: State, t: Maker, plain: boolean): Line[] {
  const step = state.step;
  if (step.name !== 'model-none') return [];
  const example = PROVIDERS.slice(0, 2).map((p) => p.keyEnv[0]).join(' or ');
  const item = (text: string): Line[] => wrapWords(text, W(state) - 3).map((l): Line => [t('fg', `   ${l}`)]);
  return fill(state, [
    ...head(state, t, plain, 0),
    ...headlines(state, t, 'No model found on this machine'),
    ...leads(state, t, step.check.apps.length ? foundLine(step.check) : 'primerkit checked for AI apps, API keys and local models.'),
    [],
    ...item(step.check.ollama === 'installed' ? 'Start Ollama, which is installed but not running' : 'Install Ollama for a free local model: ollama.com'),
    ...item(`Set an API key, for example ${example}`),
    ...item('Or start a local server that speaks the OpenAI API, such as LM Studio'),
    [],
    askLine(t, 'Enter to check again'),
    ...keys(state, t, `t types a model name · ${state.firstRun ? 'Esc to leave' : 'Esc goes back'}`, `t types a model name | ${state.firstRun ? 'Esc to leave' : 'Esc goes back'}`),
  ]);
}

function modelList(state: State, t: Maker, plain: boolean): Line[] {
  const step = state.step;
  if (step.name !== 'model-list') return [];
  const p = providerById(step.provider);
  const name = p?.name ?? step.provider;
  const lines = [...head(state, t, plain, 0), ...headlines(state, t, `Which ${p?.models ?? 'model'}?`)];
  if (step.typed !== null) {
    const why = step.error ? [...wrapIn(t, 'muted', `${name} did not list its models: ${step.error}`, W(state) - 2).map((l): Line => [t('fg', ' '), ...l]), []] : [];
    return fill(state, [...lines, ...leads(state, t, `Type the model's id, as ${name} names it.`), [], ...why, typing(state, t, step.typed, 'model id'), [], ...keys(state, t, 'Enter to choose · Esc goes back', 'Enter to choose | Esc goes back')]);
  }
  if (!step.models) return fill(state, [...lines, ...spinning(state, t, `Asking ${name} for its models, with your key.`), [], help(t, 'Esc goes back')]);
  const all = [...step.models, 'Type a model name'];
  const count = leads(state, t, `${name} lists ${step.models.length} ${step.models.length === 1 ? 'model' : 'models'} for your key.`);
  const keyLines = keys(state, t, 'Enter to choose · ↑ ↓ to move · Esc goes back', 'Enter to choose | up and down to move | Esc goes back');
  const layout = (size: number) => (): Line[] => {
    const { first, shown } = windowed(all, step.cursor, size);
    const list = shown.flatMap((m, i): Line[] => {
      const chosen = first + i === step.cursor;
      if (first + i < all.length - 1) return options(state, t, m, chosen);
      return [chosen ? [t('accentBold', ' › '), t('ph', m)] : [t('fg', '   '), t('ph', m)]];
    });
    return [...lines, ...count, [], ...list, [], ...keyLines];
  };
  // Ten at a time where the window has the rows, and fewer, down to three, where it does not.
  return fill(state, fitting(state, ...[10, 9, 8, 7, 6, 5, 4, 3].map(layout)));
}

function modelCustom(state: State, t: Maker, plain: boolean): Line[] {
  const step = state.step;
  if (step.name !== 'model-custom') return [];
  const lines = head(state, t, plain, 0);
  const error = step.error ? [[], ...marked(state, t, t('accent', ' ✗ ', ' x '), 'muted', step.error)] : [];
  if (step.stage === 'name') {
    return fill(state, [
      ...lines,
      ...headlines(state, t, 'Another model'),
      ...leads(state, t, 'Type its name as its runtime knows it, such as qwen3:8b or deepseek-r1:14b.'),
      [],
      typing(state, t, step.typed, 'model name'),
      ...error,
      [],
      ...keys(state, t, 'Enter to go on · Esc goes back', 'Enter to go on | Esc goes back'),
    ]);
  }
  if (step.stage === 'url') {
    return fill(state, [
      ...lines,
      ...headlines(state, t, `Where is the server for ${step.typed}?`),
      ...leads(state, t, 'Its base URL, which ends in /v1 for most servers.'),
      [],
      typing(state, t, step.url, 'http://127.0.0.1:1234/v1'),
      ...error,
      [],
      ...keys(state, t, 'Enter to choose · Esc goes back', 'Enter to choose | Esc goes back'),
    ]);
  }
  if (step.stage === 'pull') {
    const p = step.pull;
    const gb = (n?: number) => (n ? (n / 1e9).toFixed(1) : '0');
    const progress = p?.total ? `${p.status}: ${gb(p.completed)} of ${gb(p.total)} GB` : (p?.status ?? 'starting');
    return fill(state, [
      ...lines,
      ...headlines(state, t, `Pulling ${step.typed} with Ollama`),
      ...leads(state, t, "Ollama downloads it from its own library. Large models take a while."),
      [],
      ...(step.error ? [[t('accent', ' ✗ ', ' x '), t('muted', 'The pull stopped.')] as Line] : spinning(state, t, progress)),
      ...error,
      [],
      help(t, step.error ? 'Enter goes back' : 'Esc stops the pull'),
    ]);
  }
  const places = [
    { label: 'On Ollama, here: a pull first if it has not got it' },
    { label: 'On a server at a URL you type' },
    ...PROVIDERS.filter((p) => state.machine?.keys.some((k) => p.keyEnv.includes(k))).map((p) => ({ label: `With ${p.name}, through your ${p.keyEnv.find((k) => state.machine?.keys.includes(k)) ?? p.keyEnv[0]}` })),
  ];
  return fill(state, [
    ...lines,
    ...headlines(state, t, `Where does ${step.typed} run?`),
    [],
    ...places.flatMap((p, i) => options(state, t, p.label, i === step.cursor)),
    ...error,
    [],
    ...keys(state, t, 'Enter to choose · ↑ ↓ to move · Esc goes back', 'Enter to choose | up and down to move | Esc goes back'),
  ]);
}

const LABELS: Record<string, string> = { shape: 'Answer shape', citations: 'Citations', reading: 'Reading', context: 'Context', speed: 'Speed' };

export function checkLine(t: Maker, line: CheckLine): Line {
  const text = line.text.replace(/^(\w+): /, (m, name: string) => (LABELS[name] ? `${LABELS[name]}: ` : m));
  const glyph = line.ok === true ? t('accent', '✓ ', 'ok ') : line.ok === false ? t('accentBold', '✗ ', 'x ') : t('muted', '● ', 'o ');
  return [glyph, t('fg', text)];
}

// A check's line, its words wrapped under themselves where the block is narrower.
function checkLines(state: State, t: Maker, line: CheckLine): Line[] {
  const one = checkLine(t, line);
  if (widthOf(one) <= inside(state)) return [one];
  const [glyph, text] = one;
  const indent = ' '.repeat(Array.from(glyph?.[1] ?? '').length);
  return wrapWords(text?.[1] ?? '', inside(state) - indent.length).map((l, i): Line => (i === 0 ? [glyph!, t('fg', l)] : [t('fg', `${indent}${l}`)]));
}

function verdictLine(r: FitnessResult): string {
  return `${r.verdict.charAt(0).toUpperCase()}${r.verdict.slice(1)}: ${r.reason}.`;
}

function fitness(state: State, t: Maker, plain: boolean): Line[] {
  const step = state.step;
  if (step.name !== 'fitness') return [];
  const title = [...head(state, t, plain, 0), ...headlines(state, t, `Checking ${step.label.split(',')[0]}`)];
  const question = [...leads(state, t, 'Does it answer in the right shape, cite correctly and read the data?'), []];
  // The question the check asks goes where the window is too short for it and the
  // results, and then the results give their lines for the checks' names.
  const page = (rest: Line[], shorter?: () => Line[]): Line[] =>
    fill(state, fitting(state, () => [...title, ...question, ...rest], () => [...title, [], ...rest], ...(shorter ? [() => [...title, [], ...shorter()]] : [])));
  if (step.error) {
    return page([...block(t, wrapIn(t, 'fg', step.error, inside(state)), [t('muted', 'The check could not run.')]), [], askLine(t, 'Enter to choose another model'), help(t, 'Esc goes back')]);
  }
  if (step.phase === 'confirm') {
    if (!step.plan) return page(spinning(state, t, 'Getting ready.'));
    return page([
      ...closed(state, t, wrapIn(t, 'fg', `It sends ${step.plan.calls} packets to the model on your key, about ${step.plan.tokens.toLocaleString('en-US')} tokens.`, inside(state)), 'It reads briefings saved on Sep 25, 2026; nothing goes to PreReason.'),
      [],
      askLine(t, 'Enter to run it'),
      ...keys(state, t, 's skips it · Esc goes back', 's skips it | Esc goes back'),
    ]);
  }
  const body = step.lines.flatMap((l) => checkLines(state, t, l));
  if (step.phase === 'running') {
    const doing: Line = [spin(t, state.frame), t('muted', ` ${step.current ?? 'working'}`)];
    const running = (checks: Line[]) => closed(state, t, [...checks, doing], 'Esc stops it; nothing from a stopped check is kept', 'dim');
    return page(running(body), () => running(checkNames(state, t, step.lines)));
  }
  const r = step.result as FitnessResult;
  const fit = r.verdict !== 'not fit';
  const done = (checks: Line[]): Line[] => [
    ...closed(state, t, [...checks, [], ...wrapIn(t, fit ? 'bright' : 'fg', verdictLine(r), inside(state))], "Kept in the journal with today's date."),
    [],
    askLine(t, fit ? 'Enter to go on' : 'Enter to choose another model'),
    ...(fit ? [] : [help(t, 'u uses it anyway')]),
  ];
  return page(done(body), () => done(checkNames(state, t, step.lines)));
}

// The checks by their names alone, each after its mark, for a window too short for their
// lines; the verdict under them says what failed.
function checkNames(state: State, t: Maker, lines: CheckLine[]): Line[] {
  const out: Line[] = [];
  let line: Line = [];
  for (const l of lines) {
    const [glyph, text] = checkLine(t, l);
    if (!glyph || !text) continue;
    const item: Line = [glyph, t('fg', text[1].split(':')[0] ?? text[1])];
    if (line.length && widthOf(line) + 3 + widthOf(item) > inside(state)) {
      out.push(line);
      line = [];
    }
    line = line.length ? [...line, t('fg', '   '), ...item] : item;
  }
  if (line.length) out.push(line);
  return out;
}

function connect(state: State, t: Maker, plain: boolean): Line[] {
  const step = state.step;
  if (step.name !== 'connect') return [];
  const supplies = 'PreReason supplies the market data your model reads.';
  const coverage = step.coverage ? `Free briefings today: ${step.coverage}.` : null;
  // PreReason's mark as its logo has it, " PR " in amber on a charcoal tile, beside the
  // headline, and the words under the headline in the room the tile leaves. Plain text
  // has no tile: the letters stand in brackets, as wide.
  const besideTile = (): Line[] | null => {
    const indent = 8;
    const room = W(state) - indent;
    if (room < 30) return null;
    return [
      [t('fg', ' '), t('pr/prTile', ' PR ', '[PR]'), t('fg', '   '), t('accentBold', 'Connect PreReason')],
      ...[supplies, ...(coverage ? [coverage] : [])].flatMap((s) => wrapWords(s, room).map((l): Line => [t('fg', ' '.repeat(indent)), t('muted', l)])),
    ];
  };
  // In a smaller window the words go under a headline instead, then the free briefings
  // go, then all but the headline.
  const arts = [
    besideTile(),
    [...headlines(state, t, 'Connect PreReason'), ...leads(state, t, supplies), ...(coverage ? leads(state, t, coverage) : [])],
    [...headlines(state, t, 'Connect PreReason'), ...leads(state, t, supplies)],
    headlines(state, t, 'Connect PreReason'),
  ].filter((a): a is Line[] => a !== null);
  const numbered = (n: string, text: string): Line[] => wrapWords(text, W(state) - 6).map((l, i): Line => (i === 0 ? [t('accent', `   ${n}  `), t('fg', l)] : [t('fg', `      ${l}`)]));
  const steps: Line[] = [
    ...numbered('1', 'Sign in, or create a free account with Google or GitHub. No card.'),
    ...numbered('2', 'Approve primerkit. It collects its key itself; nothing to copy.'),
  ];
  const notice = state.notice ? wrapWords(state.notice, W(state) - 1).map((l): Line => [t('dim', ` ${l}`)]) : [[] as Line];
  let body: Line[];
  let keyLines: Line[];
  if (step.phase === 'tier') {
    body = [[t('fg', ' Connected.')], [], ...spinning(state, t, "Reading the key's tier: one call of today's allowance.")];
    keyLines = [[]];
  } else if (step.phase === 'demo') {
    const said = reflow(['In the demo no account is made and nothing is sent. The real step shows', 'one link here:'], W(state) - 1).map((l): Line => [t('fg', ` ${l}`)]);
    body = [...said, [], ...steps];
    keyLines = keys(state, t, 'Enter continues as if you approved · Esc goes back', 'Enter continues as if you approved | Esc goes back');
  } else if (step.phase === 'failed') {
    body = [[t('fg', ' PreReason did not connect.')], [], ...wrapIn(t, 'muted', step.message ?? 'The approval did not finish.', W(state) - 4).map((l): Line => [t('accent', '   '), ...l])];
    keyLines = keys(state, t, 'Enter to try again · Esc goes back', 'Enter to try again | Esc goes back');
  } else if (!step.link) {
    body = spinning(state, t, 'Asking PreReason for an approval link.');
    keyLines = [help(t, 'Esc goes back')];
  } else {
    body = [
      [t('fg', ' Open this link to approve primerkit:')],
      [t('fg', '   '), t('bright', step.link)],
      [],
      ...steps,
      [],
      ...spinning(state, t, 'Waiting for your approval. The link works for 15 minutes.'),
    ];
    keyLines = keys(state, t, 'Enter opens the link · c copies it · Esc goes back', 'Enter opens the link | c copies it | Esc goes back');
  }
  const lead = [banner(state, t), rail(t, plain, 1, W(state)), []];
  return fill(state, fitting(state, ...arts.map((art) => () => [...lead, ...strips(state, t, 1), ...art, [], ...body, ...notice, ...keyLines]), ...arts.map((art) => () => [...lead, ...art, [], ...body, ...notice, ...keyLines])));
}

function firstQuestion(state: State, t: Maker, plain: boolean): Line[] {
  const step = state.step;
  if (step.name !== 'first-question') return [];
  const lines = [banner(state, t), rail(t, plain, 2, W(state)), []];
  if (step.entry) {
    const next = step.entry.kind === 'running' ? [] : step.entry.kind === 'answer' ? [[], askLine(t, 'Enter for the last step')] : [[], askLine(t, 'Enter to pick another question')];
    return fill(state, [...lines, ...fit(t, entryLines(state, t, step.entry), state.size.height - lines.length - next.length), ...next]);
  }
  // The demo connects nothing: it goes on as if the person had approved.
  const connected = state.demo ? 'In the demo, as if you approved.' : state.tier ? `Connected on the ${state.tier} tier.` : 'Connected to PreReason.';
  // Each question with the briefings that answer it, where the window has room for both.
  const both = 3 + 51 + Math.max(...FIRST_QUESTIONS.map((q) => q.briefings.join(', ').length)) <= W(state);
  const choices = FIRST_QUESTIONS.flatMap((q, i): Line[] => (both ? [[...option(t, q.question.padEnd(51), i === step.cursor), t('dim', q.briefings.join(', '))]] : options(state, t, q.question, i === step.cursor)));
  const own: Line =
    step.typed !== null
      ? typing(state, t, step.typed, '')
      : step.cursor === FIRST_QUESTIONS.length
        ? [t('accentBold', ' › '), t('ph', 'Or type your own question')]
        : [t('fg', '   '), t('ph', 'Or type your own question')];
  const rest: Line[] = [
    [],
    ...choices,
    own,
    [],
    ...(step.typed !== null
      ? keys(state, t, 'Enter to ask · Esc goes back to the list', 'Enter to ask | Esc goes back to the list')
      : keys(state, t, 'Enter to ask · ↑ ↓ to move · Esc to skip', 'Enter to ask | up and down to move | Esc to skip')),
  ];
  const title = headlines(state, t, 'Ask your first question');
  const duoLines = strips(state, t, 2);
  return fill(state, fitting(state, () => [...lines, ...duoLines, ...title, ...leads(state, t, `${connected} Pick one, or type your own.`), ...rest], () => [...lines, ...duoLines, ...title, ...rest], () => [...lines, ...title, ...rest]));
}

function digestStep(state: State, t: Maker, plain: boolean): Line[] {
  const step = state.step;
  if (step.name !== 'digest') return [];
  const lines = head(state, t, plain, 3);
  if (step.stage === 'entry' || step.stage === 'adding' || step.stage === 'added' || step.stage === 'failed') {
    const e = step.entry;
    if (!e) return fill(state, lines);
    const runtime = state.model?.spec?.kind === 'ollama' ? 'Ollama running then; the digest checks it first and says so if not' : state.model?.spec?.kind === 'hosted' ? 'your key set then, in the same variable' : 'the model reachable then';
    const labelled = (label: string, text: string, role: string): Line[] => wrapIn(t, role, text, inside(state) - 7, '       ').map((l, i): Line => [t('dim', i ? '' : label), ...l]);
    const body: Line[] = [
      ...labelled('name   ', e.name, 'bright'),
      ...labelled('runs   ', e.runs, 'bright'),
      ...labelled('when   ', e.when, 'fg'),
      ...labelled('needs  ', runtime, 'fg'),
    ];
    const closing = state.demo ? 'In the demo nothing is added.' : '/schedule shows this again; /schedule remove takes it out.';
    const after: Line[] =
      step.stage === 'adding'
        ? spinning(state, t, `Adding it to ${e.where}.`)
        : step.stage === 'added'
          ? [...marked(state, t, t('accent', ' ✓ ', ' ok '), 'fg', step.message ?? 'Added.'), [], askLine(t, 'Enter to finish')]
          : step.stage === 'failed'
            ? [...marked(state, t, t('accentBold', ' ✗ ', ' x '), 'fg', step.message ?? 'It was not added.'), [], askLine(t, 'Enter to go back')]
            : [askLine(t, 'Enter to add it'), help(t, 'Esc to go back')];
    return fill(state, [...lines, ...headlines(state, t, `The entry primerkit adds to ${e.where}`), [], ...closed(state, t, body, closing), [], ...after]);
  }
  if (step.stage === 'time') {
    return fill(state, [
      ...lines,
      ...headlines(state, t, 'At what time?'),
      ...leads(state, t, "The machine's own time, on a 24 hour clock, such as 07:30."),
      [],
      typing(state, t, step.typed, '07:30'),
      ...(step.message ? [[], ...wrapWords(step.message, W(state) - 1).map((l): Line => [t('muted', ` ${l}`)])] : []),
      [],
      ...keys(state, t, 'Enter to go on · Esc goes back', 'Enter to go on | Esc goes back'),
    ]);
  }
  const reads = state.watchlist.length ? `Reads ${joinAnd(state.watchlist).replace(/, and /, ' and ')}` : 'Reads your watchlist';
  const calls = state.dayLimit ? `: ${state.watchlist.length} of your ${state.dayLimit.toLocaleString('en-US')} calls a day.` : '.';
  const seconds = state.fitness?.speed.secondsPerCall ? ` Runs on ${state.model?.name} in about ${Math.max(5, Math.round((state.fitness.speed.secondsPerCall ?? 0) * Math.max(1, state.watchlist.length)))} seconds.` : '';
  const where = state.schedulerName;
  const title = headlines(state, t, 'A digest each morning?');
  const what = reflow(['What changed in your briefings since the day before, checked and cited,', 'waiting when you open primerkit.'], W(state) - 1).map((l) => lead(t, l));
  const rest: Line[] = [
    [],
    ...['Yes, at 08:00', 'Yes, at another time', state.firstRun ? 'Not now' : 'Leave it as it is'].map((o, i) => option(t, o, i === step.cursor)),
    [],
    ...closed(state, t, wrapIn(t, 'fg', `${reads}${calls}${seconds}`, inside(state)), `You see the entry it adds to ${where} before it is added.`),
    [],
    ...keys(state, t, 'Enter to choose · ↑ ↓ to move', 'Enter to choose | up and down to move'),
  ];
  const bare = state.firstRun ? [banner(state, t), rail(t, plain, 3, W(state)), []] : lines;
  return fill(state, fitting(state, () => [...lines, ...title, ...what, ...rest], () => [...lines, ...title, ...rest], () => [...bare, ...title, ...rest]));
}

// ------------------------------------------------------------------ inside an AI app

function installScreen(state: State, t: Maker, plain: boolean): Line[] {
  const step = state.step;
  if (step.name !== 'install') return [];
  const lines = head(state, t, plain, 0);
  // A line that fits keeps its spacing; a longer one, such as a command with its paths, wraps.
  const paths = (text: string[]) => text.flatMap((l): Line[] => (Array.from(l).length <= inside(state) ? [[t('fg', l)]] : wrapIn(t, 'fg', l, inside(state), '  ')));
  switch (step.phase) {
    case 'confirm':
      return fill(state, [
        ...lines,
        ...headlines(state, t, `Putting primerkit into ${step.app}`),
        ...leads(state, t, 'These changes are made when you press Enter:'),
        [],
        ...closed(state, t, paths(step.lines), `Nothing else in ${step.app} changes.`),
        [],
        askLine(t, 'Enter to make them'),
        help(t, 'Esc goes back'),
      ]);
    case 'applying':
      return fill(state, [...lines, ...headlines(state, t, `Putting primerkit into ${step.app}`), ...spinning(state, t, 'making the changes')]);
    case 'done':
      return fill(state, [
        ...lines,
        ...headlines(state, t, `primerkit is in ${step.app}`),
        [],
        ...closed(state, t, paths(step.message), 'uninstall --host takes it out again.'),
        [],
        ...leads(state, t, 'Next, connect PreReason: the skills read its briefings through primerkit.'),
        [],
        askLine(t, 'Enter to connect PreReason'),
        help(t, 'Esc goes back'),
      ]);
    case 'ready': {
      const where =
        step.app === 'Claude Code'
          ? ['In Claude Code, type /primerkit-ask with your question, or', '/primerkit-digest for what changed since the last digest.']
          : step.app === 'LM Studio'
            ? ['In LM Studio, ask a model that can use tools your question.', 'LM Studio asks you before a call to primerkit, until you tell it', 'to always allow that tool.']
            : [`In ${step.app}, ask it to use the primerkit-ask skill with your question,`, 'or the primerkit-digest skill.'];
      return fill(state, [
        ...lines,
        ...headlines(state, t, `Ready in ${step.app}`),
        [],
        ...closed(state, t, reflow(where, inside(state)).map((l): Line => [t('fg', l)]), "Each answer is checked here and kept in primerkit's journal."),
        [],
        askLine(t, 'Enter to also pick a model for this session'),
        help(t, 'Esc to leave'),
      ]);
    }
    case 'failed':
      return fill(state, [...lines, ...headlines(state, t, 'Nothing was changed'), [], ...closed(state, t, paths(step.message), `${step.app} is as it was.`), [], help(t, 'Enter or Esc goes back')]);
  }
}

// ------------------------------------------------------------------ the benchmark

const ARM_NAMES: Record<string, string> = { markdown: 'markdown', json: 'JSON', none: 'none' };

// Right answers per 1,000 tokens as bars, the widest for the best arm; the arm with no
// data reads nothing, so it shows only its share right. The bars take what the block
// leaves beside the columns, at most the 20 they always had.
function benchBody(t: Maker, r: BenchResult, stopped: string | null, room: number): Line[] {
  const length = Math.max(6, Math.min(20, room - 36));
  const top = Math.max(0, ...r.arms.filter((a) => a.arm !== 'none').map((a) => a.perThousand ?? 0));
  const rows = r.arms.map((a): Line => {
    const head = t('fg', `${(ARM_NAMES[a.arm] ?? a.arm).padEnd(10)} ${a.accuracy === null ? '  n/a' : `${Math.round(a.accuracy * 100)}%`.padStart(5)}  ${(a.tokens === null ? '' : Math.round(a.tokens).toLocaleString('en-US')).padStart(8)}    `);
    if (a.arm === 'none') return [head, t('dim', 'no data read')];
    const share = top > 0 && a.perThousand ? a.perThousand / top : 0;
    return [head, t('chart', bar(share, length, false), '#'.repeat(Math.max(1, Math.round(share * length)))), t('bright', ` ${(a.perThousand ?? 0).toFixed(2)}`)];
  });
  const minutes = r.seconds < 90 ? `${r.seconds} s` : `${Math.round(r.seconds / 60)} min`;
  const summary = `${r.briefings.length} briefings · ${r.arms.length} arms · ${r.runs} ${r.runs === 1 ? 'run' : 'runs'} each · ${r.answers} answers · ${minutes}`;
  // The heading keeps its columns over the rows'; the bars' title wraps within its own.
  const columns = 'arm         right    tokens    ';
  const title = wrapWords('right answers per 1,000 tokens', room - columns.length);
  return [
    ...wrapWords(summary, room).map((l): Line => [t('muted', l)]),
    [],
    ...title.map((l, i): Line => [t('dim', `${i ? ' '.repeat(columns.length) : columns}${l}`)]),
    ...rows,
    [],
    ...wrapIn(t, 'fg', bestLine(r), room),
    ...wrapIn(t, 'muted', "PreReason's own run is published at prereason.com/evidence.", room),
    ...(stopped ? wrapIn(t, 'muted', `It stopped after ${r.answers} answers: ${stopped}.`, room) : []),
    ...wrapIn(t, 'dim', '/bench card saves a share card on this machine only', room),
  ];
}

// ------------------------------------------------------------------ boards and charts

// A board or chart, scrolled a screen at a time. The session draws it for the room at
// its width, and draws it again when the window is resized; a sentence wider than the
// block wraps, and the rows of a chart are never wider.
// A board as its screen lays it out: its lines fitted to the window (a sentence wraps at
// the grid's width, however wide the window, so it still reads as a line), its heading,
// its keys, and the rows left for it: the window's, less the top line, its blank, the
// heading, the credit, the keys and a blank last row.
function boardRoom(state: State, t: Maker, step: Extract<State['step'], { name: 'board' }>, board: Board): { body: Line[]; heading: Line[]; keysFor: (scroll: boolean) => Line[]; room: number } {
  const body = fitLines(t, board.lines, Math.min(inside(state), BOARD_ROOM));
  const heading = titled(state, t, board.title, board.subtitle);
  const ranges = step.request.kind === 'bitcoin' || step.request.kind === 'yield curve' || step.request.kind === 'metric';
  const ticks = step.request.kind === 'backtest';
  const keysFor = (scroll: boolean) => {
    const k = [
      scroll ? ['↑ ↓ to scroll', 'up and down to scroll'] : null,
      ranges ? ['← → changes the range', 'left and right change the range'] : null,
      ticks ? ['← → moves through the ticks', 'left and right move through the ticks'] : null,
      ticks ? (step.request.kind === 'backtest' && step.request.detail ? ['d goes back to the report', 'd goes back to the report'] : ['d shows a tick step by step', 'd shows a tick step by step']) : null,
      ['Esc goes back', 'Esc goes back'],
    ].filter((x): x is string[] => x !== null);
    return keys(state, t, k.map((x) => x[0]).join(' · '), k.map((x) => x[1]).join(' | '));
  };
  const room = Math.max(3, state.size.height - 2 - heading.length - 1 - keysFor(true).length - 1);
  return { body, heading, keysFor, room };
}

function boardScreen(state: State, t: Maker, plain: boolean): Line[] {
  const step = state.step;
  if (step.name !== 'board') return [];
  const lines = [top(state, t), []];
  // A chart takes the window's width; a sentence wraps at the grid's, however wide the
  // window, so it still reads as a line.
  const text = Math.min(inside(state), BOARD_ROOM);
  if (step.error) return fill(state, [...lines, headline(t, 'Not drawn'), ...wrapIn(t, 'muted', step.error, text).map((l): Line => [t('fg', ' '), ...l]), [], help(t, 'Esc goes back')]);
  if (!step.view) return fill(state, [...lines, ...spinning(state, t, step.status), [], help(t, 'Esc goes back')]);
  const board = plain ? step.view.plain : step.view.unicode;
  const { body, heading, keysFor, room } = boardRoom(state, t, step, board);
  // A board that could not narrow to the window is not drawn broken: a line says how
  // wide a window it needs, and it is drawn again as soon as the window is that wide.
  const widest = Math.max(0, ...body.map(widthOf));
  if (widest > inside(state)) {
    const note = `Too narrow to draw: it needs a window at least ${widest + 5} columns wide, and this one is ${W(state) + 1}.`;
    return fill(state, [...lines, ...heading, [], ...leads(state, t, note), [], help(t, 'Esc goes back')]);
  }
  const first = Math.min(step.top, Math.max(0, body.length - room));
  const shown = body.slice(first, first + room);
  const time = (board.generated ?? '').slice(11, 16);
  return fill(state, [...lines, ...heading, ...block(t, shown, credit(state, t, board.sources, time)), ...keysFor(body.length > room)]);
}

// The line crediting PreReason, in the room a block leaves: without the time where the
// whole line does not fit, and the mark alone where the sources do not either.
function credit(state: State, t: Maker, what: string, time: string): Line {
  const lines: Line[] = [prLine(t, what, time), [...prMarkLead(t), t('dim', what)], [prTile(t)]];
  return lines.find((l) => widthOf(l) <= inside(state)) ?? [prTile(t)];
}

// ------------------------------------------------------------------ in a session

// An opened run as the journal draws it: its text wrapped to the window, and the rows it
// has: the window's, less the top line, its blank, the title, the closing count, the keys
// and a blank last row.
function openRun(state: State, t: Maker, open: { title: string; lines: string[] }): { title: Line[]; keyLines: Line[]; room: number; text: Line[] } {
  const title = headlines(state, t, open.title);
  const keyLines = keys(state, t, '↑ ↓ to scroll · Esc goes back', 'up and down to scroll | Esc goes back');
  const room = Math.max(3, state.size.height - 2 - title.length - 1 - keyLines.length - 1);
  const text = open.lines.flatMap((l) => (l.trim() ? wrapIn(t, 'fg', l, inside(state)) : [[]]));
  return { title, keyLines, room, text };
}

// How far the step on screen scrolls, as it is drawn: the lines of an opened journal run or
// of a board, and the rows that show at once. The session keeps its scroll within them, so
// the last arrow reaches the end and none is spent past it. Null where nothing scrolls.
export function scrollSpan(whole: State): { total: number; room: number } | null {
  const t = maker(true);
  // Inside the panel, a row shorter than the window for the status strip, as screen() draws it.
  const state = panelState(whole);
  const step = state.step;
  if (step.name === 'journal' && step.open) {
    const { room, text } = openRun(state, t, step.open);
    return { total: text.length, room };
  }
  if (step.name === 'board' && step.view && !step.error) {
    const { body, room } = boardRoom(state, t, step, step.view.plain);
    return { total: body.length, room };
  }
  if (step.name === 'compare' && step.phase === 'done' && step.result) {
    const { body, room } = compareRoom(state, t, step.question, step.result);
    return { total: body.length, room };
  }
  return null;
}

function journal(state: State, t: Maker): Line[] {
  const step = state.step;
  if (step.name !== 'journal') return [];
  const lines = [top(state, t), []];
  if (step.open) {
    const { title, keyLines, room, text } = openRun(state, t, step.open);
    const shown = text.slice(step.open.top, step.open.top + room);
    return fill(state, [...lines, ...title, ...block(t, shown, [t('dim', `${Math.min(text.length, step.open.top + room)} of ${text.length} lines`)]), ...keyLines]);
  }
  if (!step.rows.length) return fill(state, [...lines, headline(t, 'Journal'), ...leads(state, t, step.filter ? `Nothing in the journal matches ${step.filter}. /journal alone lists every run.` : 'Nothing is in the journal yet. Every question, digest and check is kept here.'), [], help(t, 'Esc goes back')]);
  // Filtered with words after /journal; a summary row heads each day.
  const heading = titled(state, t, 'Journal', step.filter ? `runs matching ${step.filter}, newest at the top` : 'every run on this machine, newest first');
  const keyLines = keys(state, t, 'Enter opens one · ↑ ↓ to move · Esc goes back', 'Enter opens one | up and down to move | Esc goes back');
  const { first, shown } = windowed(step.rows, step.cursor, Math.max(3, state.size.height - lines.length - heading.length - 1 - keyLines.length - 1));
  // Where the window is narrow the time goes, and the operation's name shortens, so the
  // title keeps room to be read.
  const wide = W(state) >= 66;
  return fill(state, [
    ...lines,
    ...heading,
    ...shown.map((r, i) => {
      const operation = wide ? r.operation.padEnd(12) : (r.operation === 'model-check' ? 'check' : r.operation).padEnd(7);
      const text = (wide ? `${r.day} ${r.time}  ${operation} ${r.title}` : `${r.day}  ${operation} ${r.title}`).slice(0, W(state) - 16).padEnd(W(state) - 16);
      return [...option(t, text, first + i === step.cursor), t('dim', ` ${r.outcome}`)];
    }),
    [],
    ...keyLines,
  ]);
}

function home(state: State, t: Maker, plain: boolean): Line[] {
  const running = state.feed.some((e) => e.kind === 'running');
  const under = state.menu
    ? menuLines(state, t, state.menu)
    : state.notice
      ? wrapWords(state.notice, W(state) - 3).map((l): Line => [t('dim', `   ${l}`)])
      : keys(state, t, 'Tab switches the model · a code and Enter runs it · / lists every command', 'Tab switches the model | a code and Enter runs it | / lists every command');
  // The rows inside the panel: the window's, less the title bar, two blanks, the input and
  // what sits under it.
  const room = state.size.height - 4 - under.length;
  // The launchpad heads the screen in the rows the answers leave: the mark beside the
  // connections, then the functions by their codes. The answers, the opening and today's
  // digest take their rows first, and the launchpad gives way, a part at a time.
  const feed = feedLines(state, t, room);
  const head = launchpad(state, t, plain).find((f) => feed.length + f.length <= room) ?? [];
  return fill(state, [top(state, t), [], ...head, ...feed, [], inputLine(t, state.input, !running, W(state)), ...under], 2 + head.length);
}

// The launchpad's forms, the fullest first: the mark beside the connections and the
// no-advice line, then the functions; the connections without the mark; the functions alone;
// nothing. Each form ends on a blank row.
function launchpad(state: State, t: Maker, plain: boolean): Line[][] {
  const conn = connectionRows(state, t);
  const fns = functionRows(state, t);
  const advice = wrapWords(NO_ADVICE, W(state) - 2).map((l): Line => [t('dim', ` ${l}`)]);
  const mark = markSize('mini');
  const withMark = (): Line[] => {
    const art = lockupMini(t);
    const room = W(state) - mark.columns - 4;
    const side = [[t('accentBold', 'CONNECTIONS')] as Line, ...connectionRows(state, t, room)];
    if (side.some((l) => widthOf(l) > room)) return [];
    const rows = Math.max(art.length, side.length);
    return Array.from({ length: rows }, (_, i): Line => {
      const left = art[i] ?? [t('fg', ' '.repeat(mark.columns + 1))];
      return [...left, t('fg', '   '), ...(side[i] ?? [])];
    });
  };
  const head = (lines: Line[]): Line[] => (lines.length ? [...lines, []] : []);
  const forms: Line[][] = [];
  const art = plain ? [] : withMark();
  // A wide window has the room for a panel of the newest runs under the functions.
  const runs = W(state) >= WIDE_COLUMNS - 1 ? recentRows(state, t) : [];
  if (art.length && runs.length) forms.push([...head(art), ...head(advice), ...head(fns), ...head(runs)]);
  if (art.length) forms.push([...head(art), ...head(advice), ...head(fns)], [...head(art), ...head(fns)]);
  const titled = [[t('accentBold', ' CONNECTIONS')] as Line, ...conn];
  if (!art.length && runs.length) forms.push([...head(titled), ...head(advice), ...head(fns), ...head(runs)]);
  forms.push([...head(titled), ...head(advice), ...head(fns)], [...head(conn), ...head(fns)], head(fns), head(functionBar(state, t)), []);
  return forms;
}

// The functions on one row, each code beside its name, as many as the width holds.
function functionBar(state: State, t: Maker): Line[] {
  const line: Line = [];
  for (const f of FUNCTIONS) {
    const cell: Line = [t('accentBold', ` ${f.code}`), t('muted', ` ${f.command.slice(1)} `)];
    if (widthOf([...line, ...cell]) > W(state)) break;
    line.push(...cell);
  }
  return line.length ? [line] : [];
}

// The newest runs the journal holds, as many as the launchpad shows.
export const RECENT_RUNS = 5;

// The newest runs as a table: when, what ran, its title and how it ended.
function recentRows(state: State, t: Maker): Line[] {
  if (!state.recent.length) return [];
  const title: Line = [t('accentBold', ' RECENT RUNS'), t('dim', '  JR /journal opens them')];
  const outcome = Math.max(0, ...state.recent.map((r) => r.outcome.length));
  const room = W(state) - 1 - 13 - 13 - (outcome ? outcome + 2 : 0);
  const rows = state.recent.map((r): Line => {
    const name = Array.from(r.title).length > room ? `${Array.from(r.title).slice(0, room - 1).join('')}…` : r.title.padEnd(room);
    return [t('dim', ` ${`${r.day} ${r.time}`.padEnd(13)}`), t('muted', r.operation.padEnd(13)), t('fg', name), ...(outcome ? [t('dim', `  ${r.outcome}`)] : [])];
  });
  return [title, ...rows];
}

// The mini mark, one space in from the edge.
function lockupMini(t: Maker): Line[] {
  return pkMark('mini').map((row): Line => [t('fg', ' '), ...row.map(([role, text]) => t(role, text))]);
}

// The connections as they stand: the model, PreReason, and the brokers.
function connectionRows(state: State, t: Maker, width = W(state) - 1): Line[] {
  // Sandstone for a connection that is on: green and red mark only a change the data states.
  const on = (yes: boolean): Segment => t(yes ? 'accent' : 'dim', yes ? '● ' : '○ ', yes ? '* ' : '. ');
  const model = state.model ? state.model.label : 'none chosen: Tab picks one';
  const calls = state.callsLeft != null && !state.demo ? `, ${state.callsLeft.toLocaleString('en-US')} calls left today` : '';
  const prereason = state.demo ? `briefings saved on ${state.demo.date}` : state.connected ? `${state.tier ? `${state.tier} tier` : 'connected'}${calls}` : 'not connected: /connect prereason';
  const rows: Array<[boolean, string, string]> = [
    [Boolean(state.model), 'model', model],
    [state.connected || Boolean(state.demo), 'PreReason', prereason],
    [false, 'brokers', 'off until you turn one on: /connect'],
  ];
  const lead = width < 40 ? 1 : 2;
  return rows.map(([yes, name, what]): Line => {
    const line: Line = [t('fg', ' '.repeat(lead - 1)), on(yes), t('fg', name.padEnd(11)), t('muted', what)];
    return clip(line, width);
  });
}

// The functions by their codes, in two columns where the width holds them and one where not:
// the code, the command and what it does, each column as wide as its longest row.
function functionRows(state: State, t: Maker): Line[] {
  const cell = (f: (typeof FUNCTIONS)[number], pad = 0): Line => [t('accentBold', ` ${f.code}`), t('bright', ` ${f.command.padEnd(9)}`), t('muted', ` ${f.about}`.padEnd(pad))];
  const title: Line = [t('accentBold', ' FUNCTIONS'), t('dim', '  a code and Enter runs it')];
  const half = Math.ceil(FUNCTIONS.length / 2);
  const [left, right] = [FUNCTIONS.slice(0, half), FUNCTIONS.slice(half)];
  const width = Math.max(...left.map((f) => widthOf(cell(f))));
  if (width + 2 + Math.max(...right.map((f) => widthOf(cell(f)))) <= W(state)) {
    return [title, ...left.map((a, i): Line => [...cell(a, width - widthOf(cell(a)) + 1 + a.about.length + 2), ...(right[i] ? cell(right[i]!) : [])])];
  }
  return [title, ...FUNCTIONS.map((f) => cell(f))];
}

// The menu under the input: each row with what it does beside it where every row's
// words fit, and otherwise the rows alone and the words of the one highlighted under
// them. The rows scroll around the one highlighted, fewer at a time in a short window.
function menuLines(state: State, t: Maker, menu: Menu): Line[] {
  const { first, shown } = windowed(menu.rows, menu.cursor, Math.max(3, Math.min(8, state.size.height - 12)));
  const name = Math.max(0, ...shown.map((r) => Array.from(r.text).length));
  const beside = shown.every((r) => 3 + name + 2 + Array.from(r.about).length <= W(state));
  const rows = shown.map((r, i): Line => {
    const chosen = first + i === menu.cursor;
    return [t(chosen ? 'accentBold' : 'fg', chosen ? ' › ' : '   '), t(chosen ? 'bright' : 'fg', beside ? r.text.padEnd(name) : r.text), ...(beside ? [t('muted', `  ${r.about}`)] : [])];
  });
  const about = beside ? [] : wrapWords(menu.rows[menu.cursor]?.about ?? '', W(state) - 3).map((l): Line => [t('muted', `   ${l}`)]);
  const count = menu.rows.length > shown.length ? `${menu.cursor + 1} of ${menu.rows.length}` : null;
  const hint = ['↑ ↓ to move', 'Enter chooses', 'Tab completes', 'Esc closes'];
  const plainHint = ['up and down to move', 'Enter chooses', 'Tab completes', 'Esc closes'];
  return [...rows, ...about, ...keys(state, t, [...(count ? [count] : []), ...hint].join(' · '), [...(count ? [count] : []), ...plainHint].join(' | '))];
}

// The opening of a later start and today's digest first, then the newest entries that
// fit whole, newest at the bottom. An older entry that does not fit whole is left out,
// not cut. The opening shows only until the first entry: then the answers have the
// room. Today's digest keeps its place beside it, with a shorter opening where the
// whole one and the digest do not both fit.
function feedLines(state: State, t: Maker, room: number): Line[] {
  const out: Line[] = [];
  for (let i = state.feed.length - 1; i >= 0; i--) {
    const entry = state.feed[i];
    if (!entry) continue;
    const lines = entryLines(state, t, entry);
    const needed = lines.length + (out.length ? 1 : 0);
    if (out.length + needed > room) {
      if (!out.length) return fit(t, lines, room);
      break;
    }
    out.unshift(...lines, ...(out.length ? [[]] : []));
  }
  const digestShown = state.feed.some((e) => e.kind === 'digest');
  const digest = state.digest && !digestShown ? digestLines(state, t, state.digest, false) : [];
  const forms = state.opening && !state.feed.length ? openings(state, t, state.opening) : [];
  // Today's digest keeps its place before the opening alone does: the opening's since line
  // only says what the digest shows.
  for (const parts of [...forms.map((o) => [o, digest]), [digest], ...forms.map((o) => [o])]) {
    const head = parts.filter((p) => p.length).flatMap((p, i): Line[] => (i ? [[], ...p] : p));
    if (head.length && out.length + head.length + (out.length ? 1 : 0) <= room) {
      out.unshift(...head, ...(out.length ? [[]] : []));
      break;
    }
  }
  return out;
}

// ------------------------------------------------------------------ the opening

// The greeting of a later start, by the hour on this machine's clock.
export function greeting(hour: number): string {
  return hour >= 5 && hour < 12 ? 'Good morning.' : hour >= 12 && hour < 18 ? 'Good afternoon.' : 'Good evening.';
}

// What changed since last time: today's digest, measured from the one before it, or, with
// no digest today, when the newest run the journal holds was made.
function sinceText(state: State, o: Opening): string | null {
  const d = state.digest;
  if (d?.failed) return `today's digest did not run at ${hhmm(d.ranAt)} UTC`;
  if (d) {
    const n = d.changes.length;
    return d.since ? `today's digest has ${n === 0 ? 'no changes' : n === 1 ? '1 change' : `${n} changes`} since ${d.since}` : "today's digest is the first, with nothing to compare yet";
  }
  return o.lastRun ? `your last run was ${o.lastRun.day} at ${o.lastRun.time}; no digest has run today` : null;
}

// Two or three next steps from where things stand: PreReason first when it is not
// connected, a question with an example that changes by the day, the digest, then the
// last run, a schedule or the catalog.
function nextSteps(state: State, o: Opening): Array<[string, string]> {
  // The example changes by the day, among the first questions that are not about Bitcoin:
  // Bitcoin is not the focus, and the list holds questions about it.
  const examples = FIRST_QUESTIONS.filter((q) => !/bitcoin/i.test(q.question));
  const pool = examples.length ? examples : FIRST_QUESTIONS;
  const question = (pool[o.day % pool.length] ?? pool[0])?.question ?? '';
  const ask: [string, string] = ['ask', `such as "${question}"`];
  const d = state.digest;
  const digest: [string, string] = ['/digest', d && !d.failed ? "today's digest in full" : 'what changed since the last digest'];
  const later: [string, string] = o.lastRun ? ['/journal', `your last run, ${o.lastRun.operation}: ${o.lastRun.title}`] : !o.scheduled ? ['/schedule', 'a digest each morning, at a time you set'] : ['/catalog', 'every briefing your key reads'];
  if (!state.connected) return [['/connect', 'PreReason, for the data your model reads'], ask, later];
  return [ask, digest, later];
}

// The opening: a calm greeting, the model and PreReason as they stand, what changed since
// last time, and the next steps, numbered. In a smaller window, the greeting and the
// steps, then the greeting alone: the first of the three that fits is drawn.
function openings(state: State, t: Maker, o: Opening): Line[][] {
  const room = W(state) - 1;
  // The model and PreReason stand in the status strip and the launchpad's connections, so
  // the opening says only what changed since last time.
  const since = sinceText(state, o);
  const fields: Array<[string, string]> = since ? [['since', since]] : [];
  const steps = nextSteps(state, o);
  const name = Math.max(...steps.map(([c]) => c.length)) + 2;
  const hello: Line = [t('bright', ` ${greeting(o.hour)}`)];
  const numbered = steps.flatMap(([cmd, about], i) => wrapWords(about, room - 6 - name).map((l, j): Line => (j ? [t('muted', `${' '.repeat(6 + name)}${l}`)] : [t('accent', `   ${i + 1}  `), t('fg', cmd.padEnd(name)), t('muted', l)])));
  const said = fields.flatMap(([label, text]) => fieldLines(t, `   ${label}`, text, 15, room));
  return [[hello, ...(said.length ? [[], ...said] : []), [], ...numbered], [hello, [], ...numbered], [hello, ...said], [hello]];
}

// An entry taller than the room keeps its question, its first lines and its closing
// line, and says how many lines it leaves out between them.
// A credit that runs on under its mark (a news answer's) is its closing, kept whole from the
// mark on, so the mark is never cut from the words it leads.
function fit(t: Maker, lines: Line[], room: number): Line[] {
  if (lines.length <= room) return lines;
  if (room < 3) return lines.slice(0, Math.max(0, room));
  const mark = lines.findLastIndex((l) => l.some(([role]) => role === 'pr/prTile'));
  const runsOn = mark > 0 && lines.slice(mark + 1).every((l) => l.length === 2 && l[1]?.[0] === 'dim' && /^ {4,}\S/.test(l[1][1]));
  const keep = Math.min(runsOn ? lines.length - mark : 1, room - 2);
  const left = lines.length - (room - 1 - keep) - keep;
  const more = `${left} more ${left === 1 ? 'line' : 'lines'}`;
  return [...lines.slice(0, room - 1 - keep), [t('rule', ' │ '), t('dim', `… ${more}`, `... ${more}`)], ...lines.slice(-keep)];
}

function modelName(state: State): string {
  return state.model?.name ?? 'the model';
}

// The time a credit line names: none for blocks that carry no generated time (a metric
// read alone), in place of the word "unknown".
const timeOf = (iso: string | null): string => (iso ? hhmm(iso) : '');

// The briefings named on the credit line, or their count where the names do not fit.
export function creditOf(briefings: string[], width = GRID.width, asOf?: string): string {
  const names = briefings.join(', ');
  const tail = asOf ? ` · as it stood on ${longDay(asOf)}` : ' · generated 00:00 UTC';
  // The block's corner, the tile and its space: " └ ", " PR " and " ".
  return names.length <= width - ` └  PR  ${tail}`.length ? names : `${briefings.length} ${briefings.some((b) => !b.includes('.')) ? 'sources' : 'briefings'}`;
}

function sourceLines(t: Maker, sources: Array<{ n: number; block: string; line: number }>, room: number): Line[] {
  const items = sources.map((s) => `[${s.n}] ${s.block} L${s.line}`);
  const out: Line[] = [];
  let line = '';
  for (const item of items) {
    if (line && Array.from(line).length + 3 + item.length > room - 2) {
      out.push([t('dim', out.length ? `  ${line}` : `↳ ${line}`)]);
      line = item;
    } else {
      line = line ? `${line}   ${item}` : item;
    }
  }
  if (line) out.push([t('dim', out.length ? `  ${line}` : `↳ ${line}`)]);
  return out;
}

// The records a news answer cites, each as its line reads and then its link, under the number
// the answer gives it, wrapped under its own start; a link breaks after a slash.
function recordLines(t: Maker, sources: Array<{ n: number; block: string; line: number }>, read: NewsRead, room: number): Line[] {
  return sources.flatMap((s, j) => {
    const record = s.block === NEWS_BLOCK ? recordShown(read, s.line) : null;
    return wrapWords(`[${s.n}] ${record ?? `${s.block} L${s.line}`}`, room - 2, '    ').map((l, i): Line => [t('dim', i || j ? `  ${l}` : `↳ ${l}`)]);
  });
}

// What a news read says beside its records, printed whenever it says it: the sources it did
// not read, and each source's notice, as served.
function newsSide(t: Maker, read: NewsRead, room: number): Line[] {
  return sideLines(read).flatMap((l) => wrapIn(t, 'muted', l, room - 2, '  ').map((w, i): Line => [t('dim', i ? '  ' : '○ ', i ? '  ' : '. '), ...w]));
}

// The credit under a news answer: the door, whose records, the window and when it was read.
// Wider than the block, it goes on under the mark, broken between its parts, and its last
// part closes the block, so no word of it is cut.
function newsCreditLines(state: State, t: Maker, read: NewsRead): { inside: Line[]; closing: Line } {
  const lead = prMarkLead(t);
  const room = inside(state) - widthOf(lead);
  const rows: string[] = [];
  for (const part of newsCredit(read).split(' · ')) {
    const last = rows.at(-1);
    if (last !== undefined && textWidth(`${last} · ${part}`) <= room) rows[rows.length - 1] = `${last} · ${part}`;
    else rows.push(part);
  }
  const under = ' '.repeat(widthOf(lead));
  const lines = rows.map((r, i): Line => (i ? [t('dim', `${under}${r}`)] : [...lead, t('dim', r)]));
  return { inside: lines.slice(0, -1), closing: lines.at(-1) ?? [prTile(t)] };
}

const DIGEST_GLYPHS: Record<DigestLine['glyph'], [string, string, string]> = {
  up: ['up', '▲ ', '^ '],
  down: ['down', '▼ ', 'v '],
  flat: ['muted', '● ', 'o '],
  moved: ['accent', '◆ ', '+ '],
  missing: ['dim', '○ ', '. '],
};

// Up to four names, then how many more.
export function sameList(names: string[]): string {
  if (names.length <= 5) return joinAnd(names).replace(/, and ([^,]+)$/, ' and $1');
  return `${names.slice(0, 4).join(', ')} and ${names.length - 4} more`;
}

export function digestLines(state: State, t: Maker, view: DigestView, withQuestion: boolean): Line[] {
  const room = inside(state);
  if (view.failed) {
    const why = wrapIn(t, 'fg', view.failed, room);
    return [...(withQuestion ? [askLine(t, '/digest')] : []), [t('accentBold', ' Digest'), t('muted', `  did not run at ${hhmm(view.ranAt)} UTC`)], ...block(t, why.slice(0, -1), why.at(-1) ?? [])];
  }
  const n = view.changes.length;
  const since = view.since ? `${n === 0 ? 'no changes' : n === 1 ? '1 change' : `${n} changes`} since ${view.since}` : 'first digest: nothing to compare yet';
  const body: Line[] = [];
  for (const c of view.changes) {
    const [role, glyph, plainGlyph] = DIGEST_GLYPHS[c.glyph];
    const text = withRefs(c.computed ? `${c.text.replace(/\.$/, '')}, as the diff states it.` : c.text, c.refs);
    wrap(t, text, room - 2).forEach((l, i) => body.push(i ? [t('fg', '  '), ...l] : [t(role, glyph, plainGlyph), ...l]));
  }
  if (view.same.length) body.push(...wrapIn(t, 'fg', `Same signal and direction: ${sameList(view.same)}.`, room - 2, '  ').map((l, i): Line => [t('muted', i ? '  ' : '● ', i ? '  ' : 'o '), ...l]));
  for (const note of view.notes) body.push(...wrapIn(t, 'fg', note, room - 2, '  ').map((l, i): Line => [t('dim', i ? '  ' : '○ ', i ? '  ' : '. '), ...l]));
  if (view.sources.length || view.checks) body.push([]);
  body.push(...sourceLines(t, view.sources, room));
  if (view.checks) {
    // The checks named, from the ones that ran (the wording review, 10-12): what was checked, never more.
    const named = checksText(view.checks);
    const checks = `${named.text}${view.computed ? ` · ${view.computed} said as the diff states it` : ''}`;
    body.push(...wrapWords(checks, room - 3).map((l, i): Line => (i ? [t('muted', `   ${l}`)] : [t('accent', named.ok ? '✓ ' : '✗ ', named.ok ? 'ok ' : 'x '), t('muted', l)])));
  }
  return [...(withQuestion ? [askLine(t, '/digest')] : []), ...titled(state, t, 'Digest', since), ...block(t, body, prLine(t, creditOf(view.briefings, W(state)), timeOf(view.generated)))];
}

export function entryLines(state: State, t: Maker, entry: Entry): Line[] {
  const room = inside(state);
  // The question as asked, its later lines under its first word.
  const ask = wrapWords(entry.question, W(state) - 3).map((l, i): Line => (i === 0 ? askLine(t, l) : [t('bright', `   ${l}`)]));
  switch (entry.kind) {
    case 'running': {
      const r = entry.running;
      const from = r.briefings.join(', ');
      const text =
        r.text ??
        (r.phase === 'choosing'
          ? 'choosing the briefings to read'
          : r.phase === 'reading'
            ? state.demo
              ? `reading ${from}, saved on ${state.demo.date}`
              : `reading ${from} from PreReason`
            : r.phase === 'answering'
              ? `${modelName(state)} is answering · ${(r.tokens ?? 0).toLocaleString('en-US')} tokens from ${from}`
              : r.phase === 'repairing'
                ? `${modelName(state)} is answering again, after a failed check`
                : 'checking the answer');
      const doing = wrapWords(text, room - 2).map((l, i): Line => (i ? [t('muted', `  ${l}`)] : [spin(t, state.frame), t('muted', ` ${l}`)]));
      return [...ask, ...closed(state, t, doing, r.stops ?? 'Ctrl+C stops it, and nothing from this run is kept', 'dim')];
    }
    case 'answer': {
      const v = entry.view;
      const body: Line[] = [];
      if (v.partial) {
        const n = v.dropped.length;
        const claims = v.dropped.filter((d) => !d.background).length;
        const background = n - claims;
        const what = [claims ? (claims === 1 ? 'one claim' : `${claims} claims`) : '', background ? (background === 1 ? 'one background sentence' : `${background} background sentences`) : ''].filter(Boolean).join(' and ') || `${n} claims`;
        body.push(...wrapWords(`Partial answer: ${what} failed ${n === 1 ? 'its checks and was' : 'their checks and were'} taken out.`, room - 2).map((l, i): Line => [t('accentBold', i ? '  ' : '✗ ', i ? '  ' : 'x '), t('bright', l)]));
      }
      // The answer first, then the lines it rests on and its checks, and only then what else
      // happened on the way, dim, so the answer is what the eye finds. A news answer that
      // cites no record says that none of the records read answers it.
      const news = entry.news;
      body.push(...wrap(t, news && !v.sentences.length ? noneLine(news) : v.sentences.map((s) => withRefs(s.text, s.refs)).join(' '), room));
      // Background reads apart from what the data says, and names where it came from.
      if (v.background?.length) body.push([], ...wrapIn(t, 'muted', `${BACKGROUND_LABEL}: ${v.background.join(' ')}`, room));
      body.push([]);
      body.push(...(news ? recordLines(t, v.sources, news, room) : sourceLines(t, v.sources, room)));
      // The demo's stand in answers at once, so its time says nothing and is left out. Its
      // answer to a typed question is a sample, never shown as checked: its sentences pass
      // their checks, but they do not answer the question asked.
      if (entry.sample) body.push(...wrapWords(DEMO_SAMPLE, room - 2).map((l, i): Line => [t('dim', i ? '  ' : '○ ', i ? '  ' : '. '), t('muted', l)]));
      else {
        const named = checksText(v.checks);
        const checks = `${named.text} · ${v.tokens.toLocaleString('en-US')} tokens read${state.demo ? '' : ` · ${v.seconds.toFixed(1)} s`}`;
        body.push(...wrapWords(checks, room - 3).map((l, i): Line => (i ? [t('muted', `   ${l}`)] : [t('accent', named.ok ? '✓ ' : '✗ ', named.ok ? 'ok ' : 'x '), t('muted', l)])));
      }
      for (const d of v.dropped) {
        const lines = wrapIn(t, 'muted', d.background ? `Taken out of the background: "${d.text}".` : `Not supported by the data: "${d.text}".`, room - 2, '  ');
        body.push(...lines.map((l, i): Line => [t('accent', i ? '  ' : '✗ ', i ? '  ' : 'x '), ...l]));
        if (d.reasons[0]) body.push(...wrapIn(t, 'muted', d.reasons[0], room - 2).map((l): Line => [t('muted', '  '), ...l]));
      }
      if (entry.added.length) body.push(...wrapWords(`Also read, close to the question: ${entry.added.join(', ')}.`, room - 2).map((l, i): Line => [t('dim', i ? '  ' : '+ '), t('dim', l)]));
      if (entry.skipped.length) body.push(...wrapWords(`Not read: ${entry.skipped.join(', ')}, not available on this key's tier.`, room - 2).map((l, i): Line => [t('dim', i ? '  ' : '○ ', i ? '  ' : '. '), t('muted', l)]));
      for (const note of entry.notes) body.push(...wrapIn(t, 'muted', note, room - 2, '  ').map((l, i): Line => [t('dim', i ? '  ' : '○ ', i ? '  ' : '. '), ...l]));
      // Last, so a short window gives it up first: what can be done next.
      if (!news) body.push(...nextLines(state, t, v.briefings, room));
      if (news) {
        body.push(...newsSide(t, news, room));
        const credit = newsCreditLines(state, t, news);
        return [...ask, ...block(t, [...body, ...credit.inside], credit.closing)];
      }
      return [...ask, ...block(t, body, v.asOf ? prLine(t, creditOf(v.briefings, W(state), v.asOf), timeOf(v.generated), longDay(v.asOf)) : prLine(t, creditOf(v.briefings, W(state)), timeOf(v.generated)))];
    }
    case 'no-records': {
      // What was read, and that its window holds no record: never "nothing happened".
      const body: Line[] = emptyLines(entry.news).flatMap((l, i) => wrapIn(t, i ? 'muted' : 'fg', l, room));
      body.push(...newsSide(t, entry.news, room));
      const credit = newsCreditLines(state, t, entry.news);
      return [...ask, ...block(t, [...body, ...credit.inside], credit.closing)];
    }
    case 'catalog': {
      // A table: each area's name and count on the left, its ids beside it, every area's
      // first id in one column. An area's ids stand in aligned columns of that area's own
      // width, as many as the room holds; an area whose ids are too long for two columns
      // runs them along the row instead. With one width for every area, a key's long ids
      // (commodities.grains-agribusiness) left one id a row, and 34 briefings ran off the
      // screen. Metrics show the first few of each area unless /catalog all asked for every one.
      const areas = (heading: string, list: Array<{ area: string; ids: string[] }>, fold = false): Line[] => {
        const kept = (ids: string[]) => (fold && !entry.all && ids.length > IDS_SHOWN ? ids.slice(0, IDS_SHOWN) : ids);
        const labelWidth = Math.max(0, ...list.map((a) => `${a.area} ${a.ids.length}`.length)) + 3;
        const rows: Line[] = [...wrapIn(t, 'dim', heading, room)];
        for (const a of list) {
          const ids = kept(a.ids);
          const cells = [...ids, ...(a.ids.length > ids.length ? [`+${a.ids.length - ids.length} more`] : [])];
          const cellWidth = Math.max(...cells.map((c) => c.length)) + 2;
          const columns = Math.floor((room - labelWidth) / cellWidth);
          const lines: string[][] = [];
          if (columns >= 2) for (let i = 0; i < cells.length; i += columns) lines.push(cells.slice(i, i + columns));
          else
            for (const c of cells) {
              const line = lines.at(-1);
              if (line && [...line, c].join('   ').length <= room - labelWidth) line.push(c);
              else lines.push([c]);
            }
          lines.forEach((row, i) => {
            const label: Line = i ? [t('fg', ' '.repeat(labelWidth))] : [t('fg', a.area), t('dim', ` ${a.ids.length}`.padEnd(labelWidth - a.area.length))];
            const cell = (c: string, j: number) => (j === row.length - 1 ? c : columns >= 2 ? c.padEnd(cellWidth) : `${c}   `);
            rows.push([...label, ...row.map((c, j) => t(c.startsWith('+') ? 'dim' : 'muted', cell(c, j)))]);
          });
        }
        return rows;
      };
      const count = (list: Array<{ ids: string[] }>) => list.reduce((n, a) => n + a.ids.length, 0);
      // The demo's briefings are one saved day, and it reads no metric: its words name neither.
      const body: Line[] = [...areas(entry.saved ? `briefings saved on ${entry.saved}` : 'briefings, as they stand now or on a past day you name', entry.briefings), ...(entry.metrics ? [[], ...areas('metrics, as they stand now', entry.metrics, true)] : []), ...(entry.metrics && !entry.all && entry.metrics.some((a) => a.ids.length > IDS_SHOWN) ? [[t('dim', '  /catalog all names every metric')] as Line] : [])];
      const subtitle = entry.metrics ? `${count(entry.briefings)} briefings and ${count(entry.metrics)} metrics this key reads` : `${count(entry.briefings)} briefings`;
      const example = `Name one in a question, such as ${entry.metrics ? 'macro.snapshot or treasury-10y' : 'macro.snapshot'}${entry.saved ? '' : ', or add a day, such as "as of 2026-08-15"'}.`;
      return [...ask, ...titled(state, t, 'Catalog', subtitle), ...closed(state, t, body, example)];
    }
    case 'digest':
      return digestLines(state, t, entry.view, true);
    case 'check': {
      const r = entry.result;
      const body = [...fitnessLines(r).flatMap((l) => checkLines(state, t, l)), [], ...wrapIn(t, r.verdict === 'not fit' ? 'fg' : 'bright', verdictLine(r), room)];
      return [...ask, ...titled(state, t, 'Model check', r.model), ...closed(state, t, body, "Kept in the journal with today's date.")];
    }
    case 'positions':
      return [...ask, ...titled(state, t, 'Positions', 'paper holdings and every order intent'), ...closed(state, t, positionsLines(t, entry.view, room), POSITIONS_FOOT)];
    case 'connections': {
      // Each connection on one row where the width allows, and its words under its name
      // where it does not.
      const wide = room >= 70;
      const row = (on: boolean, name: string, what: string, status: string): Line[] =>
        wide && what.length <= 41 && 2 + 19 + 41 + status.length <= room
          ? [[t(on ? 'accent' : 'dim', on ? '● ' : '○ ', on ? '* ' : '. '), t('fg', name.padEnd(19)), t('muted', what.padEnd(41)), t(on ? 'bright' : 'dim', status)]]
          : [
              [t(on ? 'accent' : 'dim', on ? '● ' : '○ ', on ? '* ' : '. '), t('fg', name.padEnd(Math.max(name.length + 2, 19))), t(on ? 'bright' : 'dim', status)],
              ...wrapWords(what, room - 2).map((l): Line => [t('muted', `  ${l}`)]),
            ];
      const alpacaOn = entry.alpaca !== 'off' && entry.alpaca !== 'unusable';
      const alpacaWhat = entry.alpaca === 'unusable' ? 'its mode in config.yaml is not usable' : 'paper trading, practice money';
      // Robinhood's own server, where primerkit connect robinhood added it to an AI app.
      const robinhoodOn = Boolean(entry.robinhood?.hosts.length);
      const appName = (h: string) => ({ 'claude-code': 'Claude Code', codex: 'Codex' })[h] ?? h;
      const robinhoodStatus = `added to ${(entry.robinhood?.hosts ?? []).map(appName).join(', ')}${entry.robinhood?.approvals ? '' : ', approvals not confirmed'}`;
      const body: Line[] = [
        [t('dim', 'data')],
        ...row(entry.prereason.on, 'PreReason', entry.prereason.saved ? `briefings saved on ${entry.prereason.saved}, no key` : entry.prereason.on ? `${entry.prereason.tier ?? 'a'} key, briefings and metrics` : 'not connected: /connect prereason', entry.prereason.on ? 'on' : 'off'),
        [],
        ...wrapIn(t, 'dim', 'brokers, through their official connections only', room),
        ...row(alpacaOn, 'Alpaca', alpacaWhat, alpacaOn ? entry.alpaca.replace('_', ' ') : 'off'),
        ...row(robinhoodOn, 'Robinhood', 'live agent account, real money', robinhoodOn ? robinhoodStatus : 'off'),
        ...row(false, 'Robinhood crypto', 'crypto trading API, US only, no paper', 'not yet'),
        [],
        ...wrapIn(t, 'muted', 'A broker runs in one mode. read: holdings only. dry run: orders are built and shown, never sent. paper: sent to a practice account, each on your yes.', room),
      ];
      return [...ask, ...titled(state, t, 'Connections', 'a broker starts off, and you turn it on'), ...closed(state, t, body, 'Keys stay in your system keychain. Holdings never go to PreReason.')];
    }
    case 'bench': {
      const credit = `fixtures from PreReason · ${entry.result.briefings.length} briefings · ${entry.result.fixtures}`;
      return [
        ...ask,
        ...titled(state, t, 'Benchmark', `${entry.result.model} on the frozen fixtures of ${entry.result.fixtures}`),
        ...block(t, benchBody(t, entry.result, entry.stopped, room), [...prMarkLead(t), t('dim', Array.from(credit).length + 5 <= room ? credit : entry.result.fixtures)]),
      ];
    }
    case 'failed': {
      const message = wrapIn(t, 'bright', entry.message, room - 2).map((l, i): Line => [t('accent', i ? '  ' : '✗ ', i ? '  ' : 'x '), ...l]);
      const detail = entry.detail ? wrapIn(t, 'muted', entry.detail, room) : [];
      const closing = detail.pop() ?? [t('muted', 'Nothing from this run is shown.')];
      return [...ask, ...block(t, [...message, ...detail], closing)];
    }
    case 'note': {
      const lines = wrapIn(t, 'muted', entry.text, room);
      const closing = lines.pop() ?? [];
      return [...ask, ...block(t, lines, closing)];
    }
    case 'routine': {
      // What it reads, each source on one row where the width allows and its words under
      // its name where it does not; then its fields, each wrapped under its own text.
      const p = entry.page;
      const wide = room >= 64;
      const body: Line[] = entry.made ? [...wrapIn(t, 'bright', entry.made, room), []] : [];
      body.push([t('dim', 'reads, every run')]);
      for (const r of p.reads) {
        // Five columns either way: the tile and a space, or the plain letters and three.
        const mark: Line = r.mark === 'pr' ? [prTile(t), t('fg', ' ', '   ')] : [t('accent', '>'), t('fg', '    ')];
        if (wide) body.push(...wrapWords(r.what, room - 23).map((l, i): Line => (i ? [t('muted', `${' '.repeat(23)}${l}`)] : [...mark, t('fg', r.name.padEnd(18)), t('muted', l)])));
        else body.push([...mark, t('fg', r.name)], ...wrapWords(r.what, room - 5).map((l): Line => [t('muted', `     ${l}`)]));
      }
      body.push([]);
      for (const f of p.fields) body.push(...fieldLines(t, f.label, f.text, 8, room));
      return [...ask, ...titled(state, t, p.name, p.about), ...closed(state, t, body, 'The model only ever picks a label. What each label holds is yours.')];
    }
    case 'rules': {
      const p = entry.page;
      const body: Line[] = [
        ...wrapIn(t, 'muted', 'primerkit wraps your rules in its primer: what the data is, how to cite a line, and the one label to return. The rules are yours alone; primerkit ships none.', room),
        [],
        ...fieldLines(t, 'your file', rulesFileLine(p), 12, room),
        ...fieldLines(t, 'last edit', p.edited ? `${shortTime(p.edited)}; each run records the file it read` : 'the file is not there yet', 12, room),
        ...fieldLines(t, 'tests', p.tests ?? `none run yet: /routine ${p.routine} test runs them`, 12, room),
      ];
      return [...ask, ...titled(state, t, 'Rules', `${p.path}, outside primerkit, in your own editor`), ...closed(state, t, body, 'With no rules written, the routine returns no_rules_defined and stops.')];
    }
    case 'routine-test': {
      // Each test on its row: its day, then its words, wrapped under their own start.
      const body: Line[] = entry.rows.flatMap((r) => wrapWords(r.text, room - 12).map((w, i): Line => (i ? [t('fg', `${' '.repeat(12)}${w}`)] : [t('dim', r.day.padEnd(12)), t('fg', w)])));
      body.push([], ...wrapWords(entry.summary, room - 3, '   ').map((l, i): Line => (i ? [t('bright', l)] : [t(entry.passed ? 'accent' : 'accentBold', entry.passed ? '✓ ' : '✗ ', entry.passed ? 'ok ' : 'x '), t('bright', l)])));
      return [
        ...ask,
        ...titled(state, t, 'Logic tests', `${entry.routine} on ${entry.model}`),
        ...closed(state, t, body, 'This tests how your model applies your rules, not the market. Every run is in /journal.'),
      ];
    }
    case 'hypothesis': {
      // Each field in the person's words under its name, then the form check's statuses.
      const p = entry.page;
      const body: Line[] = p.made ? [...wrapIn(t, 'bright', p.made, room), []] : [];
      for (const f of p.fields) {
        body.push(...wrapWords(f.text ?? 'not written yet', room - 12).map((l, i): Line => [t('dim', i ? ''.padEnd(12) : f.field.padEnd(12)), t(f.text ? 'fg' : 'dim', l)]));
        if (f.field === 'signature' && f.text) body.push(...wrapIn(t, 'dim', SIGNATURE_HINT, room - 12, '').map((l): Line => [t('dim', ''.padEnd(12)), ...l]));
      }
      body.push([], ...bothWays(t, 'muted', `Form check: ${p.form.join(' · ')}`, room, '  '));
      if (p.kept) body.push(...wrapIn(t, 'muted', p.kept, room));
      return [...ask, ...titled(state, t, 'Hypothesis', `${p.routine}, ${p.state}`), ...closed(state, t, body, RESEARCH_CLOSING)];
    }
    case 'research': {
      // Each hurdle on its row, its words wrapped under their own column where the width
      // allows and under its name where it does not; then where the ladder stopped.
      const p = entry.page;
      const wide = room >= 64;
      const body: Line[] = [];
      for (const r of p.rows) {
        const role = r.status === 'passed' ? 'accent' : r.status === 'failed' ? 'accentBold' : 'bright';
        const head = `${r.id} ${r.name}`;
        if (wide) body.push(...wrapWords(r.text, room - 30).map((l, i): Line => (i ? [t('fg', `${''.padEnd(30)}${l}`)] : [t('fg', head.padEnd(21)), t(role, r.status.padEnd(9)), t('fg', l)])));
        else body.push([t('fg', `${head}  `), t(role, r.status)], ...wrapWords(r.text, room - 3).map((l): Line => [t('fg', `   ${l}`)]));
      }
      // Where the ladder ended and which run it is, in one paragraph.
      body.push([], ...wrapIn(t, 'bright', endWords(p), room), ...wrapIn(t, 'muted', p.trials, room), ...wrapIn(t, 'dim', p.also, room));
      return [...ask, ...titled(state, t, 'Research', p.subtitle), ...closed(state, t, body, RESEARCH_CLOSING)];
    }
    case 'registry': {
      // Each version on its row by the routine's name, its status beside it where the width
      // allows and under it where it does not.
      const p = entry.page;
      const lead = Math.max(0, ...p.rows.map((r) => r.routine.length)) + 2;
      const wide = room - lead - 5 >= 36;
      const body: Line[] = p.empty ? wrapIn(t, 'muted', p.empty, room) : [];
      for (const r of p.rows) {
        const words = `${r.status}${r.forward ? ` · ${r.forward}` : ''}${r.note ? `   ${r.note}` : ''}`;
        // A version's later runs under its status, never as it: each with its own result where
        // the width allows, and their count alone where it does not.
        if (wide) {
          body.push(...bothWays(t, 'fg', words, room - lead - 5).map((l, i): Line => [t('fg', i ? ''.padEnd(lead + 5) : r.routine.padEnd(lead)), t('dim', i ? '' : r.version.padEnd(5)), ...l]));
          if (r.next) body.push(...bothWays(t, 'muted', r.next, room - lead - 5).map((l): Line => [t('fg', ''.padEnd(lead + 5)), ...l]));
          if (r.later) body.push(...bothWays(t, 'muted', r.later, room - lead - 5).map((l): Line => [t('fg', ''.padEnd(lead + 5)), ...l]));
          for (const run of r.later ? r.runs : []) body.push(...bothWays(t, 'muted', run, room - lead - 7).map((l): Line => [t('fg', ''.padEnd(lead + 7)), ...l]));
        } else {
          body.push([t('fg', `${r.routine}  `), t('dim', r.version)], ...bothWays(t, 'fg', words, room - 3).map((l): Line => [t('fg', '   '), ...l]));
          if (r.next) body.push(...bothWays(t, 'muted', r.next, room - 3).map((l): Line => [t('fg', '   '), ...l]));
          if (r.later) body.push(...bothWays(t, 'muted', r.later, room - 3).map((l): Line => [t('fg', '   '), ...l]));
        }
      }
      for (const d of p.damaged) body.push(...wrapIn(t, 'muted', d, room));
      if (p.frozen) body.push(...wrapIn(t, 'muted', p.frozen, room));
      body.push(...wrapIn(t, 'muted', p.footer, room));
      return [...ask, ...titled(state, t, 'Registry', p.subtitle), ...closed(state, t, body, RESEARCH_CLOSING)];
    }
    case 'compare':
      return compareLines(state, t, entry.question, entry.result);
  }
}

// What can be done next under an answer: open the lines it read as a board, ask the same
// question beside a web search, and find the run in the journal, by their codes.
function nextLines(state: State, t: Maker, briefings: string[], room: number): Line[] {
  const brief = briefings.find((b) => b.includes('.'));
  const parts = [...(brief ? [`BR /brief ${brief}`] : []), 'CP /compare', ...(state.demo ? [] : ['JR /journal'])];
  return bothWays(t, 'dim', `next: ${parts.join(' · ')}`, room - 2, '      ').map((l, i): Line => [t('dim', i ? '  ' : '→ ', i ? '  ' : '> '), ...l]);
}

// Text with the · separator wrapped once, and drawn as | in plain text: the two take one
// column each, so the lines break in the same places.
function bothWays(t: Maker, role: string, text: string, width: number, indent = ''): Line[] {
  const plain = wrapWords(text.replaceAll(' · ', ' | '), width, indent);
  return wrapWords(text, width, indent).map((l, i): Line => [t(role, l, plain[i] ?? l.replaceAll('·', '|'))]);
}

// A field of a routine's page: its label, then its text wrapped under its own start.
function fieldLines(t: Maker, label: string, text: string, pad: number, room: number): Line[] {
  return wrapWords(text, room - pad).map((l, i): Line => (i ? [t('fg', `${' '.repeat(pad)}${l}`)] : [t('dim', label.padEnd(pad)), t('fg', l)]));
}

// ------------------------------------------------------------------ the compare view

// The two columns stand beside each other where each holds 33 columns of text or more, and
// one over the other in a narrower window.
const COMPARE_WIDE = 72;

// The question as asked, its later lines under its first word.
const askedLines = (state: State, t: Maker, question: string): Line[] => wrapWords(question, W(state) - 3).map((l, i): Line => (i === 0 ? askLine(t, l) : [t('bright', `   ${l}`)]));

function compareScreen(state: State, t: Maker): Line[] {
  const step = state.step;
  if (step.name !== 'compare') return [];
  const lines = [top(state, t), []];
  if (step.phase === 'done' && step.result) {
    const { body, keyLines, room } = compareRoom(state, t, step.question, step.result);
    const first = Math.min(step.top, Math.max(0, body.length - room));
    return fill(state, [...lines, ...body.slice(first, first + room), [], ...keyLines]);
  }
  const ask = askedLines(state, t, `/compare ${step.question}`);
  const title = titled(state, t, COMPARE_TITLE.title, COMPARE_TITLE.subtitle);
  // The cost line, then the keys: nothing runs before Enter.
  if (step.phase === 'confirm' && step.plan) {
    const cost = wrapWords(compareCost(step.plan), W(state) - 1).map((l): Line => [t('fg', ` ${l}`)]);
    return fill(state, [...lines, ...ask, [], ...title, ...cost, ...keys(state, t, 'Enter runs it · Esc goes back', 'Enter runs it | Esc goes back')]);
  }
  if (step.phase === 'running' && step.progress) {
    const p = step.progress;
    const row = (text: string, done: boolean): Line[] => wrapWords(text, inside(state) - 2).map((l, i): Line => (i ? [t('muted', `  ${l}`)] : [done ? t('muted', '●', 'o') : spin(t, state.frame), t('muted', ` ${l}`)]));
    return fill(state, [...lines, ...ask, [], ...title, ...closed(state, t, [...row(p.briefings, p.done.briefings), ...row(p.web, p.done.web)], 'Ctrl+C stops both, and nothing from this compare is kept', 'dim')]);
  }
  return fill(state, [...lines, ...ask, [], ...title, ...spinning(state, t, 'planning the run: what it reads and what it spends'), [], help(t, 'Esc goes back')]);
}

// A finished compare as its screen scrolls it: the window's rows less the top line, its
// blank, a blank over the keys, the keys and a blank last row.
function compareRoom(state: State, t: Maker, question: string, result: CompareResult): { body: Line[]; keyLines: Line[]; room: number } {
  const body = compareLines(state, t, `/compare ${question}`, result);
  const keysFor = (scroll: boolean): Line[] => (scroll ? keys(state, t, '↑ ↓ to scroll · Esc goes back', 'up and down to scroll | Esc goes back') : [help(t, 'Esc goes back')]);
  const room = Math.max(3, state.size.height - 4 - keysFor(true).length);
  return { body, keyLines: keysFor(body.length > room), room };
}

interface Column {
  answer: Line[];
  detail: Line[]; // what the side read and spent
  closing: Line;
}

// A line of parts, such as "3 searches · 4 pages · 9.1 s", broken only between its parts, as
// the keys are; a part wider than the room wraps on its own.
function inParts(t: Maker, role: string, text: string, room: number): Line[] {
  const out: string[] = [];
  let line = '';
  for (const part of text.split(' · ')) {
    const next = line ? `${line} · ${part}` : part;
    if (textWidth(next) <= room) {
      line = next;
      continue;
    }
    if (line) out.push(line);
    const pieces = wrapWords(part, room);
    out.push(...pieces.slice(0, -1));
    line = pieces.at(-1) ?? '';
  }
  if (line) out.push(line);
  return out.map((l): Line => [t(role, l)]);
}

// The two answers, each with what it read, its cost and its time, under one heading each,
// and the footer under both. primerkit says which is which, and nothing more.
export function compareLines(state: State, t: Maker, question: string, r: CompareResult): Line[] {
  const width = W(state);
  // A journal that could not be written says so, and where, over the footer.
  const unkept = r.journalError ? [...wrapWords(r.journalError, width - 1).map((l): Line => [t('dim', ` ${l}`)]), []] : [];
  const footer = [...unkept, ...wrapWords(COMPARE_FOOTER, width - 1).map((l): Line => [t('muted', ` ${l}`)])];
  const wide = width >= COMPARE_WIDE;
  // Beside each other: a lead space, two columns of one width, and a space between them.
  const col = wide ? Math.floor((width - 2) / 2) : width - 1;
  const room = col - 2;
  const left = briefingColumn(t, r, room);
  const right = webColumn(t, r, room);
  const [one, two] = COMPARE_HEADINGS;
  const ask = askedLines(state, t, question);
  if (!wide) {
    return [...ask, [], [t('bright', ` ${one}`)], ...block(t, [...left.answer, [], ...left.detail], left.closing), [], [t('bright', ` ${two}`)], ...block(t, [...right.answer, [], ...right.detail], right.closing), [], ...footer];
  }
  // Each side's answer first, then what it read and spent, the parts level across, so the
  // lines that say what each read stand side by side, and both close on one row.
  const level = (lines: Line[], n: number): Line[] => [...lines, ...Array.from({ length: n - lines.length }, (): Line => [])];
  const answers = Math.max(left.answer.length, right.answer.length);
  const details = Math.max(left.detail.length, right.detail.length);
  const column = (side: Column): Line[] => [
    ...[...level(side.answer, answers), [], ...level(side.detail, details)].map((l): Line => (l.length ? [t('rule', '│ '), ...l] : [t('rule', '│')])),
    side.closing.length ? [t('rule', '└ '), ...side.closing] : [t('rule', '└')],
  ];
  const a = column(left);
  const b = column(right);
  const rows = a.map((l, i): Line => [t('fg', ' '), ...l, t('fg', ' '.repeat(Math.max(1, col + 1 - widthOf(l)))), ...(b[i] ?? [])]);
  return [...ask, [], [t('bright', ` ${one.padEnd(col + 1)}${two}`)], ...rows, [], ...footer];
}

// The briefing side as an answer is drawn today, in a column: the answer and the lines it
// cites, then the figures line, what it read and what it spent, and PreReason's credit.
function briefingColumn(t: Maker, r: CompareResult, room: number): Column {
  const b = r.briefings;
  const spent = inParts(t, 'muted', briefingSpent(b.spent), room);
  if (b.kind === 'failed') {
    const message = wrapIn(t, 'bright', b.message, room - 2).map((l, i): Line => [t('accent', i ? '  ' : '✗ ', i ? '  ' : 'x '), ...l]);
    return { answer: [...message, ...(b.detail ? wrapIn(t, 'muted', b.detail, room) : [])], detail: [...wrapIn(t, 'muted', `read: ${r.read.join(', ')}`, room), ...spent], closing: creditIn(t, room, r.read, '', null) };
  }
  const v = b.view;
  const answer: Line[] = [];
  if (v.partial) {
    // In the words the answer screen uses.
    const n = v.dropped.length;
    const claims = v.dropped.filter((d) => !d.background).length;
    const what = [claims ? (claims === 1 ? 'one claim' : `${claims} claims`) : '', n - claims ? (n - claims === 1 ? 'one background sentence' : `${n - claims} background sentences`) : ''].filter(Boolean).join(' and ') || `${n} claims`;
    answer.push(...wrapWords(`Partial answer: ${what} failed ${n === 1 ? 'its checks and was' : 'their checks and were'} taken out.`, room - 2).map((l, i): Line => [t('accentBold', i ? '  ' : '✗ ', i ? '  ' : 'x '), t('bright', l)]));
  }
  answer.push(...wrap(t, v.sentences.map((s) => withRefs(s.text, s.refs)).join(' '), room));
  if (v.background?.length) answer.push([], ...wrapIn(t, 'muted', `${BACKGROUND_LABEL}: ${v.background.join(' ')}`, room));
  answer.push(...sourceLines(t, v.sources, room));
  const detail: Line[] = [];
  if (b.figures) {
    const f = figuresLine(b.figures);
    const glyph = f.mark === 'held' ? t('accent', '✓ ', 'ok ') : f.mark === 'failed' ? t('accentBold', '✗ ', 'x ') : null;
    if (glyph) detail.push(...wrapWords(f.text, room - 3).map((l, i): Line => (i === 0 ? [glyph, t('muted', l)] : [t('muted', `  ${l}`, `   ${l}`)])));
    else detail.push(...inParts(t, 'muted', f.text, room));
  }
  for (const d of v.dropped) detail.push(...wrapIn(t, 'muted', d.background ? `Taken out of the background: "${d.text}".` : `Not supported by the data: "${d.text}".`, room - 2, '  ').map((l, i): Line => [t('accent', i ? '  ' : '✗ ', i ? '  ' : 'x '), ...l]));
  detail.push(...wrapIn(t, 'muted', `read: ${v.briefings.join(', ')}`, room));
  if (b.skipped.length) detail.push(...wrapIn(t, 'dim', `Not read: ${b.skipped.join(', ')}, not available on this key's tier.`, room));
  for (const note of b.notes) detail.push(...wrapIn(t, 'dim', note, room));
  detail.push(...spent);
  return { answer, detail, closing: creditIn(t, room, v.briefings, timeOf(v.generated), v.asOf) };
}

// The web side: the model's text as it returned it, its own line breaks kept and each line
// wrapped at the column's width, in one colour, with nothing added, taken out or marked;
// then what it read and spent. Nothing on this side is checked, and no mark says it is.
function webColumn(t: Maker, r: CompareResult, room: number): Column {
  const w = r.web;
  const spent = inParts(t, 'muted', webSpent(w.spent), room);
  if (w.kind === 'failed') return { answer: wrapIn(t, 'fg', `The model's web search did not answer: ${w.message.replace(/\.$/, '')}.`, room), detail: spent, closing: [] };
  const answer = w.text.trim().split('\n').flatMap((paragraph): Line[] => (paragraph.trim() ? wrapIn(t, 'fg', paragraph, room) : [[]]));
  const detail = [
    ...inParts(t, 'muted', webStatus(w.cited.length), room),
    ...spent,
    ...(w.pages.length ? wrapIn(t, 'muted', `pages: ${hostsOf(w.pages).join(', ')}`, room) : []),
    ...(w.errors.length ? wrapIn(t, 'muted', `search errors: ${w.errors.join(', ')}`, room) : []),
  ];
  return { answer, detail, closing: [] };
}

// PreReason's credit in the room a column leaves: the names and the time, the names alone,
// their count, or the mark alone.
function creditIn(t: Maker, room: number, read: string[], time: string, asOf: string | null): Line {
  const names = read.join(', ');
  const lines: Line[] = [
    prLine(t, names, time, asOf ? longDay(asOf) : undefined),
    [...prMarkLead(t), t('dim', names)],
    [...prMarkLead(t), t('dim', `${read.length} ${read.some((b) => !b.includes('.')) ? 'sources' : 'briefings'}`)],
  ];
  return lines.find((l) => widthOf(l) <= room) ?? [prTile(t)];
}
