import { describe, expect, it } from 'vitest';
import { perfReadme, pickCost, pickSize } from '../scripts/perf';

describe('the speed loops', () => {
  it("prices the pick at Claude Sonnet 5.5's list, read whole and read from the cache", () => {
    // 26,867 tokens in, a 60 token reply: $2 and $0.20 a million in, $10 a million out.
    expect(pickCost(26_867)).toEqual({ usd: 0.0543, usdCached: 0.006 });
    expect(pickCost(0, 0)).toEqual({ usd: 0, usdCached: 0 });
  });

  it("measures the pick's packet on the catalog it is given", () => {
    const entries = [
      { id: 'btc.pulse', name: 'BTC Pulse', description: 'Bitcoin price and dominance' },
      { id: 'treasury-10y', name: '10-Year Treasury Yield', description: 'The 10 year yield' },
    ];
    const size = pickSize('two entries', entries, '2026-10-12');
    expect(size).toMatchObject({ catalog: 'two entries', entries: 2 });
    expect(size.tokens).toBeGreaterThan(100);
    // CONTROL: more entries, more tokens.
    expect(pickSize('more', [...entries, { id: 'gold', name: 'Gold', description: 'The gold price, from the ETF' }], '2026-10-12').tokens).toBeGreaterThan(size.tokens);
  });

  it('writes each loop as a table, and the live one only where it ran', () => {
    const s = { p50: 0.2, p95: 0.5, max: 1 };
    const md = perfReadme('2026-10-12 11:00 UTC', [{ screen: '9. Home', colourMs: s, asciiMs: s, svgMs: s, rasterMs: { p50: 400, p95: 500, max: 510 } }], [{ question: 'Where does Bitcoin stand?', briefings: ['btc.pulse'], json: 2_653, markdown: 1_456, cacheable: 1_241 }], [{ catalog: 'saved', entries: 18, tokens: 1_025, usd: 0.0027, usdCached: 0.0008 }], null);
    expect(md).toContain('| 9. Home | 0.2 / 0.5 / 1 | 0.2 / 0.5 / 1 | 0.2 / 0.5 / 1 | 400 / 500 / 510 |');
    expect(md).toContain('| Where does Bitcoin stand? | btc.pulse | 2,653 | 1,456 | 1,241 |');
    expect(md).toContain('| saved | 18 | 1,025 | $0.0027 | $0.0008 |');
    expect(md).not.toContain('## Live');
    const live = perfReadme('x', [], [], [], { answers: [{ round: 1, question: 'q?', outcome: 'answered', seconds: 9.25, tokens: 2_100, checks: '4 of 4', read: ['macro.snapshot'] }], callsUsed: 4 });
    expect(live).toContain('1 questions, 4 PreReason calls.');
    expect(live).toContain('| 1 | q? | answered | macro.snapshot | 9.3 | 2,100 | 4 of 4 |');
    // A failure says why, so a refused read is not taken for a model that failed its checks.
    const failed = perfReadme('x', [], [], [], { answers: [{ round: 2, question: 'q?', outcome: 'failed', seconds: null, tokens: null, checks: '', read: [], why: "PreReason's rate limit for this account is reached" }], callsUsed: null });
    expect(failed).toContain("| 2 | q? | failed: PreReason's rate limit for this account is reached | - | - | - | - |");
  });
});
