import { COMPANY_FAMILY, companyBriefing } from '@primerkit/core';

// For a local model, code picks what to read and the model only answers. A question that
// names briefing or metric ids reads those. Otherwise its words are matched against each
// one's id, name and description, and the best matches are read, up to three across
// briefings and metrics. Ties keep the catalog's order, briefings first.

// What can be picked: a briefing or a metric. A briefing's id holds a dot; a metric's
// does not.
export interface Pickable {
  id: string;
  name: string;
  description: string;
}

export const isMetricId = (id: string): boolean => !id.includes('.');

// Where the question names an id as a word of its own, or -1: "btc.pulse:" names
// btc.pulse, "golden" does not name gold.
function namedAt(lower: string, id: string): number {
  const at = new RegExp(`(?<![a-z0-9.-])${id.replace(/[.-]/g, (c) => `\\${c}`)}(?![a-z0-9-]|\\.[a-z0-9])`).exec(lower);
  return at ? at.index : -1;
}

// Words that name no subject: a briefing is never matched on them.
const STOP = new Set(
  ('a an and are as at be by can do does doing for from has have how i if in is it its me my next now of on or ' +
    'our should so than that the their them then there these this to up down was what when where which who why ' +
    'will with would you your today right currently rising falling moving stand going ' +
    'ago past last previous since over during within')
    .split(' '),
);

// A span of time, "over 7 days", "the past 3 months", "2 weeks ago", names no subject
// either, and many descriptions have one: it is taken out before the words are counted.
// It once read two volatility metrics beside a briefing the question had named, on
// "over" and "days". A number with no such words is kept: "10 year" is a maturity.
const UNIT = String.raw`\d+\s*(?:days?|weeks?|months?|years?)`;
const SPAN = new RegExp(String.raw`\b(?:(?:over|during|within|across)\s+(?:the\s+)?(?:(?:last|past|previous|next)\s+)?|(?:the\s+)?(?:last|past|previous|next)\s+)${UNIT}\b|\b${UNIT}\s+ago\b`, 'g');

// Words a question uses for what a briefing's text calls something else.
const SAME: Record<string, string> = {
  btc: 'bitcoin',
  stocks: 'equities',
  stock: 'equities',
  equity: 'equities',
  rates: 'yield',
  yields: 'yield',
  bonds: 'treasury',
  treasuries: 'treasury',
  usd: 'dollar',
  miners: 'mining',
  miner: 'mining',
  hashrate: 'hash',
  etfs: 'etf',
  flow: 'flows',
};

export function wordsOf(text: string): Set<string> {
  const out = new Set<string>();
  for (const raw of text.toLowerCase().replace(SPAN, ' ').split(/[^a-z0-9]+/)) {
    if (raw.length < 2 || STOP.has(raw)) continue;
    const word = SAME[raw] ?? raw;
    out.add(word);
  }
  return out;
}

export interface Picked {
  ids: string[];
  named: string[]; // ids the question named itself
  added: string[]; // briefings it did not name that matched it closely, read beside the named ones
  drivers?: string; // where only metrics were read: the briefing that holds what drives them
  carried?: Array<{ metric: string; briefing: string }>; // metrics read in a briefing that carries their changes, in their place
}

export interface PickOptions {
  // The key's tier serves a metric read on its own as its latest reading alone, with no
  // change: a free key's.
  latestOnly?: boolean;
}

// A question that asks which way something moved, or by how much.
const CHANGE = /\b(?:ris(?:e|es|en|ing)|rose|fall(?:s|en|ing)?|fell|up|down|trend(?:s|ed|ing)?|chang(?:e|ed|es|ing)|direction|steepen(?:s|ed|ing)?|flatten(?:s|ed|ing)?|increas(?:e|ed|es|ing)|decreas(?:e|ed|es|ing)|grow(?:s|n|ing)?|grew|shrink(?:s|ing)?|shrank|climb(?:s|ed|ing)?|drop(?:s|ped|ping)?|mov(?:e|ed|es|ing)|higher|lower|accelerat(?:e|ed|es|ing)|slow(?:s|ed|ing)?|since|ago|week|month)\b/i;
export const asksChange = (question: string): boolean => CHANGE.test(question);

// The words of a text in order, each as wordsOf reads it, none dropped: for a phrase.
const tokensOf = (text: string): string[] =>
  text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
    .map((w) => SAME[w] ?? w);

// Whether a briefing carries a metric, as the catalog describes it: the metric's id, word for
// word, in the briefing's name or description ("net-liquidity" in macro.snapshot's "composite
// net liquidity"). A briefing serves its metrics with their changes to any key that reads it.
function carries(briefing: Pickable, metric: string): boolean {
  const want = tokensOf(metric);
  const have = tokensOf(`${briefing.name} ${briefing.description}`);
  return want.length > 0 && have.some((_, i) => want.every((w, j) => have[i + j] === w));
}

// A briefing filed under an asset the question does not name: btc.quick-check for a question
// about net liquidity. The note for one once pointed there, to a Bitcoin briefing.
const ASSETS: Record<string, string[]> = { btc: ['bitcoin'], eth: ['ethereum', 'eth'] };
function offAsset(id: string, asked: Set<string>): boolean {
  const asset = ASSETS[id.split('.')[0] ?? ''];
  return Boolean(asset) && !asset!.some((a) => asked.has(a));
}

// The company briefings a question names by their code, in the order it names them:
// "equities.company/nvda". A full stop or a dash that ends the sentence is not part of the
// company's code.
export function companiesNamed(question: string): Array<{ id: string; at: number }> {
  return [...question.toLowerCase().matchAll(/equities\.company\/[a-z0-9.-]+/g)].flatMap((m) => {
    const id = companyBriefing(m[0].replace(/[.-]+$/, ''));
    return id ? [{ id, at: m.index ?? 0 }] : [];
  });
}

// A briefing the question did not name joins the named ones only when this many of the
// question's words appear in its name or description.
export const HIGHLY_RELEVANT = 2;

interface Scored {
  id: string;
  order: number;
  score: number; // how many of the question's words its id, name and description hold
  hits: Set<string>;
  inTitle: Set<string>; // the hits in its id or name
}

// The reads that cover the question's subjects with the fewest entries: the entry that holds
// the most of its words first, then only an entry that adds a word not yet covered, the one
// that adds the most, at most `max`. A tie goes to the entry whose id or name holds the word,
// so a fact is read from its own series ("Net Liquidity"), not from a briefing that mentions
// it; once read, three briefings that mention net liquidity were read and its own series and
// briefing were not. Where only metrics are read, the briefing that holds the question's
// words best is named: a briefing holds what drives a figure and how it connects.
// A word of time alone is no subject a read could cover: "this week" once read a "26 Week
// Percentile" beside net liquidity. With its number matched too, it counts: "10 year".
const UNITS = new Set(['day', 'days', 'week', 'weeks', 'month', 'months', 'year', 'years']);
const NUMBER = /^\d+$/;

function cover(scored: Scored[], max: number): string[] {
  const covered = new Set<string>();
  const ids: string[] = [];
  while (ids.length < max) {
    let best: Scored | null = null;
    let bestFresh = 0;
    let bestTitled = 0;
    for (const e of scored) {
      if (ids.includes(e.id)) continue;
      const numbered = [...e.hits].some((w) => NUMBER.test(w));
      const fresh = [...e.hits].filter((w) => !covered.has(w) && (numbered || !UNITS.has(w)));
      const titled = fresh.filter((w) => e.inTitle.has(w)).length;
      if (fresh.length > bestFresh || (fresh.length && fresh.length === bestFresh && titled > bestTitled)) {
        best = e;
        bestFresh = fresh.length;
        bestTitled = titled;
      }
    }
    if (!best) break;
    ids.push(best.id);
    for (const w of best.hits) covered.add(w);
  }
  return ids;
}

// What a word match reads, from the entries that cover the question. On a key served a
// metric's latest reading alone, a question about which way it moved reads the briefing that
// carries the metric with its changes, in the metric's place: "Is net liquidity rising or
// falling?" once read net-liquidity alone on a free key and answered with its level, while
// macro.snapshot, which that key reads, holds its 7 day change. Where only metrics are read,
// the briefing that carries them is named for what drives them, else the one that holds the
// question's words best.
function wordMatch(ids: string[], ranked: Scored[], scored: Scored[], entries: Pickable[], asked: Set<string>, question: string, options: PickOptions): Omit<Picked, 'named' | 'added'> {
  const entry = new Map(entries.map((e) => [e.id, e]));
  const briefings = ranked.filter((e) => !isMetricId(e.id));
  const rank = (a: Scored, b: Scored) => b.score - a.score || b.inTitle.size - a.inTitle.size || Number(offAsset(a.id, asked)) - Number(offAsset(b.id, asked)) || a.order - b.order;
  const carrierOf = (metric: string): Scored | undefined => briefings.filter((b) => carries(entry.get(b.id) as Pickable, metric)).sort(rank)[0];
  let read = ids;
  const carried: NonNullable<Picked['carried']> = [];
  if (options.latestOnly && asksChange(question)) {
    read = [];
    for (const id of ids) {
      const by = isMetricId(id) ? carrierOf(id) : undefined;
      if (by) carried.push({ metric: id, briefing: by.id });
      if (!read.includes(by?.id ?? id)) read.push(by?.id ?? id);
    }
  }
  const out = { ids: read, ...(carried.length ? { carried } : {}) };
  if (!read.length || !read.every(isMetricId)) return out;
  const drivers = read.map(carrierOf).find(Boolean) ?? scored.find((e) => !isMetricId(e.id));
  return drivers ? { ...out, drivers: drivers.id } : out;
}

export function pickBriefings(question: string, entries: Pickable[], max = 3, options: PickOptions = {}): Picked {
  const lower = question.toLowerCase();
  // The company family named with a company, "equities.company/nvda", names that company's
  // briefing, and with two companies, both; the family alone names none, and its read says
  // so.
  const companies = companiesNamed(question);
  const named = [
    ...new Set(
      entries
        .flatMap((b) => (b.id === COMPANY_FAMILY && companies.length ? companies : [{ id: b.id, at: namedAt(lower, b.id) }]))
        .filter((b) => b.at >= 0)
        .sort((a, b) => a.at - b.at)
        .map((b) => b.id),
    ),
  ];
  // A question that names a company asks about that company: the words of its figures (net
  // sales, operating income, total borrowings) are in many descriptions, and once read a
  // Treasury holders briefing and a repo rate beside the company. Nothing is added to it.
  if (named.some((id) => companyBriefing(id))) return { ids: named.slice(0, max), named, added: [] };
  // The words of the question, with the ids it named taken out.
  const asked = wordsOf(named.reduce((q, id) => q.split(id).join(' '), lower));
  const ranked = entries
    // The company family alone names no company, so it is never read by its words.
    .filter((b) => !named.includes(b.id) && b.id !== COMPANY_FAMILY)
    .map((b, order) => {
      const titled = wordsOf(`${b.id.replace(/[.-]/g, ' ')} ${b.name}`);
      const words = new Set([...titled, ...wordsOf(b.description)]);
      const hits = new Set([...asked].filter((w) => words.has(w)));
      return { id: b.id, order, score: hits.size, hits, inTitle: new Set([...hits].filter((w) => titled.has(w))) };
    });
  const scored = ranked.filter((b) => b.score > 0).sort((a, b) => b.score - a.score || b.inTitle.size - a.inTitle.size || a.order - b.order);
  if (!named.length) return { ...wordMatch(cover(scored, max), ranked, scored, entries, asked, lower, options), named, added: [] };
  const added = scored
    .filter((b) => b.score >= HIGHLY_RELEVANT)
    .map((b) => b.id)
    .slice(0, Math.max(0, max - named.length));
  return { ids: [...named.slice(0, max), ...added], named, added };
}

// A question that asks what was filed, released, published, announced or ruled, and when, is
// read from PreReason's news: a filing or a notice is in no briefing and no metric. With a
// company named in its id, it asks what that company filed. Otherwise the words of an official
// act (the Federal Register, minutes, a notice) ask what agencies, Treasury and the Federal
// Reserve published; the words of a filing alone ask what a company filed, with no company
// named (company null); "released" or "announced" alone asks for official records. A question
// about what is to come ("the next release") is a calendar's, never news.
export interface NewsAsked {
  kind: 'filed' | 'official';
  company: string | null; // equities.company/<code>, where the question names one
}

const FILED_WORDS = /\b(?:files?|filed|filings?|8-K|form\s+(?:\d{1,3}(?:-[a-z])?|[a-z]-\d{1,2}))\b/i;
// The filings the news door does not hold: it holds a company's 8-K items, not its 10-Q,
// 10-K, 6-K or 20-F. A question about one reads the briefings, where a company's briefing
// names what it filed; read as news, "equities.company/nvda: revenue in its latest 10-Q?"
// read 8-K items alone, and the company's briefing was never read.
const NOT_HELD = /\b(?:10-Q|10-K|6-K|20-F)\b/i;
// "minutes" after a number is a span of time, "the last 30 minutes", not a meeting's minutes.
const OFFICIAL_WORDS = /\b(?:federal register|proclamations?|enforcement actions?|notices?|published|publish(?:es)?|ruled|rulings?)\b|(?<!\d\s*)\bminutes\b/i;
const EITHER_WORDS = /\b(?:releas(?:e|ed|es)|announc(?:e|ed|es|ement|ements))\b/i;
const TO_COME = /\b(?:next|upcoming|scheduled|expected|will)\b/i;

export function newsAsked(question: string): NewsAsked | null {
  const filed = FILED_WORDS.test(question);
  const official = OFFICIAL_WORDS.test(question);
  if ((!filed && !official && !EITHER_WORDS.test(question)) || TO_COME.test(question) || NOT_HELD.test(question)) return null;
  const named = /equities\.company\/[a-z0-9.-]+/i.exec(question);
  const company = named ? companyBriefing(named[0].replace(/[.-]+$/, '')) : null;
  if (company) return { kind: 'filed', company };
  return { kind: filed && !official ? 'filed' : 'official', company: null };
}

// For the note when nothing matched: up to five briefings or metrics nearest the question,
// by the same words, where a word counts when it and one of an entry's words begin with
// the same five letters ("treasuries" is near "treasury", "inflation" near
// "inflationary"). None, when no word comes that near.
export function closest(question: string, entries: Pickable[], max = 5): string[] {
  const stems = (text: string) => new Set([...wordsOf(text)].filter((w) => w.length >= 5).map((w) => w.slice(0, 5)));
  const asked = [...stems(question)];
  return entries
    .map((b, order) => {
      const near = stems(`${b.id.replace(/[.-]/g, ' ')} ${b.name} ${b.description}`);
      return { id: b.id, order, score: asked.filter((s) => near.has(s)).length };
    })
    .filter((b) => b.score > 0)
    .sort((a, b) => b.score - a.score || a.order - b.order)
    .slice(0, max)
    .map((b) => b.id);
}
