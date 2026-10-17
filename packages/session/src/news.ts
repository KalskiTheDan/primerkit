import { NEWS_BLOCK, hhmm, longDay, type AnswerView, type DataBlock } from '@primerkit/core';
import { NEWS_MAX_LIMIT, type NewsAnswer, type NewsFailure, type NewsKind, type NewsRecord } from '@primerkit/connector-prereason';

// A read of PreReason's news, as an answer shows it: the block of records the model cites, and
// the words around it. The sources, the window and the company are PreReason's as served,
// never typed here (the wording review's condition, 10-13): a source PreReason adds shows at once,
// and a source it did not read is never named as read. No price, change or move is ever set
// beside a record: a record is what was filed or published, on its date.

export interface NewsRead {
  kind: NewsKind;
  company: string | null; // the company as PreReason names it, for what a company filed
  since: string; // the window as served, YYYY-MM-DD
  until: string;
  readAt: string; // when it was read, ISO
  sources: string | null; // the sources the answer says it read; null where its sentence is worded otherwise
  coverage: string; // that sentence as served
  notRead: string[]; // the sources not read for this answer, as served
  notices: string[]; // the notices of the sources whose records the answer holds, as served
  records: string[]; // one line a record, as the block numbers them
  links: Array<string | null>; // each record's link, as served, in the records' order
  full: boolean; // the read reached the most records PreReason serves at once
}

// A source's name without its aside: "SEC EDGAR 8-K items (USA companies PreReason covers)"
// is "SEC EDGAR 8-K items".
export const withoutAsides = (name: string): string => name.replace(/\s*\([^()]*\)/g, '').replace(/\s+/g, ' ').trim();

// The sources an answer says it read, from its coverage sentence ("Read: A and B, from ... to
// ... ." or "Nothing found in A from ... ."). Null where PreReason words it otherwise: the
// sentence is then shown whole, and no source is named that the answer does not name.
export function sourcesRead(coverage: string): string | null {
  const m = /^(?:Read:\s*|Nothing found in\s+)(.+?),?\s+from \d{4}-\d{2}-\d{2} to \d{4}-\d{2}-\d{2}\b/.exec(coverage.trim());
  return m?.[1] ? withoutAsides(m[1]) : null;
}

// "Oct 1, 2026", or with its time and whose clock, "Oct 7, 2026 14:00 New York time", where
// the source states a time.
function recordDay(r: NewsRecord): string {
  if (!r.time) return longDay(r.date);
  const clock = /\d{1,2}:\d{2}\s+([^()]+?)\s*\(/.exec(r.when)?.[1];
  return `${longDay(r.date)} ${r.time}${clock ? ` ${clock}` : ''}`;
}

const oneLine = (s: string): string => s.replace(/\s+/g, ' ').trim();

// One record, one line: its date, its mark, who, what, and the source it was read from.
// Nothing else a record might carry is set beside it. Its link is not in the line: the checks
// read every number in a cited line, and a link's digits (a gazette's /2026/10/07/, an
// accession's -26-) once grounded figures no record states. The link shows beside the line on
// screen, from the record itself (recordShown), and the journal keeps it.
export function recordLine(r: NewsRecord): string {
  return [recordDay(r), r.mark, oneLine(r.who), oneLine(r.line), withoutAsides(r.source)].filter(Boolean).join(' · ');
}

// A cited record as a person reads it: its line, then its link, as served.
export function recordShown(read: NewsRead, n: number): string | null {
  const line = read.records[n - 1];
  if (line === undefined) return null;
  const link = read.links[n - 1];
  return link ? `${line} · ${oneLine(link)}` : line;
}

export function newsRead(answer: NewsAnswer, kind: NewsKind, readAt: string, asked: string | null = null, limit = NEWS_MAX_LIMIT): NewsRead {
  return {
    kind,
    company: answer.about?.company ?? asked,
    since: answer.window.since,
    until: answer.window.until,
    readAt,
    sources: sourcesRead(answer.coverage),
    coverage: answer.coverage,
    notRead: answer.not_read ?? [],
    notices: answer.notices ?? [],
    records: answer.records.map(recordLine),
    links: answer.records.map((r) => r.link),
    full: answer.records.length >= limit,
  };
}

// "Sep 28 to Oct 9, 2026"; one day, "Oct 1, 2026"; across a year, "Dec 28, 2025 to Jan 3, 2026".
export function spanWords(since: string, until: string): string {
  if (since === until) return longDay(until);
  const from = longDay(since);
  return since.slice(0, 4) === until.slice(0, 4) ? `${from.replace(/, \d{4}$/, '')} to ${longDay(until)}` : `${from} to ${longDay(until)}`;
}

const whose = (read: NewsRead): string => (read.kind === 'filed' ? `filed by ${read.company ?? 'the company asked about'}` : 'official records');

// The credit under a news answer: the door, whose records, the window, and when it was read.
export function newsCredit(read: NewsRead): string {
  return `news · ${whose(read)} · ${spanWords(read.since, read.until)} · read ${hhmm(read.readAt)} UTC`;
}

// A window that holds no record: what was read, never "nothing happened".
export function emptyLines(read: NewsRead): string[] {
  const what = read.kind === 'filed' ? `record filed by ${read.company ?? 'the company asked about'}` : 'official record';
  return [`PreReason's news holds no ${what} from ${spanWords(read.since, read.until)}.`, read.sources ? `Sources read: ${read.sources}.` : read.coverage];
}

// Records were read and the answer cites none of them: none answers the question.
export function noneLine(read: NewsRead): string {
  const n = read.records.length;
  const what = read.kind === 'filed' ? `record${n === 1 ? '' : 's'} filed by ${read.company ?? 'the company asked about'}` : `official record${n === 1 ? '' : 's'}`;
  const span = spanWords(read.since, read.until);
  return n === 1 ? `The one ${what} from ${span} does not answer this.` : `None of the ${n} ${what} from ${span} answers this.`;
}

// What else the read says, printed whenever it says it: the sources not read (a record from
// them would not show), each source's notice, and a read that reached the most records served.
export function sideLines(read: NewsRead): string[] {
  const out: string[] = [];
  if (read.full) out.push(`Only the newest ${read.records.length} records of this window were read; a shorter span reads older ones.`);
  if (read.notRead.length) {
    const names = read.notRead.map(withoutAsides);
    const listed = names.length === 1 ? names[0] : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;
    out.push(`Not read for this answer: ${listed}. A record from ${names.length === 1 ? 'it' : 'them'} would not show here.`);
  }
  for (const notice of read.notices) out.push(`Notice: ${notice}`);
  return out;
}

// The market a company's code names, for the words when PreReason reads no filings for it: an
// Indian ISIN, ine018a01030. PreReason's refusal names the company, not its market, and no
// data host is named for it.
const ISIN_MARKETS: Record<string, string> = { in: 'Indian' };

export function marketOf(code: string): string | null {
  return /^[a-z]{2}[a-z0-9]{9}\d$/.test(code) ? (ISIN_MARKETS[code.slice(0, 2)] ?? null) : null;
}

// The door's refusals, in the words the screen says them. `asked`: the company as the question
// or the pick named it.
export function newsFailureText(failure: NewsFailure, asked: string | null): string {
  if (failure === 'not-covered') return `PreReason's news does not cover "${asked ?? 'that company'}".`;
  if (failure === 'no-source') {
    const market = asked ? marketOf(asked.split('/').pop() ?? '') : null;
    return market ? `PreReason reads no filings for ${market} companies yet.` : "PreReason reads no filings for this company's market yet.";
  }
  if (failure === 'unavailable') return "PreReason's news could not be read just now. Nothing was answered.";
  return "PreReason's news refused this request.";
}

// The block the model reads: one numbered line a record, newest first, so a claim cites a
// record as it cites a briefing line, and the same checks hold.
export function newsBlock(read: NewsRead, answer: NewsAnswer): DataBlock {
  const n = read.records.length;
  return {
    id: NEWS_BLOCK,
    source: 'prereason',
    format: 'markdown',
    fetchedAt: read.readAt,
    lines: read.records,
    heading: `PreReason's news (block news): ${n} ${n === 1 ? 'record' : 'records'} ${read.kind === 'filed' ? `filed by ${read.company ?? 'the company asked about'}` : 'of official acts'}, from ${read.since} to ${read.until}${answer.window.basis ? ` (${answer.window.basis})` : ''}, newest first, one record a line`,
  };
}

// What the packet says beside the block: the sources not read, and a read cut at the most
// records served, so the model never takes a missing record for nothing filed.
export function newsNotes(read: NewsRead): string[] {
  return sideLines(read).filter((l) => !l.startsWith('Notice: '));
}

// The answer as markdown, for `primerkit ask` and the journal: the cited records as the
// sources, the news credit, and the side lines.
export function newsMarkdownParts(view: AnswerView, read: NewsRead): Record<string, string> {
  const cited = view.sources.map((s) => `[${s.n}] ${s.block === NEWS_BLOCK ? (recordShown(read, s.line) ?? `news, line ${s.line}`) : `${s.block}, line ${s.line}`}`);
  return {
    ...(view.sentences.length ? {} : { body: noneLine(read) }),
    sources: [...cited, ...(sideLines(read).length ? ['', ...sideLines(read)] : [])].join('\n'),
    briefings: `news · ${whose(read)} · ${spanWords(read.since, read.until)}`,
    when: `read ${hhmm(read.readAt)} UTC`,
  };
}
