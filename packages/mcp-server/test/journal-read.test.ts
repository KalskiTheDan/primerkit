import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Journal, Snapshots, loadOperation } from '@primerkit/core';
import { FixtureConnector, parseCatalog } from '@primerkit/connector-prereason';
import { ASK_DIR, BENCH_BRIEFINGS, DEMO_CATALOG, DIGEST_DIR } from '@primerkit/session';
import { sampleJournal } from '../../core/test/sample-journal';
import { HostRuns, callTool } from '../src/index';

function runs(): HostRuns {
  const home = mkdtempSync(join(tmpdir(), 'pk-jr-'));
  const root = join(home, 'journal');
  sampleJournal(root);
  return new HostRuns({
    ask: loadOperation(ASK_DIR),
    digest: loadOperation(DIGEST_DIR),
    data: () => new FixtureConnector(BENCH_BRIEFINGS),
    catalog: async () => parseCatalog(JSON.parse(readFileSync(DEMO_CATALOG, 'utf8'))),
    tier: () => 'free',
    watchlist: async () => [],
    snapshots: new Snapshots(join(home, 'snapshots')),
    journal: new Journal(root),
    home,
    bench: null,
    routine: null,
    now: () => new Date('2026-10-16T12:00:00Z'),
  });
}

const jsonOf = (r: Awaited<ReturnType<typeof callTool>>) => JSON.parse(r.content[1]!.text) as Record<string, unknown>;

describe('journal_read takes the journal\'s filters (sample data)', () => {
  it('filters by operation, briefing, outcome, day and words, and reads one run whole', async () => {
    const r = runs();
    const ids = async (args: Record<string, unknown>) => ((jsonOf(await callTool(r, 'journal_read', args)).runs as Array<{ run_id: string }>) ?? []).map((x) => x.run_id.slice(-6));
    expect(await ids({})).toEqual(['bbbbbb', 'aaaaaa', 'cccccc']);
    expect(await ids({ operation: 'routine' })).toEqual(['cccccc']);
    expect(await ids({ outcome: 'failed' })).toEqual(['bbbbbb']);
    expect(await ids({ briefing: 'macro.snapshot' })).toEqual(['aaaaaa']);
    expect(await ids({ day: '2026-10-15' })).toEqual(['cccccc']);
    expect(await ids({ search: 'dollar' })).toEqual(['bbbbbb']);
    const none = await callTool(r, 'journal_read', { search: 'nothing like it' });
    expect(none.content[0]!.text).toBe('Nothing in the journal matches "nothing like it".');
    const one = await callTool(r, 'journal_read', { run_id: '20261016T090000Z-aaaaaa' });
    expect(one.content[0]!.text).toContain('Question: Where do Treasury yields stand?');
    expect(jsonOf(one)).toMatchObject({ run_id: '20261016T090000Z-aaaaaa', answer: 'The 10-year yield is 4.02%.', cost: { usd: 0.000175, basis: 'list price' } });
    expect((jsonOf(one).claims as Array<{ citations: Array<{ line_text: string }> }>)[0]!.citations[0]!.line_text).toBe('{"metric":"treasury-10y","value_formatted":"4.02%"}');
  });
});
