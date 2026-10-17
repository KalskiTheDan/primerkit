import { Journal, JournalRun, RunCancelled, buildPacket, claimFigures, newRunId, tokenCount, withRefs, type AnswerView, type ModelAdapter, type Operation, type RunResult } from '@primerkit/core';
import { dayOfQuestion, daysIn, isMetricId, pickBriefings, type Pickable } from '@primerkit/connector-prereason';
import { WEB_SEARCH_MAX_USES, WebSearchError, priceOf, tokensOf, webSearchTool, type ListPrice, type Usage, type WebAnswer, type WebPage, type WebSearcher } from '@primerkit/models';
import { askBriefings, messageOf, noMatchNote, type AskEngine, type AskProgress } from './engine';

// The compare view: one question answered twice on the person's own model key, once from
// PreReason's briefings exactly as an answer is made today, and once by the same model with
// its web search and no briefings. What it will spend is said before anything runs, from
// the run's plan; afterwards each side says what it read and what it spent. primerkit gives
// no verdict, and the web side's text is shown as the model returned it.

export interface ComparePlan {
  model: string;
  read: string[]; // the briefings and metrics the briefing side reads, one PreReason call each
  preReasonCalls: number;
  tokens: { input: number; output: number };
  searches: number; // the most the web side may run: its tool's max_uses
  usd: number; // both sides' tokens and every search, at list prices
}

// Sizes not known before the run, so estimated: a briefing with no snapshot kept, each side's
// answer with room for the model's thinking, the pages one search adds to what the model
// reads, and the web side's own words around the question. A search was 3,000 until two live
// runs on 2026-10-16 read 9,000 to 13,000 tokens a search, and the plan said about $0.12
// beside $0.22 and $0.19 spent; at 10,000 it says about $0.19 for both.
export const PLAN_SIZES = { block: 2_000, answer: 1_500, search: 10_000, webPrompt: 300 };

export function comparePlan(o: { model: string; price: ListPrice; question: string; read: string[]; operation: Operation; blockTokens: (id: string) => number; searches?: number }): ComparePlan {
  const searches = o.searches ?? WEB_SEARCH_MAX_USES;
  const packet = buildPacket({ operation: o.operation, question: o.question, blocks: [] }).tokens.count;
  const briefings = packet + o.read.reduce((n, id) => n + o.blockTokens(id), 0);
  const web = PLAN_SIZES.webPrompt + tokenCount(o.question) + searches * PLAN_SIZES.search;
  const tokens = { input: briefings + web, output: 2 * PLAN_SIZES.answer };
  const usd = priceOf({ inputTokens: tokens.input, outputTokens: tokens.output }, o.price, searches);
  return { model: o.model, read: o.read, preReasonCalls: o.read.length, tokens, searches, usd };
}

// What the briefing side reads, chosen before the run by the code's word match (a model's
// pick would be a paid call before Enter), so the cost line can count its calls. A question
// that names its briefings reads those. A past day is read from briefings only. On a key
// served a metric's latest reading alone, a question about a change reads the briefing that
// carries the metric, as ask does.
export type Planned = { kind: 'plan'; read: string[] } | { kind: 'note'; text: string };

export function planRead(question: string, today: string, readable: Pickable[], metrics: Pickable[], saved: boolean, latestOnly = false): Planned {
  const asked = dayOfQuestion(question, today, '/chart');
  if (asked.kind === 'refused') return { kind: 'note', text: asked.why };
  if (!readable.length && !metrics.length) return { kind: 'note', text: 'The list of briefings could not be read, so nothing runs. Check the connection and try again.' };
  const words = daysIn(question, today).written.reduce((q, written) => q.split(written).join(' '), question);
  const picked = pickBriefings(words, [...readable, ...metrics], 3, { latestOnly });
  const read = asked.kind === 'day' ? picked.ids.filter((id) => !isMetricId(id)) : picked.ids;
  if (!read.length) return { kind: 'note', text: noMatchNote(words, readable, metrics, '/catalog', 'words', saved) };
  return { kind: 'plan', read };
}

// ------------------------------------------------------------------ the words

const plural = (n: number, one: string, many: string): string => `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`;

// "About 9,000": to the nearest thousand, or hundred below a thousand.
const about = (n: number): string => (n >= 1000 ? Math.round(n / 1000) * 1000 : Math.max(100, Math.round(n / 100) * 100)).toLocaleString('en-US');

export function dollars(usd: number): string {
  if (usd >= 0.0095) return `$${usd.toFixed(2)}`;
  if (usd >= 0.001) return `$${usd.toFixed(3)}`;
  return 'under $0.001';
}

export const COMPARE_TITLE = { title: 'Compare', subtitle: 'two answers to one question' };
export const COMPARE_HEADINGS = ["From PreReason's briefings", "From the model's web search"] as const;
export const COMPARE_FOOTER = 'Two answers, each with what it read. No verdict. Not investment advice.';

// The cost line: everything the run spends, each count from the plan.
export function compareCost(plan: ComparePlan): string {
  return `This asks ${plan.model} twice: once with PreReason's briefings, once with its web search and no briefings. About ${about(plan.tokens.input + plan.tokens.output)} tokens and up to ${plural(plan.searches, 'search', 'searches')} on your model key, about ${dollars(plan.usd)} at list prices, and ${plural(plan.preReasonCalls, 'PreReason call', 'PreReason calls')} on your plan.`;
}

export interface Figures {
  matched: number;
  total: number;
  lines: number; // the briefing lines the answer cites
}

// The briefing side's status line says what the check is: the figures its claims state that
// the lines they cite hold. An answer that states none says so, and makes no mark.
export function figuresLine(f: Figures): { mark: 'held' | 'failed' | null; text: string } {
  if (!f.total) return { mark: null, text: `no figures stated · cites ${plural(f.lines, 'briefing line', 'briefing lines')}` };
  const figures = f.total === 1 ? `${f.matched} of 1 figure matches` : `${f.matched} of ${f.total} figures match`;
  return { mark: f.matched === f.total ? 'held' : 'failed', text: `${figures} the briefing lines cited` };
}

// The web side's status line, in the same form: nothing on it is checked, and no mark. An
// answer with no linked citation may still name its pages in its words, so the line says what
// it lacks, never that it cites none.
export const webStatus = (cited: number): string => `figures not checked · ${cited ? `cites ${plural(cited, 'web page', 'web pages')}` : 'no linked citations'}`;

export interface Spent {
  tokens: number;
  seconds: number;
  usd: number; // at list prices
}
export type WebSpent = Spent & { searches: number; pages: number };

export const briefingSpent = (s: Spent): string => `${plural(s.tokens, 'token', 'tokens')} · ${s.seconds.toFixed(1)} s · ${dollars(s.usd)}`;
export const webSpent = (s: WebSpent): string => `${plural(s.searches, 'search', 'searches')} · ${plural(s.pages, 'page', 'pages')} · ${plural(s.tokens, 'token', 'tokens')} · ${s.seconds.toFixed(1)} s · ${dollars(s.usd)}`;

// The sites of the pages the searches returned, each once, in the order they came.
export function hostsOf(pages: WebPage[]): string[] {
  const host = (url: string): string => {
    try {
      return new URL(url).hostname.replace(/^www\./, '');
    } catch {
      return url;
    }
  };
  return [...new Set(pages.map((p) => host(p.url)))];
}

// What the web side is told besides the question: the day, and the rule the briefing side's
// primer gives, so neither side is asked for advice. It is given no briefing.
export function webSystem(at: Date): string {
  return `Today is ${at.toISOString().slice(0, 10)}. Answer the question with web search, describing conditions as the pages you read state them, and say which page each figure comes from. Add no advice, no forecast and no position.`;
}

// ------------------------------------------------------------------ the run

export type BriefingSide =
  | { kind: 'answer'; view: AnswerView; figures: Figures | null; notes: string[]; skipped: string[]; spent: Spent }
  | { kind: 'failed'; message: string; detail: string | null; spent: Spent };

export type WebSide =
  | { kind: 'answer'; text: string; pages: WebPage[]; cited: WebPage[]; errors: string[]; spent: WebSpent }
  | { kind: 'failed'; message: string; spent: WebSpent };

export interface CompareResult {
  model: string;
  at: string;
  read: string[];
  briefings: BriefingSide;
  web: WebSide;
  journalDir: string | null;
  journalError?: string; // the journal could not be written, and where
}

// The figures the grounded_numbers check tests, counted by that check's own reading of each
// claim, where it ran: the claims shown, and the claims taken out, which the model stated too.
export function figuresOf(result: RunResult): Figures | null {
  if (!result.checks.some((c) => c.id === 'grounded_numbers')) return null;
  const shown = result.response?.claims ?? [];
  const claims = [...shown, ...result.dropped.filter((d) => !d.background).map((d) => d.claim)];
  let matched = 0;
  let total = 0;
  for (const claim of claims) {
    const { figures, missing } = claimFigures(result.packet, claim);
    total += figures.length;
    matched += figures.length - missing.length;
  }
  const lines = new Set(shown.flatMap((c) => c.citations.map((x) => `${x.block} L${x.line}`)));
  return { matched, total, lines: lines.size };
}

// The briefing side's run, held until the compare ends: a stopped compare keeps nothing, and
// a finished one keeps both sides in one folder of the journal.
class HeldRun extends JournalRun {
  constructor(private readonly files: Array<[string, string | object]>) {
    super('');
  }
  override write(name: string, content: string | object): void {
    this.files.push([name, content]);
  }
}
class Held extends Journal {
  readonly files: Array<[string, string | object]> = [];
  constructor() {
    super('');
  }
  override open(): JournalRun {
    return new HeldRun(this.files);
  }
}

// The model with what its calls used added up, so the briefing side can say what it spent.
function metered(model: ModelAdapter): { model: ModelAdapter; usage: Required<Usage>; reported: () => boolean } {
  const usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
  let reported = false;
  return {
    usage,
    reported: () => reported,
    model: {
      id: model.id,
      label: model.label,
      capabilities: () => model.capabilities(),
      complete: async (packet, repair, signal) => {
        const reply = await model.complete(packet, repair, signal);
        if (reply.usage) reported = true;
        for (const k of Object.keys(usage) as Array<keyof typeof usage>) usage[k] += reply.usage?.[k] ?? 0;
        return reply;
      },
    },
  };
}

export interface CompareRun {
  engine: Omit<AskEngine, 'journal' | 'signal' | 'onStatus'>;
  searcher: WebSearcher;
  price: ListPrice;
  question: string;
  plan: ComparePlan;
  journal: Journal | null;
  signal?: AbortSignal;
  onStatus?: (side: 'briefings' | 'web', progress: AskProgress | 'done') => void;
}

// Both sides at once, each timed and metered on its own. A side that fails says so in its
// column; a stop ends both and keeps nothing.
export async function runCompare(c: CompareRun): Promise<CompareResult> {
  const at = c.engine.now?.() ?? new Date();
  const meter = metered(c.engine.model);
  const held = new Held();
  const signal = c.signal ? { signal: c.signal } : {};
  const since = (t0: number): number => (Date.now() - t0) / 1000;

  const briefings = (async (): Promise<BriefingSide> => {
    const t0 = Date.now();
    try {
      const outcome = await askBriefings({ ...c.engine, model: meter.model, journal: held, ...signal, onStatus: (p) => c.onStatus?.('briefings', p) }, c.question, c.plan.read);
      // A model that reports no usage is counted by its packet, at the input price.
      const used: Usage = meter.reported() ? meter.usage : { inputTokens: outcome.kind === 'answer' ? outcome.view.tokens : 0 };
      const spent = { tokens: tokensOf(used), seconds: since(t0), usd: priceOf(used, c.price) };
      if (outcome.kind === 'answer') return { kind: 'answer', view: outcome.view, figures: figuresOf(outcome.result), notes: outcome.notes, skipped: outcome.skipped, spent };
      if (outcome.kind === 'note') return { kind: 'failed', message: outcome.text, detail: null, spent };
      if (outcome.kind === 'failed') return { kind: 'failed', message: outcome.message, detail: outcome.detail, spent };
      // The briefings are named here, so the news door is never read and no window of records comes back.
      return { kind: 'failed', message: 'The briefings were not read.', detail: null, spent };
    } catch (error) {
      if (c.signal?.aborted || error instanceof RunCancelled) throw new RunCancelled();
      return { kind: 'failed', message: messageOf(error), detail: null, spent: { tokens: tokensOf(meter.usage), seconds: since(t0), usd: priceOf(meter.usage, c.price) } };
    } finally {
      c.onStatus?.('briefings', 'done');
    }
  })();

  const web = (async (): Promise<{ side: WebSide; answer: WebAnswer | null }> => {
    const t0 = Date.now();
    // Its tokens and each search at list prices, and the pages its searches returned.
    const spentBy = (a: WebAnswer | null): WebSpent => ({ tokens: a ? tokensOf(a.usage) : 0, seconds: since(t0), usd: a ? priceOf(a.usage, c.price, a.searches) : 0, searches: a?.searches ?? 0, pages: a?.pages.length ?? 0 });
    try {
      const answer = await c.searcher.ask(c.question, { system: webSystem(at), ...signal });
      return { side: { kind: 'answer', text: answer.text, pages: answer.pages, cited: answer.cited, errors: answer.errors, spent: spentBy(answer) }, answer };
    } catch (error) {
      if (c.signal?.aborted) throw new RunCancelled();
      // A side that fails after paid searches spent them: its column and the journal say what.
      const sofar = error instanceof WebSearchError ? error.sofar : null;
      return { side: { kind: 'failed', message: messageOf(error), spent: spentBy(sofar) }, answer: sofar };
    } finally {
      c.onStatus?.('web', 'done');
    }
  })();

  const [b, w] = await Promise.allSettled([briefings, web]);
  if (c.signal?.aborted || b.status === 'rejected' || w.status === 'rejected') throw new RunCancelled();
  const out: CompareResult = { model: c.plan.model, at: at.toISOString(), read: c.plan.read, briefings: b.value, web: w.value.side, journalDir: null };
  if (!c.journal) return out;

  // Both answers, kept on this machine with what each read. Nothing of it goes to PreReason.
  // A journal that cannot be written loses neither answer: the compare is shown, and says
  // where its record was to be kept.
  const runId = newRunId(at);
  try {
    const run = c.journal.open('compare', runId, at);
    for (const [name, content] of held.files) run.write(`briefings.${name}`, content);
    run.write('web.request.json', { model: c.searcher.model, system: webSystem(at), question: c.question, tool: { type: w.value.answer?.tool ?? webSearchTool(c.searcher.model), name: 'web_search', max_uses: c.plan.searches } });
    // What came back and what it used; for a side that failed, as far as it came.
    if (w.value.answer) {
      const a = w.value.answer;
      run.write('web.response.json', { model: a.modelReported ?? null, stop_reason: a.stopReason, turns: a.turns, usage: a.usage, searches: a.searches, content: a.content });
    }
    const answered = [out.briefings.kind, out.web.kind].filter((k) => k === 'answer').length;
    run.write('compare.json', compareRecord(c.question, out));
    run.write('render.md', compareMarkdown(c.question, out));
    run.write('meta.json', { runId, operation: 'compare', model: c.searcher.model, outcome: answered === 2 ? 'two answers' : answered === 1 ? 'one answer' : 'no answer', plan: c.plan });
    return { ...out, journalDir: run.dir };
  } catch (error) {
    return { ...out, journalError: `The journal could not be written at ${c.journal.runDir('compare', runId, at)}: ${messageOf(error).replace(/\.$/, '')}.` };
  }
}

// What the journal keeps of a compare, as data: the question, each side's answer, what each
// read and what each spent.
export function compareRecord(question: string, r: CompareResult): object {
  const b = r.briefings;
  const w = r.web;
  return {
    question,
    model: r.model,
    at: r.at,
    briefings: b.kind === 'answer'
      ? { outcome: b.view.partial ? 'partial' : 'passed', answer: b.view.sentences.map((s) => withRefs(s.text, s.refs)).join(' '), read: b.view.briefings, sources: b.view.sources, figures: b.figures, notes: b.notes, spent: b.spent }
      : { outcome: 'failed', message: b.message, detail: b.detail, read: r.read, spent: b.spent },
    web: w.kind === 'answer'
      ? { outcome: 'answered', text: w.text, pages: w.pages, cited: w.cited, errors: w.errors, spent: w.spent }
      : { outcome: 'failed', message: w.message, spent: w.spent },
  };
}

const markedFigures = (f: Figures): string => {
  const { mark, text } = figuresLine(f);
  return `${mark === 'held' ? '✓ ' : mark === 'failed' ? '✗ ' : ''}${text}`;
};

// The compare as /journal opens it: both answers in full, each with what it read and spent.
export function compareMarkdown(question: string, r: CompareResult): string {
  const b = r.briefings;
  const w = r.web;
  const left = b.kind === 'answer'
    ? [
        b.view.sentences.map((s) => withRefs(s.text, s.refs)).join(' '),
        '',
        b.view.sources.map((s) => `[${s.n}] ${s.block}, line ${s.line}`).join(' · '),
        ...(b.figures ? [markedFigures(b.figures)] : []),
        `read: ${b.view.briefings.join(', ')}`,
        briefingSpent(b.spent),
      ]
    : [`✗ ${b.message}${b.detail ? ` ${b.detail}` : ''}`, `read: ${r.read.join(', ')}`, briefingSpent(b.spent)];
  const right = w.kind === 'answer'
    ? [w.text, '', webStatus(w.cited.length), webSpent(w.spent), `pages: ${w.pages.map((p) => p.url).join(', ')}`]
    : [`The model's web search did not answer: ${w.message.replace(/\.$/, '')}.`, '', webSpent(w.spent)];
  return [`# Compare: ${question}`, '', `Asked of ${r.model} on ${r.at.slice(0, 16).replace('T', ' ')} UTC, twice: once with PreReason's briefings, once with its web search and no briefings.`, '', `## ${COMPARE_HEADINGS[0]}`, '', ...left, '', `## ${COMPARE_HEADINGS[1]}`, '', ...right, '', COMPARE_FOOTER, ''].join('\n');
}

// What each side is doing while it runs, for the running screen.
export function briefingStatus(model: string, p: AskProgress | 'done'): string {
  if (p === 'done') return 'briefings: done';
  const from = p.briefings.join(', ');
  if (p.phase === 'answering') return `briefings: ${model} is answering · ${(p.tokens ?? 0).toLocaleString('en-US')} tokens from ${from}`;
  if (p.phase === 'checking') return 'briefings: checking the answer';
  if (p.phase === 'repairing') return `briefings: ${model} is answering again, after a failed check`;
  return `briefings: reading ${from} from PreReason`;
}

export const webStatusWhileRunning = (model: string, done: boolean): string => (done ? 'web search: done' : `web search: ${model} is searching and answering`);
