import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { NEWS_MAX_DAYS, NewsError, PreReasonClient, PreReasonError, RefusedRequest, newsAsked, newsUrl, newsWindow, parseNews } from '../src/index';

// PreReason's news door, GET /api/news, as primerkit asks it: the request built from a company
// code, a kind and dates only, its refusals as their own kinds, its answer read defensively,
// the window a question names, and which questions are news at all. The fixtures follow the
// answer as PreReason's get-news.ts builds it (NewsAnswer, NewsRecord, the coverage sentence).

const here = dirname(fileURLToPath(import.meta.url));
const fixture = (name: string): string => readFileSync(join(here, 'fixtures', 'news', name), 'utf8');
const BASE = 'https://api.prereason.com';
const TODAY = '2026-10-12';

// Keys are built here, never written out, and are not real keys.
const fakeKey = (tag: string) => `pr_test_${tag.repeat(20)}`;

function recorder(answer: (url: URL) => Response) {
  const seen: Array<{ url: URL; headers: Record<string, string> }> = [];
  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    seen.push({ url, headers: Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>)) });
    return answer(url);
  }) as typeof fetch;
  return { seen, impl };
}

const client = (answer: (url: URL) => Response) => {
  const net = recorder(answer);
  return { net, pr: new PreReasonClient({ key: fakeKey('n'), version: '0.1.0', fetch: net.impl }) };
};

describe('the news request', () => {
  it('names a company by its code, a kind, a window and a limit, and nothing else', () => {
    expect(newsUrl(BASE, { about: 'fxmp', kind: 'filed', since: '2026-09-28', until: '2026-10-09', limit: 25 })).toBe(`${BASE}/api/news?about=fxmp&kind=filed&since=2026-09-28&until=2026-10-09&limit=25`);
    expect(newsUrl(BASE, { kind: 'official', asOf: '2026-10-01' })).toBe(`${BASE}/api/news?kind=official&as_of=2026-10-01`);
    // No window: PreReason's own default, the 7 days ending today.
    expect(newsUrl(BASE, { kind: 'official' })).toBe(`${BASE}/api/news?kind=official`);
  });

  it('never sends a company with official records, and never words for a company', () => {
    expect(() => newsUrl(BASE, { about: 'fxmp', kind: 'official' })).toThrow(RefusedRequest);
    expect(() => newsUrl(BASE, { about: 'Fictional Group Corp', kind: 'filed' })).toThrow(RefusedRequest);
    expect(() => newsUrl(BASE, { kind: 'filed', until: '2026-10-09', asOf: '2026-10-09' })).toThrow(RefusedRequest);
    expect(() => newsUrl(BASE, { kind: 'filed', since: 'Sep 28' })).toThrow(RefusedRequest);
    expect(() => newsUrl(BASE, { kind: 'filed', limit: 26 })).toThrow(RefusedRequest);
    // CONTROL: the same company with filed records is sent.
    expect(newsUrl(BASE, { about: 'fxmp', kind: 'filed' })).toContain('about=fxmp&kind=filed');
  });

  it('refuses a company with official records before anything is sent', async () => {
    const { net, pr } = client(() => new Response('{}', { status: 400 }));
    await expect(pr.news({ about: 'fxmp', kind: 'official' })).rejects.toThrow(RefusedRequest);
    expect(net.seen).toEqual([]);
  });

  it('reads the answer as JSON on the key, and counts it as a call', async () => {
    const { net, pr } = client(() => new Response(fixture('filed-fxmp-2026-10-09.json'), { status: 200, headers: { 'x-ratelimit-limit-day': '500', 'x-ratelimit-remaining-day': '411', 'x-prereason-tier': 'basic' } }));
    const answer = await pr.news({ about: 'fxmp', kind: 'filed', since: '2026-09-28', until: '2026-10-09' });
    expect(net.seen).toHaveLength(1);
    expect(net.seen[0]!.url.pathname).toBe('/api/news');
    expect(net.seen[0]!.headers.Accept).toBe('application/json');
    expect(net.seen[0]!.headers.Authorization).toMatch(/^Bearer /);
    // The call is on the key: the day's budget and the tier are read from it.
    expect(pr.budget).toEqual({ limit: 500, remaining: 411 });
    expect(pr.tier).toBe('basic');
    expect(answer.about?.company).toBe('Fictional Group Corp');
    expect(answer.records).toHaveLength(3);
    expect(answer.records[2]).toMatchObject({ mark: 'FILED', date: '2026-10-01', who: 'Fictional Group Corp', line: '8-K item 2.02, results of operations', source: 'Sample Filings Registry 8-K items (fictional companies, for tests)' });
    // Never cached: the same question asked again is asked again.
    await pr.news({ about: 'fxmp', kind: 'filed', since: '2026-09-28', until: '2026-10-09' });
    expect(net.seen).toHaveLength(2);
  });

  it('turns each refusal of the door into its own kind', async () => {
    const refusal = async (status: number, body: object) => {
      const { pr } = client(() => new Response(JSON.stringify(body), { status }));
      return pr.news({ about: 'zzzz', kind: 'filed' }).catch((e: unknown) => e);
    };
    expect(await refusal(400, { error: 'INVALID_DATE', message: 'A window holds at most 92 days.' })).toMatchObject({ failure: 'invalid', status: 400, code: 'INVALID_DATE' });
    expect(await refusal(404, { error: 'NOT_COVERED', message: 'No company PreReason covers matches "zzzz".' })).toMatchObject({ failure: 'not-covered', status: 404 });
    expect(await refusal(404, { error: 'NO_SOURCE', message: 'This version reads no filings for Reliance Industries.' })).toMatchObject({ failure: 'no-source', status: 404 });
    const down = await refusal(503, { error: 'NEWS_UNAVAILABLE', message: 'No source could be read right now. Try again shortly.' });
    expect(down).toBeInstanceOf(NewsError);
    expect(down).toMatchObject({ failure: 'unavailable', status: 503 });
    // CONTROL: a refused key and a rate limit stay PreReason's own errors, not the door's.
    const key = await refusal(401, { error: 'UNAUTHORIZED', message: 'Authentication required.' });
    expect(key).toBeInstanceOf(PreReasonError);
    expect(key).not.toBeInstanceOf(NewsError);
    expect(await refusal(429, { code: 'RATE_LIMIT_EXCEEDED', message: 'Daily limit reached' })).not.toBeInstanceOf(NewsError);
  });

  it('reads the answer defensively: a record without its date or source is left out, an unreadable body is none', () => {
    const served = JSON.parse(fixture('official-2026-10-09.json')) as { records: object[] };
    served.records.push({ mark: 'OFFICIAL', who: 'Nobody', line: 'no date', source: 'somewhere' }, { mark: 'RUMOUR', date: '2026-10-01', who: 'x', source: 'y' });
    const answer = parseNews(JSON.stringify(served))!;
    expect(answer.records).toHaveLength(12);
    expect(answer.notices).toEqual(['Source: Sample Gazette (Office of the Sample Gazette, Fictionland), naming the issuing office.', 'Source: Board of the Example Central Bank.']);
    expect(answer.not_read).toBeUndefined();
    expect(parseNews('<html>')).toBeNull();
    expect(parseNews(JSON.stringify({ records: [] }))).toBeNull();
  });
});

describe('the window a news question names', () => {
  it('reads a span from its first named day to its last', () => {
    expect(newsWindow('What did Fictional Group file between September 28 and October 9?', TODAY)).toEqual({ kind: 'span', since: '2026-09-28', until: '2026-10-09' });
    expect(newsWindow('Federal Register notices from 2026-10-09 back to 2026-09-28', TODAY)).toEqual({ kind: 'span', since: '2026-09-28', until: '2026-10-09' });
  });

  it('reads one named day as the window that ends on it, and no day as PreReason\'s own default', () => {
    expect(newsWindow('Which items did Fictional Group Corp report in its Form 8-K filed on October 1, 2026?', TODAY)).toEqual({ kind: 'day', asOf: '2026-10-01' });
    expect(newsWindow('What did the Federal Register publish on trade this week?', TODAY)).toEqual({ kind: 'default' });
  });

  it('refuses a window longer than 92 days, in plain words, before any call', () => {
    const w = newsWindow('What was filed between January 2 and October 9, 2026?', TODAY);
    expect(w.kind).toBe('refused');
    expect(w.kind === 'refused' && w.why).toBe(`From Jan 2, 2026 to Oct 9, 2026 is more than ${NEWS_MAX_DAYS} days, and PreReason's news reads at most ${NEWS_MAX_DAYS} days at a time, so nothing was read. Name a shorter span, such as Jul 9, 2026 to Oct 9, 2026.`);
    // CONTROL: 92 days, as PreReason counts them, is read.
    expect(newsWindow('What was filed between 2026-07-09 and 2026-10-09?', TODAY)).toEqual({ kind: 'span', since: '2026-07-09', until: '2026-10-09' });
  });

  it('refuses a day not on the calendar or still to come', () => {
    expect(newsWindow('What was filed on 2026-02-30?', TODAY)).toMatchObject({ kind: 'refused', why: expect.stringContaining('2026-02-30 is not a day on the calendar') });
    expect(newsWindow('What was filed on 2026-10-20?', TODAY)).toMatchObject({ kind: 'refused', why: expect.stringContaining('Oct 20, 2026 has not come yet') });
  });

  it('takes no window from a reporting period\'s dates', () => {
    expect(newsWindow('What did it file on October 1 for the quarter ended September 30?', TODAY)).toEqual({ kind: 'day', asOf: '2026-10-01' });
  });
});

describe('which questions are news', () => {
  it('reads what a company filed where the question names the company by its id', () => {
    expect(newsAsked('equities.company/fxmp: what did it file on October 1?')).toEqual({ kind: 'filed', company: 'equities.company/fxmp' });
    expect(newsAsked('Which items did equities.company/FXMP report in its 8-K?')).toEqual({ kind: 'filed', company: 'equities.company/fxmp' });
  });

  it('reads official records for an official act, and a filing with no company named as one', () => {
    expect(newsAsked('On what date did the Federal Reserve release the minutes of the FOMC meeting?')).toEqual({ kind: 'official', company: null });
    expect(newsAsked('On what date did the Office of the US Trade Representative publish in the Federal Register?')).toEqual({ kind: 'official', company: null });
    expect(newsAsked('Was a proclamation on aluminum announced?')).toEqual({ kind: 'official', company: null });
    expect(newsAsked('Which items did Fictional Group Corp report in its Form 8-K filed on October 1, 2026?')).toEqual({ kind: 'filed', company: null });
  });

  it('takes a briefing question for a briefing question, never news', () => {
    for (const q of ['Where does Bitcoin stand?', 'Is net liquidity rising or falling?', 'What is the Treasury yield curve doing?', 'How has Bitcoin moved in the last 30 minutes?', 'equities.company/nvda: what were its revenues over the last four quarters?']) expect(newsAsked(q), q).toBeNull();
    // What is to come is a calendar's, not a record of what was published.
    expect(newsAsked('When is the next CPI release?')).toBeNull();
    // CONTROL: the same words about what was released are news.
    expect(newsAsked('When was the CPI release published?')).toEqual({ kind: 'official', company: null });
  });

  it('takes a 10-Q, 10-K, 6-K or 20-F for a briefing question: the news door holds 8-K items only', () => {
    // The recheck of 10-13: "nvda: revenue in its latest 10-Q?" read 8-K items alone, and the
    // company's briefing was never read.
    for (const q of ['equities.company/nvda: revenue in its latest 10-Q?', 'When did equities.company/fxmp file its 10-K?', 'On what date did Fictional Group Corp furnish a Form 6-K?', 'Which filing was its 20-F, and when was it filed?']) expect(newsAsked(q), q).toBeNull();
    // CONTROL: an 8-K is the door's, named in a form or not.
    expect(newsAsked('When did equities.company/fxmp file its Form 8-K?')).toEqual({ kind: 'filed', company: 'equities.company/fxmp' });
    expect(newsAsked('What 8-K items did equities.company/fxmp report?')).toEqual({ kind: 'filed', company: 'equities.company/fxmp' });
  });
});
