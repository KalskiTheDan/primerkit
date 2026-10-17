import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Snapshots } from '@primerkit/core';
import { FixtureConnector, metricsByArea } from '@primerkit/connector-prereason';
import { maker, prLine } from '@primerkit/ui';
import { BENCH_BRIEFINGS, collectDigest } from '../src/index';

// More of the small words.
describe('more of the small words', () => {
  it("compares no briefing of one saved day with itself, and says why, in place of 'No changes since the end of yesterday'", async () => {
    const home = mkdtempSync(join(tmpdir(), 'pk-digest-'));
    const collected = await collectDigest(
      { data: new FixtureConnector(BENCH_BRIEFINGS), snapshots: new Snapshots(join(home, 'snapshots')), home, now: () => new Date('2026-10-07T09:00:00.000Z') },
      { watchlist: ['macro.snapshot', 'btc.context'] },
    );
    expect(collected.since).toBeNull();
    expect(collected.notes).toContain('These briefings are one saved day, so there is nothing to compare them with. With a key, the digest compares each with the day before.');
  });

  it('names no time on a board that has none, in place of the time it was printed', () => {
    const text = (line: ReturnType<typeof prLine>) => line.map(([, s]) => s).join('');
    const t = maker(false);
    // The mark is the " PR " tile, then a space.
    expect(text(prLine(t, 'btc.context, history', ''))).toBe(' PR  btc.context, history');
    expect(text(prLine(t, 'btc.context', '09:05'))).toBe(' PR  btc.context · generated 09:05 UTC');
    expect(text(prLine(t, 'macro.snapshot', '', 'Sep 15, 2026'))).toBe(' PR  macro.snapshot · as it stood on Sep 15, 2026');
    // Plain text has no tile: the two letters, then two spaces, as before.
    expect(text(prLine(maker(true), 'btc.context', '09:05'))).toBe('PR  btc.context | generated 09:05 UTC');
    expect(prLine(t, 'btc.context', '09:05')[0]).toEqual(['pr/prTile', ' PR ']);
  });

  it('names the areas of metrics as the briefing areas are named', () => {
    const areas = metricsByArea([
      { id: 'bitcoin-price', name: 'Bitcoin Price', description: '', category: 'bitcoin' },
      { id: 'ethereum-price', name: 'Ethereum Price', description: '', category: 'eth' },
      { id: 'treasury-10y', name: '10Y', description: '', category: 'macro' },
    ]).map((a) => a.area);
    expect(areas).toEqual(['Bitcoin', 'Ethereum', 'macro']);
  });
});
