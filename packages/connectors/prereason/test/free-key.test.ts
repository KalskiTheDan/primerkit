import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { PreReasonClient, PreReasonError, parseCatalog, pickBriefings, readableBy, waitText, withWait, type Pickable } from '../src/index';

// A free key, as the full run of 2026-10-14 met it: the picker read a bare metric where a
// briefing the key reads held its change, and a rate limit said nothing of how long it lasts.

const here = dirname(fileURLToPath(import.meta.url));
const CATALOG = JSON.parse(readFileSync(join(here, 'fixtures', 'catalog-2026-09-26.json'), 'utf8')) as unknown;
const free = readableBy(parseCatalog(CATALOG), 'free');
// Two metrics as PreReason's keyless list names them, shortened.
const METRICS: Pickable[] = [
  { id: 'net-liquidity', name: 'Net Liquidity', description: 'Net liquidity proxy - Fed balance sheet minus reverse repo and Treasury account balances' },
  { id: 'yield-curve', name: 'Yield Curve Spread', description: 'The 10 year less the 2 year Treasury yield' },
];
const entries = [...free, ...METRICS];

// Keys are built here, never written out, and are not real keys.
const fakeKey = (tag: string) => `pr_test_${tag.repeat(20)}`;
const client = (answer: () => Response) => new PreReasonClient({ key: fakeKey('w'), version: '0.1.0', fetch: (async () => answer()) as typeof fetch });
const refusal = (c: PreReasonClient) => c.fetch({ briefing: 'macro.snapshot', format: 'json' }).catch((e: unknown) => e) as Promise<PreReasonError>;

describe('the picker on a key served a metric as its latest reading alone', () => {
  it('reads the free briefing that carries the metric with its changes, for a question about which way it moved', () => {
    // As the full run asked it: net-liquidity alone gave its level, and macro.snapshot, which a
    // free key reads, holds its 7 day change.
    expect(pickBriefings('Is net liquidity rising or falling?', entries, 3, { latestOnly: true })).toEqual({
      ids: ['macro.snapshot'],
      named: [],
      added: [],
      carried: [{ metric: 'net-liquidity', briefing: 'macro.snapshot' }],
    });
    expect(pickBriefings('Is the yield curve steepening?', entries, 3, { latestOnly: true }).ids).toEqual(['macro.snapshot']);
    // CONTROL: a key served the metric's changes reads the metric, its own series.
    expect(pickBriefings('Is net liquidity rising or falling?', entries).ids).toEqual(['net-liquidity']);
    // CONTROL: a question about where it stands is answered by the latest reading.
    expect(pickBriefings('Where is net liquidity now?', entries, 3, { latestOnly: true }).ids).toEqual(['net-liquidity']);
  });

  it('names a briefing that carries the metric for what drives it, never a Bitcoin briefing for a question that names no Bitcoin', () => {
    // The note once said "name btc.quick-check in the question" for net liquidity.
    expect(pickBriefings('Where is net liquidity now?', entries).drivers).toBe('macro.snapshot');
    expect(pickBriefings('Is net liquidity rising or falling?', entries).drivers).toBe('macro.snapshot');
    // CONTROL: where a Bitcoin briefing is the only one that carries it, it is still named.
    expect(pickBriefings('Where is net liquidity now?', [...free.filter((b) => b.id !== 'macro.snapshot'), ...METRICS]).drivers).toBe('btc.quick-check');
  });
});

describe('a rate limit, and how long it lasts', () => {
  it("names the day's limit and the wait PreReason sends", async () => {
    const day = await refusal(client(() => new Response(JSON.stringify({ code: 'RATE_LIMIT_EXCEEDED', message: 'Daily limit reached' }), { status: 429, headers: { 'retry-after': '120' } })));
    expect(day.message).toBe("PreReason's daily rate limit for this account is reached");
    expect(day.window).toBe('day');
    expect(waitText(day)).toBe('Try again in about 2 minutes.');
    expect(withWait(day)).toBe("PreReason's daily rate limit for this account is reached. Try again in about 2 minutes.");
  });

  it('says a wait where PreReason sends none, by the limit its answer names', async () => {
    // No calls left today in the daily headers: the day's limit, so not a few minutes.
    const spent = await refusal(client(() => new Response('{}', { status: 429, headers: { 'x-ratelimit-limit-day': '100', 'x-ratelimit-remaining-day': '0' } })));
    expect([spent.message, waitText(spent)]).toEqual(["PreReason's daily rate limit for this account is reached", 'Try again tomorrow.']);
    const minute = await refusal(client(() => new Response(JSON.stringify({ code: 'RATE_LIMIT_EXCEEDED', message: 'Too many requests per minute' }), { status: 429, headers: { 'x-ratelimit-limit-day': '100', 'x-ratelimit-remaining-day': '18' } })));
    expect([minute.message, waitText(minute)]).toEqual(["PreReason's per-minute rate limit for this account is reached", 'Try again in a few minutes.']);
    // Nothing said of the window: the sentence as before, and a few minutes.
    const bare = await refusal(client(() => new Response('{}', { status: 429 })));
    expect(withWait(bare)).toBe("PreReason's rate limit for this account is reached. Try again in a few minutes.");
    // A long wait is said in hours.
    expect(waitText(new PreReasonError('x', 429, null, 5 * 3600))).toBe('Try again in about 5 hours.');
    // CONTROL: a refusal that is no rate limit asks for no wait.
    const tier = await refusal(client(() => new Response(JSON.stringify({ error: 'BRIEFING_RESTRICTED', message: 'requires pro' }), { status: 403 })));
    expect([waitText(tier), withWait(tier)]).toEqual([null, "not available on this key's tier"]);
  });
});
