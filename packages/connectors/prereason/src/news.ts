import { COMPANY_CODE } from '@primerkit/core';
import { DATE, RefusedRequest } from './ids';

// PreReason's news door, GET /api/news: dated records of what the companies it covers filed
// and what federal agencies, Treasury and the Federal Reserve published. There is no search
// by words: a read names a company (about), a kind (filed or official) and a window of days.
// Every keyed tier reads it, each read counts as one call on the key, and PreReason never
// caches it, so a record filed minutes ago shows; primerkit keeps no copy of it either.

export type NewsKind = 'filed' | 'official';
export const NEWS_KINDS: readonly NewsKind[] = ['filed', 'official'];

// The most records one read serves, and the longest window PreReason reads, in days.
export const NEWS_MAX_LIMIT = 25;
export const NEWS_MAX_DAYS = 92;

export interface NewsQuery {
  about?: string; // a company's code, as in equities.company/<code>
  kind?: NewsKind;
  since?: string; // YYYY-MM-DD
  until?: string;
  asOf?: string; // in place of until: the window that ends on that day
  limit?: number; // 1 to 25
}

// One record as PreReason serves it: FILED or OFFICIAL, the date it shows (its time where the
// source states one, and `when` saying in whose clock), who filed or published it, what it
// is, the source PreReason read it from, and its link.
export interface NewsRecord {
  mark: 'FILED' | 'OFFICIAL';
  when: string;
  date: string;
  time: string | null;
  who: string;
  line: string;
  source: string;
  link: string | null;
  briefing: string | null;
}

export interface NewsAnswer {
  about: { company: string; ticker: string | null; market: string; briefing: string } | null;
  window: { since: string; until: string; basis: string };
  records: NewsRecord[];
  coverage: string; // the sentence naming every source read and the window
  notices?: string[]; // what the terms of a source whose records the answer holds ask to be shown
  note?: string;
  not_read?: string[]; // the sources that could not be read for this answer
}

// The request, built only from a company code, a kind, dates and a number, so nothing from a
// question travels in it. A company with official records is refused here, never sent:
// official records name no company, and PreReason answers that pair 400.
export function newsUrl(base: string, q: NewsQuery): string {
  if (q.about !== undefined && !COMPANY_CODE.test(q.about)) throw new RefusedRequest(`"${q.about}" is not a company code`);
  if (q.kind !== undefined && !NEWS_KINDS.includes(q.kind)) throw new RefusedRequest(`"${q.kind}" is not a kind of news, filed or official`);
  if (q.about !== undefined && q.kind === 'official') throw new RefusedRequest('Official records name no company, so none is asked about');
  for (const day of [q.since, q.until, q.asOf]) if (day !== undefined && !DATE.test(day)) throw new RefusedRequest(`"${day}" is not a date`);
  if (q.until !== undefined && q.asOf !== undefined) throw new RefusedRequest('A window ends on until or on as_of, not both');
  if (q.limit !== undefined && !(Number.isInteger(q.limit) && q.limit >= 1 && q.limit <= NEWS_MAX_LIMIT)) throw new RefusedRequest(`${q.limit} is not a limit from 1 to ${NEWS_MAX_LIMIT}`);
  const url = new URL('/api/news', base);
  if (q.about !== undefined) url.searchParams.set('about', q.about);
  if (q.kind !== undefined) url.searchParams.set('kind', q.kind);
  if (q.since !== undefined) url.searchParams.set('since', q.since);
  if (q.until !== undefined) url.searchParams.set('until', q.until);
  if (q.asOf !== undefined) url.searchParams.set('as_of', q.asOf);
  if (q.limit !== undefined) url.searchParams.set('limit', String(q.limit));
  return url.toString();
}

const text = (v: unknown): string | null => (typeof v === 'string' ? v : null);
const texts = (v: unknown): string[] => (Array.isArray(v) ? v.filter((s): s is string => typeof s === 'string' && s.trim().length > 0).map((s) => s.trim()) : []);

// The answer as served, read defensively; null where it is not one. A record without its date,
// its mark, who or its source is left out rather than shown half.
export function parseNews(body: string): NewsAnswer | null {
  let json: unknown;
  try {
    json = JSON.parse(body);
  } catch {
    return null;
  }
  const a = (json ?? {}) as Record<string, unknown>;
  const window = (a.window ?? {}) as Record<string, unknown>;
  if (!Array.isArray(a.records) || typeof a.coverage !== 'string' || !text(window.since) || !text(window.until)) return null;
  if (!DATE.test(window.since as string) || !DATE.test(window.until as string)) return null;
  const records = a.records
    .map((r) => (r ?? {}) as Record<string, unknown>)
    .filter((r) => (r.mark === 'FILED' || r.mark === 'OFFICIAL') && typeof r.date === 'string' && DATE.test(r.date) && text(r.who) && text(r.source))
    .map((r): NewsRecord => ({
      mark: r.mark as NewsRecord['mark'],
      when: text(r.when) ?? '',
      date: r.date as string,
      time: text(r.time),
      who: r.who as string,
      line: text(r.line) ?? '',
      source: r.source as string,
      link: text(r.link),
      briefing: text(r.briefing),
    }));
  const about = a.about && typeof a.about === 'object' ? (a.about as Record<string, unknown>) : null;
  const notices = texts(a.notices);
  const notRead = texts(a.not_read);
  return {
    about: about && text(about.company) ? { company: about.company as string, ticker: text(about.ticker), market: text(about.market) ?? '', briefing: text(about.briefing) ?? '' } : null,
    window: { since: window.since as string, until: window.until as string, basis: text(window.basis) ?? '' },
    records,
    coverage: a.coverage,
    ...(notices.length ? { notices } : {}),
    ...(text(a.note) ? { note: a.note as string } : {}),
    ...(notRead.length ? { not_read: notRead } : {}),
  };
}
