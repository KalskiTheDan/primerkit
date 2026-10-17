import {
  COMPANY_FAMILY,
  RunCancelled,
  answerView,
  companyBriefing,
  companyMarket,
  companyOf,
  buildPacket,
  fitPacket,
  longDay,
  parseResponse,
  renderMarkdown,
  runOperation,
  seriesAsked,
  type AnswerView,
  type DataBlock,
  type DataConnector,
  type Journal,
  type ModelAdapter,
  type Operation,
  type Packet,
  type RunResult,
  type Snapshots,
} from '@primerkit/core';
import {
  NEWS_MAX_LIMIT,
  NewsError,
  PreReasonError,
  checkedDay,
  checkedWindow,
  closest,
  companiesNamed,
  dayExample,
  dayOfQuestion,
  daysIn,
  isMetricId,
  newsAsked,
  newsWindow,
  pickBriefings,
  readableBy,
  wordsOf,
  type CatalogEntry,
  type DayBudget,
  type MetricEntry,
  type NewsAnswer,
  type NewsAsked,
  type NewsQuery,
  type NewsWindow,
  type Pickable,
  type PricePoint,
  type SingleMetric,
  type Tier,
  RefusedRequest,
  waitText,
} from '@primerkit/connector-prereason';
import { ExtractiveModel, ModelError, liftable, type Liftable } from '@primerkit/models';
import { newsBlock, newsFailureText, newsMarkdownParts, newsNotes, newsRead, type NewsRead } from './news';

// Asking the briefings, the same way from the session and from `primerkit ask`: pick
// the briefings and metrics, read them, fit the packet to the model, and run the
// operation. A question that names one past day is read as it stood that day.

// Where briefings come from: PreReason, or the demo's saved briefings.
export interface Briefings extends DataConnector {
  budget?: DayBudget | null;
  tier?: Tier | null;
  // Whether PreReason accepted the key on the last call made with it: false after a 401.
  keyAccepted?: boolean | null;
  has?(briefing: string): boolean;
  bitcoinHistory?(range: { from: string; to: string }): Promise<PricePoint[]>;
  metric?(name: string): Promise<SingleMetric>;
  // One metric as numbered lines, as it stands now; absent where no metric can be read.
  metricBlock?(id: string): Promise<DataBlock>;
  // A briefing can be read as it stood on a past day; the demo's one saved day cannot.
  readsDates?: boolean;
  // A company's statement history can be read (PreReason's numbers block with history).
  readsHistory?: boolean;
  // PreReason's news: what a company filed, or what was officially published, over a window.
  // Absent in the demo, whose saved briefings hold no news.
  news?(query: NewsQuery): Promise<NewsAnswer>;
}

export interface AskEngine {
  operation: Operation;
  model: ModelAdapter;
  data: Briefings;
  catalog: () => Promise<CatalogEntry[]>;
  // PreReason's keyless list of metrics; absent where metrics are not offered, as in the demo.
  metrics?: () => Promise<MetricEntry[]>;
  tier: Tier | null;
  snapshots?: Snapshots | null;
  journal?: Journal | null;
  signal?: AbortSignal;
  onStatus?: (progress: AskProgress) => void;
  now?: () => Date;
  // The commands named in notes where this ask runs: what lists every briefing and metric,
  // and what draws a series over a span of days. /catalog and /chart in the session.
  hints?: { catalog: string; chart: string };
}

export interface AskProgress {
  phase: 'choosing' | 'reading' | 'answering' | 'checking' | 'repairing';
  briefings: string[];
  tokens: number | null;
}

export type AskOutcome =
  // standIn: the demo stand in answered, which does not read the question.
  | { kind: 'answer'; result: RunResult; view: AnswerView; skipped: string[]; notes: string[]; added: string[]; news?: NewsRead; standIn?: true }
  | { kind: 'failed'; message: string; detail: string | null }
  | { kind: 'note'; text: string }
  // PreReason's news read, and its window holds no record: nothing for a model to answer from.
  | { kind: 'no-records'; news: NewsRead };

// When to try again, from the wait PreReason names with a rate limit; null where it names none.
export function tryAgainIn(seconds: number | null): string | null {
  return seconds ? `Try again in about ${seconds < 90 ? `${Math.ceil(seconds)} seconds` : `${Math.ceil(seconds / 60)} minutes`}.` : null;
}

// Reads one briefing and keeps it as a snapshot. A briefing read for a past date is the
// briefing as it stood that day, though PreReason generates it now, so it is kept at
// the end of that day: filed under its generated time, it would pass for today's.
export async function readBriefing(engine: Pick<AskEngine, 'data' | 'snapshots'>, briefing: string, format: DataBlock['format'], date?: string): Promise<DataBlock> {
  const block = await engine.data.fetch({ briefing, format, ...(date ? { date } : {}) });
  engine.snapshots?.save(date ? { ...block, generatedAt: `${date}T23:59:59.999Z` } : block);
  return block;
}

// A company's statement history: PreReason's numbers block with its quarters and fiscal
// years, as markdown tables, as it stands today. It is not kept as a snapshot, since the
// snapshots of a briefing id hold the whole briefing.
export async function readHistory(data: Briefings, briefing: string): Promise<DataBlock> {
  const block = await data.fetch({ briefing, format: 'markdown', history: true });
  return { ...block, heading: `Company briefing ${briefing}, its numbers block with statement history (quarters and fiscal years), markdown, as it stands now` };
}

// Whether a question is read with a company's statement history: it names figures over
// several periods, the briefing is a company's, the connection reads history, and no past
// day is asked (history is served as it stands today).
export const readsCompanyHistory = (data: Briefings, id: string, question: string, date: string | null): boolean =>
  !date && Boolean(data.readsHistory) && companyOf(id) !== null && seriesAsked(question);

// One metric as a block the packet names as a metric, read as it stands now.
export async function readMetric(data: Briefings, id: string, name: string): Promise<DataBlock> {
  if (!data.metricBlock) throw new PreReasonError(`${id} is a metric, and metrics cannot be read here`, 400, null);
  const block = await data.metricBlock(id);
  return { ...block, heading: `Metric ${id} (${name}), ${block.format}, as it stands now` };
}

// Who chose what was read, kept with the run: the person by naming ids, the model in the
// pick step, the word match, or the AI app's model.
export type PickedBy = 'named' | 'model' | 'word match' | 'host';

// The note when nothing matched: the few nearest by the same words, and where the whole
// list is, in place of every id the key reads. Saved briefings, as in the demo, are named
// as saved: no key reads them.
export function noMatchNote(question: string, briefings: Pickable[], metrics: Pickable[], hint: string, by: 'words' | 'model' = 'words', saved = false): string {
  const what = metrics.length ? 'No briefing or metric' : 'No briefing';
  const all = saved ? `the ${briefings.length} saved briefings` : metrics.length ? `the ${briefings.length} briefings and ${metrics.length} metrics this key reads` : `the ${briefings.length} briefings this key reads`;
  const near = closest(question, [...briefings, ...metrics]);
  if (by === 'model') return `The model found nothing among ${all} that answers this question, so nothing was read.${near.length ? ` Nearest by its words: ${near.join(', ')}.` : ''} Name one in the question to read it anyway; ${hint} lists them.`;
  if (near.length) return `${what} matched the words of this question. Nearest: ${near.join(', ')}. Name one in the question, such as ${near[0]}; ${hint} lists ${all}.`;
  return `${what} matched the words of this question. Name one in it, such as ${briefings[0]?.id ?? metrics[0]?.id}; ${hint} lists ${all}.`;
}

// The tier a company's briefing needs, by the market its code names: a USA company's at the
// company family's tier in the catalog, Basic; a Japanese, Korean or Indian company's at Pro
// and above, as PreReason's llms.txt says ("Live for the USA on Basic and above, for Japan,
// Korea and India on Pro and above"). A code whose shape does not say its market gets both:
// "a Basic key or above" alone is untrue outside the USA.
const tierName = (tier: string): string => `${tier.slice(0, 1).toUpperCase()}${tier.slice(1)}`;

export function companyTierNote(companies: string[], familyTier: Tier, tier: Tier | null, readable: Pickable[]): string {
  const markets = new Set(companies.map((id) => companyMarket(companyOf(id) ?? '')));
  const usa = `A USA company's briefing needs a ${tierName(familyTier)} key or above`;
  const need =
    markets.size === 1 && markets.has('usa')
      ? `${usa}.`
      : markets.size === 1 && markets.has('india')
        ? "A Japanese, Korean or Indian company's briefing needs a Pro key or above."
        : `${usa}; a Japanese, Korean or Indian company's needs a Pro key.`;
  return `${need} ${tier ? `Your ${tierName(tier)} key reads` : 'Read as a Free key until PreReason names its tier, this key reads'}: ${readable.map((b) => b.id).join(', ')}.`;
}

// Words that refer to a day without naming it. Code never turns them into a day; with a
// local model they only add the hint to name the day.
const RELATIVE = /\b(yesterday|ago|last (?:week|month|year|monday|tuesday|wednesday|thursday|friday|saturday|sunday)|previous (?:week|month|day))\b/i;

export async function askBriefings(engine: AskEngine, question: string, named: string[] | null): Promise<AskOutcome> {
  const failed = (message: string, detail: string | null = null): AskOutcome => ({ kind: 'failed', message, detail });
  const status = (phase: AskProgress['phase'], briefings: string[], tokens: number | null = null) => engine.onStatus?.({ phase, briefings, tokens });
  const stopped = () => {
    if (engine.signal?.aborted) throw new RunCancelled();
  };
  const today = (engine.now?.() ?? new Date()).toISOString().slice(0, 10);
  let phase: AskProgress['phase'] = 'choosing';
  try {
    // The day: the one the question names comes first.
    const hints = engine.hints ?? { catalog: '/catalog', chart: '/chart' };
    const asked = dayOfQuestion(question, today, hints.chart);
    // A question that asks what was filed or published, and when, may read PreReason's news,
    // whose records name a span of days where a briefing reads one day: its days are refused
    // only once it reads briefings. A span longer than the news door reads is refused before
    // any call. Ids the person names are read as named, never as news.
    const shaped = named ? null : newsAsked(question);
    if (asked.kind === 'refused' && !shaped) return { kind: 'note', text: asked.why };
    if (shaped) {
      const window = newsWindow(question, today);
      if (window.kind === 'refused') return { kind: 'note', text: window.why };
    }
    const news = (pick: NewsPick, by: PickedBy) => askNews(engine, question, pick, today, by, { status, stopped, phase: (p) => (phase = p) });
    let date = asked.kind === 'day' ? asked.day : null;
    let dateFrom: 'question' | 'model' | null = date ? 'question' : null;
    const notes: string[] = [];
    // A period's dates: read as things stand now, and the model names no day in their place.
    if (asked.kind === 'period') notes.push(`Read as it stands now: ${asked.days.length === 1 ? `${longDay(asked.days[0]!)} ends the period the question asks about` : `${asked.days.map(longDay).join(' and ')} bound the period the question asks about`}, and a period's figures come out after it ends. To read the briefings as they stood on a day, write as of ${asked.days.at(-1)}.`);

    const caps = await engine.model.capabilities();
    // The demo stand in reads no question, and the demo's saved briefings hold no company: a
    // company question is told what a key would read, and gets no answer. A filing question
    // goes to the news door, which says the demo holds no news.
    const standIn = engine.model instanceof DemoStandIn ? engine.model : null;
    const saved = async () => readableBy(await engine.catalog(), engine.tier ?? 'free').filter((b) => engine.data.has?.(b.id) ?? true).map((b) => b.id);
    if (standIn && !shaped && companyAsked(question, named)) return { kind: 'note', text: demoNote('company', await saved()) };
    let ids = named;
    let by: PickedBy = 'named';
    let added: string[] = [];
    const names = new Map<string, string>();
    if (!ids) {
      // A question that names its company and asks what it filed reads the news door alone.
      if (shaped?.company) return news(shaped, 'named');
      status('choosing', []);
      // A question shaped like news still reads a briefing or metric it names by its id, so the
      // list is read first; where it cannot be read, the news door is read as before.
      const listed = shaped ? await engine.catalog().catch(() => []) : await engine.catalog();
      const readable = readableBy(listed, engine.tier ?? 'free').filter((b) => engine.data.has?.(b.id) ?? true);
      let metrics: MetricEntry[] = [];
      // A company named by its code that this key's tier does not read: said before any call.
      // On a free key, "equities.company/aapl" was dropped without a word, and the words of
      // the question then read a Treasury flows metric. The family's tier is the catalog's,
      // read again only here, where the session and the CLI keep it. The demo's saved
      // briefings say their own words.
      const companies = companiesNamed(question).map((c) => c.id);
      const family = companies.length && !readable.some((b) => b.id === COMPANY_FAMILY) ? (await engine.catalog()).find((b) => b.id === COMPANY_FAMILY) : undefined;
      if (engine.data.readsDates && family) return { kind: 'note', text: companyTierNote(companies, family.tier, engine.tier, readable) };
      if (engine.metrics && engine.data.metricBlock) {
        try {
          metrics = await engine.metrics();
        } catch {
          notes.push('The list of metrics could not be read, so only briefings were chosen from.');
        }
      }
      for (const m of metrics) names.set(m.id, m.name);
      if (!readable.length && !metrics.length) return shaped ? news(shaped, 'word match') : failed('The list of briefings could not be read.', 'Check the connection, or name a briefing in the question, such as btc.pulse.');
      const pickable: Pickable[] = [...readable, ...metrics];
      // The words of a date are no words of the subject: "Aug 15, 2026" picks nothing.
      const words = daysIn(question, today).written.reduce((q, written) => q.split(written).join(' '), question);
      // A free key is served a metric read on its own as its latest reading alone.
      const picked = pickBriefings(words, pickable, 3, { latestOnly: (engine.tier ?? 'free') === 'free' });
      if (picked.named.length || caps.local) {
        // Where code picks, a question that asks what was filed or published reads the news
        // door alone, unless it names an id: "macro.rates: how did yields move after the Fed
        // announced the cut?" once read the news door, and macro.rates was never read.
        if (shaped && !picked.named.length) return news(shaped, 'word match');
        if (asked.kind === 'refused') return { kind: 'note', text: asked.why };
        ids = picked.ids;
        by = picked.named.length ? 'named' : 'word match';
        // A fact read from its own series: the briefing that holds what drives it is named.
        if (picked.drivers) notes.push(`Read from ${picked.ids.join(' and ')} alone. For what drives ${picked.ids.length === 1 ? 'it' : 'them'} and how ${picked.ids.length === 1 ? 'it connects' : 'they connect'}, name ${picked.drivers} in the question.`);
        for (const c of picked.carried ?? []) notes.push(`${c.metric} was read in ${c.briefing}, which carries its changes: on a Free key, a metric read on its own is its latest reading alone.`);
      } else {
        const chosen = await pickWithModel(engine.model, question, pickable, today, engine.signal);
        // The model chose the news door: it reads nothing else. Where its pick could not be
        // read, code picks instead, and for a question that asks what was filed, that is news.
        if (chosen?.news) return news(chosen.news, 'model');
        if (!chosen && shaped) return news(shaped, 'word match');
        if (asked.kind === 'refused') return { kind: 'note', text: asked.why };
        // The model found nothing that fits: nothing is read, and the code's weaker word match
        // is not read in its place.
        if (chosen && !chosen.ids.length) return { kind: 'note', text: noMatchNote(words, readable, metrics, hints.catalog, 'model', !engine.data.readsDates) };
        ids = chosen?.ids ?? picked.ids;
        by = chosen ? 'model' : 'word match';
        // The model's day, held to the same rules; one that fails them is dropped. Only a
        // question that names no day of its own, nor a period, takes one.
        if (asked.kind === 'none' && chosen?.date) {
          const day = checkedDay(chosen.date, today);
          if (day.kind === 'day') {
            date = day.day;
            dateFrom = 'model';
          }
        }
      }
      added = picked.added;
      if (!ids.length) return { kind: 'note', text: `${noMatchNote(words, readable, metrics, hints.catalog, 'words', !engine.data.readsDates)}${standIn ? ` ${DEMO_WITH_A_KEY}` : ''}` };
    }
    if (dateFrom === 'model' && date) notes.push(`Read as it stood on ${longDay(date)}, the day the model took the question to ask about. To choose the day, name it, such as as of ${date}.`);
    if (!date && RELATIVE.test(question)) notes.push(`Read as it stands now: a past day is read when the question names it, such as as of ${dayExample(today)}.`);

    // A past day: the briefings only, and only where they can be read for one.
    const briefingIds = ids.filter((id) => !isMetricId(id));
    const metricIds = ids.filter(isMetricId);
    if (date) {
      if (!engine.data.readsDates) return { kind: 'note', text: `These briefings are one saved day, so ${longDay(date)} cannot be read here. With a key, primerkit reads a briefing as it stood on a past day.` };
      if (!briefingIds.length) return { kind: 'note', text: `${metricIds.join(', ')} ${metricIds.length === 1 ? 'is a metric' : 'are metrics'}, which PreReason serves as ${metricIds.length === 1 ? 'it stands' : 'they stand'} now only, so nothing was read for ${longDay(date)}. Ask about a briefing for that day, such as macro.snapshot as of ${date}.` };
      for (const id of metricIds) notes.push(`${id} was not read: PreReason serves a metric as it stands now, not as it stood on ${longDay(date)}.`);
      ids = briefingIds;
    }

    phase = 'reading';
    status('reading', ids);
    const blocks: DataBlock[] = [];
    const skipped: string[] = [];
    const history: string[] = [];
    let dateRefused: string | null = null;
    // Company briefings PreReason did not serve for the past day, read as they stand now.
    const readNow: string[] = [];
    for (const id of ids) {
      stopped();
      // Figures over several periods: the company's statement history, where PreReason has
      // it for that company; else its whole briefing, and a note says why.
      if (readsCompanyHistory(engine.data, id, question, date)) {
        const read = await readHistory(engine.data, id).catch((error: unknown) => {
          if (error instanceof PreReasonError && (error.status === 404 || error.status === 400 || error.tierRefusal)) return null;
          throw error;
        });
        if (read) {
          blocks.push(read);
          history.push(id);
          continue;
        }
        notes.push(`${id}: PreReason holds no statement history for this company yet, so its whole briefing was read, which gives its latest period.`);
      }
      try {
        blocks.push(isMetricId(id) ? await readMetric(engine.data, id, names.get(id) ?? id) : await readBriefing(engine, id, caps.format, date ?? undefined));
      } catch (error) {
        if (error instanceof PreReasonError && error.code === 'DATE_RESTRICTED') {
          dateRefused = error.message;
          notes.push(`${id} was not read for ${longDay(date ?? today)}: ${error.message}.`);
        } else if (error instanceof PreReasonError && error.status === 400 && date && companyOf(id)) {
          // PreReason refuses a company's briefing for a past day with a 400: it is read as it
          // stands now, and a note says so.
          blocks.push(await readBriefing(engine, id, caps.format));
          readNow.push(id);
          notes.push(`${id} was read as it stands now: PreReason did not serve it as it stood on ${longDay(date)}.`);
        } else if (error instanceof PreReasonError && error.tierRefusal) skipped.push(id);
        else if (error instanceof PreReasonError && isMetricId(id) && (error.status === 404 || error.status === 503)) notes.push(`${id} was not read: ${error.message}.`);
        else throw error;
      }
    }
    if (!blocks.length) {
      if (dateRefused) return failed(`${ids.join(', ')} could not be read for ${longDay(date ?? today)}.`, `PreReason says: ${dateRefused}.`);
      return failed(`None of ${ids.join(', ')} could be read.`, skipped.length ? "They are not available on this key's tier." : notes.at(-1) ?? null);
    }
    stopped();
    // Where every block was read as it stands now, the answer stands as of now too.
    if (date && readNow.length === blocks.length) date = null;
    const dayOf = (id: string) => (date && !readNow.includes(id) ? date : undefined);

    const operation = date ? datedOperation(engine.operation) : engine.operation;
    const fitted = await fitPacket({ operation, question, blocks, caps, asMarkdown: (b) => readBriefing(engine, b.id, 'markdown', dayOf(b.id)) });
    if (fitted.refused) {
      // Over the operation's own cap, with room in the model's context: the cap is named.
      if (fitted.limit === null || fitted.needed <= fitted.limit) {
        const id = operation.spec.id;
        return failed(`The packet is over the ${id} operation's cap.`, `Even cut down, it is ${fitted.tokens.toLocaleString('en-US')} tokens, and the ${id} operation sends at most ${(fitted.cap ?? 0).toLocaleString('en-US')} tokens a packet.`);
      }
      return failed('The packet does not fit this model.', `Even cut down, it needs ${fitted.needed.toLocaleString('en-US')} tokens of context, and ${engine.model.label} has ${fitted.limit.toLocaleString('en-US')} tokens of context.`);
    }
    // No sentence read holds a word of the question: the demo stand in has nothing to lift, so
    // it gives no answer, and what a key would read is said.
    if (standIn && !standIn.lines(question, fitted.blocks).length) return { kind: 'note', text: demoNote('not held', await saved()) };
    phase = 'answering';
    const read = fitted.blocks.map((b) => b.id);
    const result = await runOperation({
      operation,
      question,
      blocks: fitted.blocks,
      model: engine.model,
      notes: fitted.notes,
      ...(date ? { asOf: date } : {}),
      files: [['pick.json', pickRecord({ read, by, date, dateFrom, added, skipped, notes, history })]],
      ...(engine.journal ? { journal: engine.journal } : {}),
      ...(engine.signal ? { signal: engine.signal } : {}),
      onStatus: (s) => {
        phase = s.phase;
        status(s.phase, read, s.tokens);
      },
    });
    const view = answerView(result);
    if ((result.outcome === 'passed' || result.outcome === 'partial') && view) return { kind: 'answer', result, view, skipped, notes: [...notes, ...fitted.notes], added, ...(standIn ? { standIn: true as const } : {}) };
    if (result.outcome === 'refused') return failed('The packet was not sent to the model.', result.reason ?? null);
    return failed('The answer did not pass its checks, so it is not shown.', result.reason ? `It failed on: ${result.reason}` : null);
  } catch (error) {
    if (error instanceof RunCancelled || engine.signal?.aborted) throw new RunCancelled();
    // primerkit's own refusal of an id, made before anything is sent: PreReason was not asked.
    if (error instanceof RefusedRequest) return failed(`${error.message}.`, null);
    if (error instanceof PreReasonError) return failed(error.message, waitText(error));
    if (phase === 'reading' || phase === 'choosing') {
      if (error instanceof ModelError) return failed(`The model did not answer: ${error.message}.`, null);
      return failed('PreReason could not be reached.', asSentence(messageOf(error)));
    }
    if (error instanceof ModelError) return failed(`The model did not answer: ${error.message}.`, null);
    return failed('The model could not be reached.', `Is it running? ${asSentence(messageOf(error))}`);
  }
}

// An error's own words, said after a sentence of ours, as a sentence of their own: "the
// catalog answered 503" reads "The catalog answered 503." (the request check of 2026-10-15).
function asSentence(text: string): string {
  const said = text.trim();
  if (!said) return said;
  const capital = said.charAt(0).toUpperCase() + said.slice(1);
  return /[.!?]$/.test(capital) ? capital : `${capital}.`;
}

// What reads PreReason's news: whose records (a company's filings, or official records), and
// the window a hosted model gave, if it gave one.
export interface NewsPick extends NewsAsked {
  since?: string;
  until?: string;
}

// The demo stand in: no model. It lifts whole sentences that hold a figure, so they pass
// their checks, and it does not read the question: it lifts the sentences that hold the most
// of the question's words, by the word match that picks the briefings, the briefings' order
// breaking a tie, at most three. It once lifted the first three whatever was asked, so "Is
// the yield curve steepening?" got the Fed's balance sheet, the TGA and net liquidity.
export class DemoStandIn extends ExtractiveModel {
  constructor() {
    super('markdown');
  }

  lines(question: string, blocks: DataBlock[]): Liftable[] {
    const asked = wordsOf(question);
    return liftable(blocks)
      .map((l, order) => ({ l, order, hits: [...wordsOf(l.sentence)].filter((w) => asked.has(w)).length }))
      .filter((x) => x.hits > 0)
      .sort((a, b) => b.hits - a.hits || a.order - b.order)
      .slice(0, 3)
      .map((x) => x.l);
  }

  protected override lift(packet: Packet): Liftable[] {
    return this.lines(packet.question, packet.blocks);
  }
}

// Said where the demo stand in's answer stands, in place of its checks line: its sentences
// pass their checks, but they do not answer the question asked.
export const DEMO_SAMPLE = "Sample answer: the demo's stand in does not read your question. It lifts the sentences that hold its words.";

// A question about a company: one named by its code, or the words of a company's own figures.
// The demo's saved briefings hold no company, so the stand in has nothing to lift for it.
const COMPANY_WORDS = /\bequities\.company\/|\b(?:revenues?|earnings|eps|profits?|net income|operating income|net sales|margins?|guidance|dividends?)\b/i;
export const companyAsked = (question: string, named: string[] | null): boolean => COMPANY_WORDS.test(question) || Boolean(named?.some((id) => companyOf(id)));

// What a key would read, said where the demo stand in gives no answer, with the briefings
// the demo holds. The demo does not know a company's market, so both tiers are named: a USA
// company's briefing is live on Basic and above, a Japanese, Korean or Indian company's on Pro
// and above (PreReason's llms.txt). A company answers only where PreReason covers it, so no
// answer is promised for any company.
export const DEMO_WITH_A_KEY = 'With a key, primerkit chooses from every briefing and metric your key reads.';
export const COMPANY_WITH_A_KEY = "With a key, a covered company's briefing answers this: a USA company on Basic and above; a Japanese, Korean or Indian company on Pro and above.";
// The saved briefings are named with general markets first and crypto last, never Bitcoin first.
const CRYPTO = /^(btc|eth)./;
export function demoNote(kind: 'company' | 'not held', ids: string[]): string {
  const saved = [...ids.filter((id) => !CRYPTO.test(id)), ...ids.filter((id) => CRYPTO.test(id))];
  const held = `The demo holds ${saved.length} saved briefings: ${saved.length > 1 ? `${saved.slice(0, -1).join(', ')} and ${saved.at(-1)}` : saved.join('')}.`;
  if (kind === 'company') return `The demo's saved briefings hold no company data, so the demo's stand in gives no answer. ${COMPANY_WITH_A_KEY} Name the company by its code, such as equities.company/nvda. ${held}`;
  return `No sentence in the demo's saved briefings holds the words of this question, so the demo's stand in gives no answer. ${DEMO_WITH_A_KEY} ${held}`;
}

// Said in the demo, whose saved briefings hold no news, as its other key-only reads say.
export const DEMO_NEWS = "The demo's saved briefings hold no news, so nothing was read. With a key, primerkit reads PreReason's news: what a company filed, and what was officially published, with their dates.";

// A filing question that names no company: PreReason's news reads one company's filings by
// its code, and a name in words never travels in a request.
export const NAME_THE_COMPANY = "PreReason's news reads what one company filed, named by its code, such as equities.company/nvda, so nothing was read. Name the company that way in the question.";

// The window a news read asks for: the question's own span first; else the hosted model's,
// held to the same rules; else the one day the question names (as_of); else none, and
// PreReason reads its own default, the 7 days ending today.
function newsDays(question: string, today: string, pick: NewsPick): NewsWindow {
  const own = newsWindow(question, today);
  if (own.kind === 'span' || own.kind === 'refused') return own;
  if (pick.since && pick.until) {
    const theirs = checkedWindow(pick.since, pick.until, today);
    if (theirs.kind !== 'refused') return theirs;
  } else if (pick.until) {
    const theirs = checkedWindow(pick.until, pick.until, today);
    if (theirs.kind === 'day') return theirs;
  }
  return own;
}

// A question about news: one read of the news door, its records as one block of numbered
// lines, and the ask's own checks on the answer. A window that holds no record is said so,
// with what was read, and no model is asked. News is about its own dates, so nothing here
// reads a briefing as of a past day, and no briefing, metric or price is read beside it.
async function askNews(
  engine: AskEngine,
  question: string,
  pick: NewsPick,
  today: string,
  by: PickedBy,
  at: { status: (phase: AskProgress['phase'], briefings: string[], tokens?: number | null) => void; stopped: () => void; phase: (phase: AskProgress['phase']) => void },
): Promise<AskOutcome> {
  if (!engine.data.news) return { kind: 'note', text: DEMO_NEWS };
  const window = newsDays(question, today, pick);
  if (window.kind === 'refused') return { kind: 'note', text: window.why };
  if (pick.kind === 'filed' && !pick.company) return { kind: 'note', text: NAME_THE_COMPANY };
  const code = pick.kind === 'filed' && pick.company ? companyOf(pick.company) : null;
  const query: NewsQuery = {
    ...(code ? { about: code } : {}),
    kind: pick.kind,
    ...(window.kind === 'span' ? { since: window.since, until: window.until } : window.kind === 'day' ? { asOf: window.asOf } : {}),
    limit: NEWS_MAX_LIMIT,
  };
  at.phase('reading');
  at.status('reading', ['news']);
  let answer: NewsAnswer;
  try {
    answer = await engine.data.news(query);
  } catch (error) {
    if (!(error instanceof NewsError)) throw error;
    const text = newsFailureText(error.failure, pick.company);
    return error.failure === 'invalid' ? { kind: 'failed', message: text, detail: `PreReason says: ${error.message}` } : { kind: 'note', text };
  }
  const read = newsRead(answer, pick.kind, (engine.now?.() ?? new Date()).toISOString(), pick.company);
  if (!answer.records.length) return { kind: 'no-records', news: read };
  at.stopped();
  const operation = newsOperation(engine.operation);
  at.phase('answering');
  const result = await runOperation({
    operation,
    question,
    blocks: [newsBlock(read, answer)],
    model: engine.model,
    notes: newsNotes(read),
    // The block's lines hold no link, so the journal keeps each record's link beside its line.
    files: [
      ['pick.json', pickRecord({ read: [], by, date: null, dateFrom: null, news: query })],
      ['news.json', { records: read.records.map((line, i) => ({ line: i + 1, record: line, link: read.links[i] ?? null })) }],
    ],
    // The journal keeps the answer as the screen credits it: the records cited, and the window.
    render: (r) => {
      const v = answerView(r);
      return v && operation.render ? renderMarkdown(operation.render, v, newsMarkdownParts(v, read)) : null;
    },
    ...(engine.journal ? { journal: engine.journal } : {}),
    ...(engine.signal ? { signal: engine.signal } : {}),
    onStatus: (s) => {
      at.phase(s.phase);
      at.status(s.phase, ['news'], s.tokens);
    },
  });
  const view = answerView(result);
  if ((result.outcome === 'passed' || result.outcome === 'partial') && view) return { kind: 'answer', result, view, skipped: [], notes: [], added: [], news: read };
  if (result.outcome === 'refused') return { kind: 'failed', message: 'The packet was not sent to the model.', detail: result.reason ?? null };
  return { kind: 'failed', message: 'The answer did not pass its checks, so it is not shown.', detail: result.reason ? `It failed on: ${result.reason}` : null };
}

// What the model is told of a news packet, beside the ask's own primer.
const NEWS_PRIMER = [
  'The block news holds dated records from PreReason\'s news, one a line: the date, FILED or OFFICIAL, who filed or published it, what it is, and the source PreReason read it from.',
  'A record is what was filed or published, on its date. Say what it is and when, citing its line. Never set a price, a change or a move beside a record, never say what a record means for a price, and never say what to do.',
  'The records are every one PreReason holds in the window, newest first; they cannot be searched by topic. Where none answers the question, make no claim and say so in not_in_data.',
].join('\n');

// The operation for a news packet: the ask's own checks, its primer told what a record is.
export function newsOperation(operation: Operation): Operation {
  return { ...operation, primer: `${operation.primer.trim()}\n\n${NEWS_PRIMER}` };
}

// The operation for a packet read for a past day: its own checks, and as_of, which holds
// the answer's data_as_of to that day. A packet read now runs the operation's checks alone.
export function datedOperation(operation: Operation): Operation {
  return operation.spec.checks.includes('as_of') ? operation : { ...operation, spec: { ...operation.spec, checks: [...operation.spec.checks, 'as_of'] } };
}

// What the journal keeps of the choice, so a wrong pick can be found and fixed later.
export function pickRecord(o: { read: string[]; by: PickedBy; date: string | null; dateFrom: string | null; added?: string[]; skipped?: string[]; notes?: string[]; history?: string[]; news?: NewsQuery }): object {
  return {
    briefings: o.read.filter((id) => !isMetricId(id)),
    metrics: o.read.filter(isMetricId),
    picked_by: o.by,
    date: o.date,
    date_from: o.dateFrom,
    ...(o.added?.length ? { added: o.added } : {}),
    ...(o.skipped?.length ? { not_read_tier: o.skipped } : {}),
    ...(o.notes?.length ? { notes: o.notes } : {}),
    ...(o.history?.length ? { statement_history: o.history } : {}),
    // The news door's request as sent: whose records and the window.
    ...(o.news ? { news: o.news } : {}),
  };
}

export function messageOf(error: unknown): string {
  const cause = (error as { cause?: { code?: string } })?.cause?.code;
  if (cause) return `The connection failed (${cause}).`;
  return error instanceof Error ? error.message : String(error);
}

// For a hosted model, a first small step lets the model pick up to three briefings or
// metrics by their names and descriptions, and name the one past day the question asks
// about, if it asks about one. An empty pick is an answer: nothing fits. Anything it names
// that is not in the list is dropped; with nothing left of what it named, code picks
// instead. Its day is held to the rules any day is. The question comes after the catalog,
// so the catalog, the same for every question that day, can be cached by the provider.
// 0.5.0 (2026-10-13): one more choice, the news door, with a company or official records
// and a window, for a question that asks what was filed or published, and when.
// 0.5.1 (2026-10-14): the door holds 8-K items only, so a 10-Q, 10-K, 6-K or 20-F is no word
// of it: a question about one picks the company's briefing.
const PICK_OPERATION: Operation = {
  spec: {
    id: 'pick-briefings',
    version: '0.5.1',
    kind: 'research',
    title: 'Pick the briefings and metrics for a question',
    inputs: [],
    data: { sources: [{ connector: 'prereason', briefing: { from: 'catalog' }, format: 'json' }] },
    output: { schema: 'inline', forbiddenFields: ['action', 'side', 'size'] },
    checks: ['schema'],
  },
  dir: '',
  primer: [
    'Pick only what can answer the question, at most three, by the id at the start of each catalog line. A briefing id holds a dot; a metric id does not. A company briefing is read by naming the company in its id, as its line says, such as equities.company/nvda. Fewer is better than one that does not fit; pick none when none fits.',
    'If the question asks how things stood on one past day, give that day as date, YYYY-MM-DD, counting from today. Give no date for today, or for a span of days. A metric is read as it stands now only.',
    'One more choice is the news door, with a company or official records and a window: dated records of what a company PreReason covers filed, and of what federal agencies, Treasury and the Federal Reserve published. It cannot be searched by topic. Choose it when the question asks what was filed, released, published, announced or ruled, and when (words such as filed, filing, 8-K, Form, Federal Register, minutes, release, announced, enforcement action, proclamation, notice). Its filings are 8-K items only: for a 10-Q, 10-K, 6-K or 20-F, pick the company\'s briefing instead. Then give news, and read nothing else: kind filed with the company as its id, such as equities.company/nvda, for what a company filed, or kind official for official records; and since and until, YYYY-MM-DD, for the days the records would be dated, at most 92 days apart, or neither for the last 7 days.',
  ].join('\n'),
  schema: {
    type: 'object',
    required: ['read'],
    additionalProperties: false,
    properties: {
      read: { type: 'array', maxItems: 3, items: { type: 'string' } },
      date: { type: 'string' },
      news: {
        type: 'object',
        required: ['kind'],
        additionalProperties: false,
        properties: { kind: { enum: ['filed', 'official'] }, company: { type: 'string' }, since: { type: 'string' }, until: { type: 'string' } },
      },
    },
  },
  render: null,
};

// The pick's packet: the catalog as one block, then the question. npm run perf measures it.
export function pickPacket(question: string, readable: Pickable[], today: string): Packet {
  const catalog: DataBlock = { id: 'catalog', source: 'prereason', format: 'markdown', fetchedAt: new Date().toISOString(), heading: `Today is ${today}. The catalog (block catalog)`, lines: readable.map((b) => `${b.id}: ${b.name}. ${b.description}`) };
  return buildPacket({ operation: PICK_OPERATION, question, blocks: [catalog], questionLast: true });
}

// The news door as the model chose it: a kind it names, and the company as a code, never
// words ("EGP" is equities.company/egp; "EastGroup Properties" names none). Null where it
// chose no news.
function pickedNews(news: unknown): NewsPick | null {
  const n = (news ?? null) as { kind?: unknown; company?: unknown; since?: unknown; until?: unknown } | null;
  if (!n || (n.kind !== 'filed' && n.kind !== 'official')) return null;
  const named = typeof n.company === 'string' ? n.company.trim() : '';
  const company = n.kind === 'filed' && named ? companyBriefing(named.toLowerCase().startsWith(`${COMPANY_FAMILY}/`) ? named : `${COMPANY_FAMILY}/${named}`) : null;
  return { kind: n.kind, company, ...(typeof n.since === 'string' ? { since: n.since } : {}), ...(typeof n.until === 'string' ? { until: n.until } : {}) };
}

export async function pickWithModel(model: ModelAdapter, question: string, readable: Pickable[], today: string, signal?: AbortSignal): Promise<{ ids: string[]; date: string | null; news?: NewsPick } | null> {
  const packet = pickPacket(question, readable, today);
  try {
    const reply = await model.complete(packet, undefined, signal);
    const parsed = parseResponse(reply.text);
    if (!('value' in parsed)) return null;
    const value = (parsed.value ?? {}) as { read?: unknown; date?: unknown; news?: unknown };
    const news = pickedNews(value.news);
    if (news) return { ids: [], date: null, news };
    const ids = (Array.isArray(value.read) ? value.read : []) as unknown[];
    if (!Array.isArray(value.read)) return null;
    // A company briefing is picked by naming the company in the id, as its catalog line says.
    const family = readable.some((b) => b.id === COMPANY_FAMILY);
    // The family alone names no company, so the model's bare pick of it is dropped.
    const known = (id: string): string | null => (id === COMPANY_FAMILY ? null : readable.some((b) => b.id === id) ? id : family ? companyBriefing(id) : null);
    const valid = [...new Set(ids.map((id) => (typeof id === 'string' ? known(id) : null)).filter((id): id is string => Boolean(id)))].slice(0, 3);
    const date = typeof value.date === 'string' ? value.date : null;
    if (!ids.length) return { ids: [], date };
    return valid.length ? { ids: valid, date } : null;
  } catch (error) {
    if (signal?.aborted) throw error;
    return null;
  }
}
