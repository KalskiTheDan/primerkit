import { blockFromJson, blockFromMarkdown, type DataBlock, type DataConnector } from '@primerkit/core';
import { METRIC_ID, RefusedRequest, contextUrl, type ContextRequest } from './ids';
import { newsUrl, parseNews, type NewsAnswer, type NewsQuery } from './news';

export const DEFAULT_BASE = 'https://api.prereason.com';

// PreReason's Bitcoin price history begins on this day, and gives at most this many days
// in one call.
export const BITCOIN_HISTORY_START = '2013-04-28';
const HISTORY_DAYS = 1000;
const dayAfter = (day: string, n: number): string => new Date(Date.parse(`${day}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

export type Tier = 'free' | 'basic' | 'pro' | 'enterprise';

// PreReason's refusals of a briefing, a metric or a date the key's tier does not reach.
// The session says "not available on this key's tier" and runs on without that block; a
// refused date keeps PreReason's own words, which name the window the key reads.
const TIER_CODES = new Set(['BRIEFING_RESTRICTED', 'TIER_RESTRICTED', 'DATE_RESTRICTED', 'EARLY_ACCESS_RESTRICTED']);

// Which of the account's limits a rate limit is, where PreReason's answer says: the day's or
// the minute's.
export type RateWindow = 'day' | 'minute';

export class PreReasonError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string | null,
    readonly retryAfterSeconds: number | null = null,
    readonly window: RateWindow | null = null,
  ) {
    super(message);
  }

  get tierRefusal(): boolean {
    return this.code !== null && TIER_CODES.has(this.code);
  }
}

// How long to wait, in words, after PreReason asks primerkit to: its own Retry-After where
// it sent one; else, for a rate limit, tomorrow for the day's limit and a few minutes for
// any other. Null for anything else. The session's ask once said it, and the CLI's digest
// and forward record printed the bare sentence.
export function waitText(error: PreReasonError): string | null {
  const s = error.retryAfterSeconds;
  if (s) return `Try again in about ${s < 90 ? `${Math.ceil(s)} seconds` : s < 90 * 60 ? `${Math.ceil(s / 60)} minutes` : `${Math.ceil(s / 3600)} hours`}.`;
  if (error.status !== 429) return null;
  return error.window === 'day' ? 'Try again tomorrow.' : 'Try again in a few minutes.';
}

// An error as a sentence a person reads, with the wait where PreReason asked for one.
export function withWait(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const wait = error instanceof PreReasonError ? waitText(error) : null;
  return wait ? `${message.replace(/\.$/, '')}. ${wait}` : message;
}

// The news door's own refusals, each said in its own words on screen: a request PreReason
// found invalid (400 INVALID_*), a company it does not cover (404 NOT_COVERED), a company
// whose market's filings it does not read (404 NO_SOURCE), and news it could not read just
// then (503 NEWS_UNAVAILABLE). A refused key, a rate limit or a tier stays a PreReasonError.
export type NewsFailure = 'invalid' | 'not-covered' | 'no-source' | 'unavailable';

export class NewsError extends PreReasonError {
  constructor(
    message: string,
    status: number,
    code: string | null,
    readonly failure: NewsFailure,
    retryAfterSeconds: number | null = null,
  ) {
    super(message, status, code, retryAfterSeconds);
  }
}

export interface ClientOptions {
  key: string | null;
  version: string; // primerkit's own version, for the user agent
  base?: string;
  fetch?: typeof fetch;
  now?: () => Date;
  // PreReason's word on the key, on each answer to a call made with it: false, with what its
  // 401 said, for a dead key or one limited to other addresses; true on an answer it served. A
  // key revoked in PreReason's settings is still a well formed key in its file, so only a call
  // says it is refused; the CLI and the session keep that word.
  onKey?: (accepted: boolean, refusal: KeyWord | null) => void;
}

// Headers every request carries, and nothing else.
export function requestHeaders(version: string, key: string | null): Record<string, string> {
  return {
    Accept: 'application/json, text/markdown',
    'User-Agent': `primerkit/${version}`,
    'X-PreReason-Client': 'primerkit',
    ...(key ? { Authorization: `Bearer ${key}` } : {}),
  };
}

// The account's daily budget, from the headers every data response carries.
export interface DayBudget {
  limit: number;
  remaining: number;
}

export function dayBudgetOf(headers: Headers): DayBudget | null {
  if (!headers.has('x-ratelimit-limit-day') || !headers.has('x-ratelimit-remaining-day')) return null;
  const limit = Number(headers.get('x-ratelimit-limit-day'));
  const remaining = Number(headers.get('x-ratelimit-remaining-day'));
  return Number.isFinite(limit) && Number.isFinite(remaining) ? { limit, remaining } : null;
}

// The account's plan, as PreReason names it in X-PreReason-Tier on every response to a
// keyed REST call, refusals and rate limits included. A keyed call without it names no
// tier: PreReason leaves it off when it could not read the plan, and then serves the call
// as free, so the daily limit beside it is not read as the plan either.
export const TIERS: readonly Tier[] = ['free', 'basic', 'pro', 'enterprise'];

export function tierOf(headers: Headers): Tier | null {
  const named = headers.get('x-prereason-tier')?.trim().toLowerCase();
  return named && (TIERS as readonly string[]).includes(named) ? (named as Tier) : null;
}

export class PreReasonClient implements DataConnector {
  readonly id = 'prereason';
  private readonly base: string;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => Date;
  // The budget as the last data response stated it, for the top line.
  budget: DayBudget | null = null;
  // The tier as the last data response that named one named it; null until one does.
  tier: Tier | null = null;
  // Whether PreReason accepted the key on the last answer to a call made with it: false after
  // a 401 for a dead key, true after an answer it served, null until one of those.
  keyAccepted: boolean | null = null;
  // What PreReason's last 401 said of the key (keyRefusalOf), null after an answer it served.
  refusal: KeyWord | null = null;

  constructor(private readonly options: ClientOptions) {
    this.base = options.base ?? DEFAULT_BASE;
    this.fetchImpl = options.fetch ?? fetch;
    this.now = options.now ?? (() => new Date());
  }

  get hasKey(): boolean {
    return Boolean(this.options.key);
  }

  // A briefing can be read as it stood on a past day (date=); the demo's saved briefings
  // cannot.
  readonly readsDates = true;

  // A company's statement history is read at its own door (contextUrl, history).
  readonly readsHistory = true;

  // What every data response says about the account, read before its status is.
  private note(res: Response, text: string): void {
    this.budget = dayBudgetOf(res.headers) ?? this.budget;
    this.tier = tierOf(res.headers) ?? this.tier;
    if (!this.options.key || (res.status !== 401 && !res.ok)) return;
    this.refusal = res.ok ? null : keyRefusalOf(res.status, text);
    // A 401 that says nothing of the key, or PreReason's own fault checking it, is no word on
    // the key: the next call tries it again.
    if (!res.ok && (!this.refusal || this.refusal.kind === 'unchecked')) return;
    // Only a dead key is refused: a key limited to other addresses is alive, and kept.
    if (res.ok || this.refusal?.kind === 'dead') this.keyAccepted = res.ok;
    this.options.onKey?.(res.ok, this.refusal);
  }

  // One briefing, as a block of numbered lines. Data needs a key; the catalog does not.
  async fetch(source: ContextRequest): Promise<DataBlock> {
    const url = contextUrl(this.base, source);
    const res = await this.fetchImpl(url, { headers: requestHeaders(this.options.version, this.options.key) });
    const text = await res.text();
    this.note(res, text);
    if (!res.ok) throw toError(res, text);
    const fetchedAt = this.now().toISOString();
    return source.format === 'json' ? blockFromJson(source.briefing, text, fetchedAt) : blockFromMarkdown(source.briefing, text, fetchedAt);
  }

  // The Bitcoin price a day, as far back as the key's tier reaches. Oldest first. Each
  // close keeps the source PreReason names for it, with the notice that source's terms ask
  // for, where the answer carries them; the answer's one line for the whole series is not
  // used, since a series can join several sources. PreReason gives at most 1,000 days a
  // call, so a longer range is read in parts: each asks one day past its own end and keeps
  // its own days, so its last day reads as the whole range would read it. Nothing before
  // the history's first day is asked for.
  async bitcoinHistory(range: { from: string; to: string }): Promise<PricePoint[]> {
    for (const d of [range.from, range.to]) if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) throw new PreReasonError(`"${d}" is not a date`, 400, null);
    const points: PricePoint[] = [];
    let start = range.from < BITCOIN_HISTORY_START ? BITCOIN_HISTORY_START : range.from;
    while (start <= range.to) {
      if (dayAfter(start, HISTORY_DAYS - 1) >= range.to) {
        points.push(...(await this.historyPart(start, range.to)));
        break;
      }
      const end = dayAfter(start, HISTORY_DAYS - 2);
      points.push(...(await this.historyPart(start, dayAfter(end, 1))).filter((p) => p.date <= end));
      start = dayAfter(end, 1);
    }
    return points;
  }

  private async historyPart(from: string, to: string): Promise<PricePoint[]> {
    const url = `${this.base}/api/metrics/bitcoin-price/history?from=${from}&to=${to}&limit=${HISTORY_DAYS}`;
    const res = await this.fetchImpl(url, { headers: requestHeaders(this.options.version, this.options.key) });
    const text = await res.text();
    this.note(res, text);
    if (!res.ok) throw toError(res, text);
    const body = JSON.parse(text) as { data?: Array<{ date?: unknown; price?: unknown; source?: unknown }>; sources?: Array<{ name?: unknown; notice?: unknown }> };
    const notices = new Map<string, string>();
    for (const s of body.sources ?? []) if (typeof s.name === 'string' && typeof s.notice === 'string' && s.notice.trim()) notices.set(s.name, s.notice.trim());
    return (body.data ?? [])
      .filter((p): p is { date: string; price: number; source?: unknown } => typeof p.date === 'string' && typeof p.price === 'number' && Number.isFinite(p.price))
      .map((p) => {
        // PreReason writes "Unknown" for a close whose row names no source: that is no source.
        const named = typeof p.source === 'string' ? p.source.trim() : '';
        const source = named && named.toLowerCase() !== 'unknown' ? named : null;
        const notice = source ? notices.get(source) : undefined;
        return { date: p.date, price: p.price, ...(source ? { source } : {}), ...(notice ? { notice } : {}) };
      })
      .sort((a, b) => a.date.localeCompare(b.date));
  }

  // One metric as a block of numbered lines, read from its markdown as it stands now, so
  // an answer cites it as it cites a briefing: [treasury-10y L2]. PreReason serves no
  // metric for a past day.
  async metricBlock(id: string): Promise<DataBlock> {
    if (!METRIC_ID.test(id)) throw new RefusedRequest(`"${id}" is not a metric id`);
    const res = await this.fetchImpl(`${this.base}/api/metrics/${id}`, { headers: { ...requestHeaders(this.options.version, this.options.key), Accept: 'text/markdown' } });
    const text = await res.text();
    this.note(res, text);
    if (!res.ok) throw toError(res, text);
    return blockFromMarkdown(id, text, this.now().toISOString());
  }

  // One metric on its own, as it stands now: its measured changes, and its sentence. The
  // response carries no level as a number, so the level is read from the sentence's own
  // "at <level>" and is null where the sentence does not say it that way.
  async metric(name: string): Promise<SingleMetric> {
    if (!/^[a-z0-9][a-z0-9-]{1,60}$/.test(name)) throw new PreReasonError(`"${name}" is not a metric id`, 400, null);
    // This route answers in markdown when the request also accepts markdown, so it asks
    // for JSON alone.
    const res = await this.fetchImpl(`${this.base}/api/metrics/${name}`, { headers: { ...requestHeaders(this.options.version, this.options.key), Accept: 'application/json' } });
    const text = await res.text();
    this.note(res, text);
    if (!res.ok) throw toError(res, text);
    const body = JSON.parse(text) as { display_name?: string; timestamp?: string; context?: string; trend?: SingleMetric['trend']; reading?: unknown; source?: unknown; notices?: unknown; access?: { served?: unknown } };
    const context = body.context ?? '';
    // A key below the metric's tier is served its latest reading alone, with no changes.
    const latest = body.access?.served === 'latest_reading';
    // What the terms of the value's sources ask to be shown with it, each as served.
    const notices = Array.isArray(body.notices) ? body.notices.flatMap((n) => (typeof n === 'string' && n.trim() ? [n.trim()] : [])) : [];
    return {
      name,
      display: body.display_name ?? name,
      timestamp: body.timestamp ?? null,
      context,
      trend: body.trend ?? {},
      level: levelInSentence(context),
      reading: typeof body.reading === 'string' ? body.reading : readingInSentence(context),
      source: servedSource(body.source),
      ...(notices.length ? { notices } : {}),
      ...(latest ? { readingOnly: true as const } : {}),
      raw: text,
    };
  }

  // PreReason's news: what a company filed, or what was officially published, over a window
  // of days. One call on the key, read fresh each time: neither PreReason nor primerkit keeps
  // a copy, since a record filed minutes ago must show.
  async news(query: NewsQuery): Promise<NewsAnswer> {
    const url = newsUrl(this.base, query);
    const res = await this.fetchImpl(url, { headers: { ...requestHeaders(this.options.version, this.options.key), Accept: 'application/json' } });
    const text = await res.text();
    this.note(res, text);
    if (!res.ok) throw newsErrorOf(res, text);
    const answer = parseNews(text);
    if (!answer) throw new NewsError('PreReason answered with no records to read', res.status, null, 'unavailable');
    return answer;
  }
}

// A refusal of the news door as its kind, where it is one of the door's own.
function newsErrorOf(res: Response, text: string): PreReasonError {
  const error = toError(res, text);
  const failure: NewsFailure | null =
    res.status === 400 && error.code?.startsWith('INVALID_')
      ? 'invalid'
      : res.status === 404 && error.code === 'NOT_COVERED'
        ? 'not-covered'
        : res.status === 404 && error.code === 'NO_SOURCE'
          ? 'no-source'
          : res.status === 503
            ? 'unavailable'
            : null;
  return failure ? new NewsError(error.message, error.status, error.code, failure, error.retryAfterSeconds) : error;
}

export interface PricePoint {
  date: string; // YYYY-MM-DD
  price: number;
  source?: string; // where PreReason says the close came from, such as "Coinbase"
  notice?: string; // what that source's terms ask to be shown with it, such as "Powered by CoinGecko."
}

export interface SingleMetric {
  name: string;
  display: string;
  timestamp: string | null;
  context: string;
  trend: { change_7d?: number; change_7d_available?: boolean; change_30d?: number; change_30d_available?: boolean; change_90d?: number; change_90d_available?: boolean; change_unit?: string };
  level: number | null;
  reading?: string | null; // the value as the answer writes it: "$671.20", "-48,213 contracts"
  source?: string | null; // the source the answer names for the value, as it names it
  notices?: string[]; // what the terms of the value's sources ask to be shown with it, as served: "Source: ..."
  readingOnly?: true; // the latest reading alone: the key's tier is served no changes for it
  raw?: string; // the answer as served, so a chart can keep the reading on this machine
}

// "3M Treasury yield at 4.24%; 7d +2.9% ..." gives 4.24: the first "at <number>" before
// the first semicolon. Anything else gives null rather than a guess.
export function levelInSentence(context: string): number | null {
  const head = context.split(';')[0] ?? '';
  const m = /\bat (-?\d+(?:\.\d+)?)%?$/.exec(head.trim());
  return m?.[1] ? Number(m[1]) : null;
}

// The value as the sentence writes it: everything after its first "at " and before the
// first semicolon. "SPDR S&P 500 ETF Trust (SPY) at $671.20; 7d ..." gives "$671.20".
export function readingInSentence(context: string): string | null {
  const head = (context.split(';')[0] ?? '').trim();
  return /\bat (.+)$/.exec(head)?.[1]?.trim() || null;
}

// PreReason writes "Unknown" where a value's row names no source: that is no source.
function servedSource(source: unknown): string | null {
  const named = typeof source === 'string' ? source.trim() : '';
  return named && named.toLowerCase() !== 'unknown' ? named : null;
}

// What PreReason's 401 says of the key (its auth middleware; every one is INVALID_API_KEY, with
// its reason in message): a dead key, whose bad form, absence, revocation and expiry are all
// "Invalid or expired API key" against key enumeration; a live key limited in PreReason's
// settings to other addresses; or PreReason's own fault checking it. Only a dead key is
// refused (the wording review, 10-15).
export type KeyRefusal = 'dead' | 'address' | 'unchecked';
export interface KeyWord {
  kind: KeyRefusal;
  said: string | null; // PreReason's own word for a dead key, where it is one of DEAD_SAID
}
export const ADDRESS_REFUSED = "PreReason refused the saved key from this machine's address: in PreReason's settings it is limited to other addresses. primerkit keeps it; add this address there, or run primerkit connect prereason for a new key.";
export const KEY_UNCHECKED = 'PreReason could not check the saved key just now. primerkit keeps it and tries again on the next call.';
// The words PreReason answers a dead key with, said beside primerkit's own; no other text of
// its answer is repeated or kept.
export const DEAD_SAID: readonly string[] = ['Invalid or expired API key', 'Invalid API key'];

export function keyRefusalOf(status: number, text: string): KeyWord | null {
  if (status !== 401) return null;
  let body: { error?: unknown; message?: unknown };
  try {
    body = JSON.parse(text) as { error?: unknown; message?: unknown };
  } catch {
    return null;
  }
  if (body?.error !== 'INVALID_API_KEY') return null;
  const message = typeof body.message === 'string' ? body.message : '';
  if (/not in the whitelist|IP not allowed/i.test(message)) return { kind: 'address', said: null };
  if (message === 'API key validation failed') return { kind: 'unchecked', said: null };
  return { kind: 'dead', said: DEAD_SAID.includes(message) ? message : null };
}

function toError(res: Response, text: string): PreReasonError {
  let code: string | null = null;
  let message = `PreReason answered ${res.status}`;
  let window: string | null = null;
  let said = false;
  try {
    const body = JSON.parse(text) as { error?: unknown; code?: unknown; message?: unknown; details?: { tier_access?: unknown } };
    const named = typeof body.error === 'string' ? body.error : typeof body.code === 'string' ? body.code : null;
    code = named;
    if (typeof body.message === 'string') {
      message = body.message;
      said = true;
    }
    if (typeof body.details?.tier_access === 'string') window = body.details.tier_access;
  } catch {
    // a body that is not JSON keeps the status line
  }
  // A rate limit names its window where PreReason's answer says it: its own words ("Daily
  // limit reached"), or no calls left today in its daily headers.
  const limited = res.status === 429 ? rateWindow(said ? message : '', res.headers) : null;
  if (code === 'DATE_RESTRICTED' && said) message = window ? `${message} (${window})` : message;
  else if (code && TIER_CODES.has(code)) message = "not available on this key's tier";
  else if (res.status === 401) {
    const refusal = keyRefusalOf(res.status, text)?.kind;
    message = refusal === 'address' ? ADDRESS_REFUSED : refusal === 'unchecked' ? KEY_UNCHECKED : 'PreReason did not accept the key';
  }
  else if (res.status === 429) message = `PreReason's ${limited === 'day' ? 'daily ' : limited === 'minute' ? 'per-minute ' : ''}rate limit for this account is reached`;
  const retry = Number(res.headers.get('retry-after'));
  return new PreReasonError(message, res.status, code, Number.isFinite(retry) && retry > 0 ? retry : null, limited);
}

function rateWindow(said: string, headers: Headers): RateWindow | null {
  if (/\bminute\b/i.test(said)) return 'minute';
  if (/\b(?:daily|day)\b/i.test(said) || dayBudgetOf(headers)?.remaining === 0) return 'day';
  return null;
}
