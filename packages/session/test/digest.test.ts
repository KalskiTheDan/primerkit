import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Journal, RunCancelled, Snapshots, blockFromJson, loadOperation, type ModelAdapter, type ModelCapabilities, type Packet } from '@primerkit/core';
import { FixtureConnector, PreReasonError } from '@primerkit/connector-prereason';
import { BENCH_BRIEFINGS, DIGEST_DIR, DigestUnread, collectDigest, readDigestState, renderDigest, runDigest } from '../src/index';

// The digest's edges, found reading the code (2026-10-09).
const DIGEST = loadOperation(DIGEST_DIR);
const NOW = new Date('2026-09-26T08:00:00.000Z');

// Yesterday's macro.snapshot and btc.context, made for these tests from today's saved ones
// by changing one thing in each. They are test data, not PreReason's.
function yesterdayOf(id: string): string {
  const today = JSON.parse(readFileSync(join(BENCH_BRIEFINGS, `${id}.json`), 'utf8')) as { metrics: Record<string, { signal: string; trend?: { direction: string } }> };
  const first = Object.keys(today.metrics)[0] as string;
  today.metrics[first]!.signal = `${today.metrics[first]!.signal}-before`;
  return JSON.stringify(today);
}

// A key's connection: today's saved briefings, a past day as made above, and reads that fail
// for the briefings named in `failing` (a 429, as a busy morning gives).
function keyed(failing: Set<string> = new Set(), past: (id: string) => string = yesterdayOf): FixtureConnector {
  const saved = new FixtureConnector(BENCH_BRIEFINGS);
  const data = Object.create(saved) as FixtureConnector;
  Object.assign(data, {
    readsDates: true,
    fetch: async (req: { briefing: string; format: 'json' | 'markdown'; date?: string }) => {
      if (failing.has(req.briefing)) throw new PreReasonError('Too many requests today', 429, null);
      if (req.date) return blockFromJson(req.briefing, past(req.briefing), `${req.date}T23:59:59.999Z`);
      return saved.fetch(req);
    },
  });
  return data;
}

const WATCH = ['macro.snapshot', 'btc.context'];
const homeDir = () => mkdtempSync(join(tmpdir(), 'pk-digest-'));
const engineOf = (home: string, data: FixtureConnector, model: ModelAdapter | null = null, extra: { signal?: AbortSignal; journal?: Journal } = {}) => ({
  operation: DIGEST,
  model,
  data,
  snapshots: new Snapshots(join(home, 'snapshots')),
  home,
  now: () => NOW,
  ...extra,
});

// A local model that writes one sentence for each item, quoting the metric's key, and that
// can be told to stop the run on a call.
class Writer implements ModelAdapter {
  readonly id = 'writer';
  readonly label = 'writer, local';
  calls = 0;
  constructor(private readonly stopOn: number | null = null, private readonly stop: AbortController | null = null) {}
  async capabilities(): Promise<ModelCapabilities> {
    return { local: true, schemaConstraint: false, contextTokens: null, canRaiseContext: false, format: 'json' };
  }
  async complete(packet: Packet) {
    this.calls += 1;
    if (this.calls === this.stopOn) {
      this.stop?.abort();
      throw new RunCancelled();
    }
    const items = packet.blocks.find((b) => b.id === 'diff')!.lines.map((l) => JSON.parse(l) as { id: string; briefing: string; metric: string; line: number });
    return { text: JSON.stringify({ changes: items.map((i) => ({ item: i.id, text: `${i.metric} changed.`, citations: [{ block: i.briefing, line: i.line, quote: `"metric":"${i.metric}"` }] })) }) };
  }
}

// A local model that writes its first `good` replies as the writer does, and every one after
// as `text`: prose, not JSON, as a small model can, or JSON in the wrong shape.
class Prose extends Writer {
  constructor(
    private readonly good = 0,
    private readonly text = 'Net liquidity turned flat, and the TGA moved above trend.',
  ) {
    super();
  }
  override async complete(packet: Packet) {
    if (this.calls < this.good) return super.complete(packet);
    this.calls += 1;
    return { text: this.text };
  }
}

describe('the digest at its edges', () => {
  it("keeps a briefing's baseline when its read fails, so the next digest still compares with the last", async () => {
    const home = homeDir();
    await runDigest(engineOf(home, keyed()), { watchlist: WATCH });
    const first = readDigestState(home)!;
    expect(Object.keys(first.baselines).sort()).toEqual([...WATCH].sort());
    // A morning on which btc.context could not be read: its baseline stays.
    await runDigest(engineOf(home, keyed(new Set(['btc.context']))), { watchlist: WATCH });
    expect(readDigestState(home)!.baselines['btc.context']).toBe(first.baselines['btc.context']);
  });

  it('says it did not run, and keeps the last state, when none of the watchlist could be read', async () => {
    const home = homeDir();
    await runDigest(engineOf(home, keyed()), { watchlist: WATCH });
    const before = readFileSync(join(home, 'digest', 'state.json'), 'utf8');
    await expect(runDigest(engineOf(home, keyed(new Set(WATCH))), { watchlist: WATCH })).rejects.toThrow(DigestUnread);
    // A rate limit says how long to wait: a few minutes, where PreReason sends no wait.
    await expect(runDigest(engineOf(home, keyed(new Set(WATCH))), { watchlist: WATCH })).rejects.toThrow('none of the watchlist could be read (macro.snapshot could not be read: Too many requests today. Try again in a few minutes)');
    expect(readFileSync(join(home, 'digest', 'state.json'), 'utf8')).toBe(before);
  });

  it('reads a state file of the wrong shape as no state, rather than stopping every morning', async () => {
    for (const bad of ['{}', '{"ran_at":"not a time","baselines":{}}', '[]', '{"ran_at":"2026-09-25T08:00:00Z","baselines":"x"}']) {
      const home = homeDir();
      mkdirSync(join(home, 'digest'), { recursive: true });
      writeFileSync(join(home, 'digest', 'state.json'), bad);
      const view = await runDigest(engineOf(home, keyed()), { watchlist: WATCH });
      expect(view.since).toBe('the end of 2026-09-25 UTC');
    }
  });

  it('reads the end of yesterday in place of a snapshot cut short, every time', async () => {
    const home = homeDir();
    await runDigest(engineOf(home, keyed()), { watchlist: WATCH });
    // The snapshot the next digest compares macro.snapshot with, cut short.
    const dir = join(home, 'snapshots', 'macro.snapshot');
    const kept = readDigestState(home)!.baselines['macro.snapshot'] as string;
    const file = readdirSync(dir).find((f) => f.startsWith(kept.replace(/:/g, '-')))!;
    writeFileSync(join(dir, file), '{"metrics": {"net-liq');
    const view = await runDigest(engineOf(home, keyed()), { watchlist: WATCH });
    expect(view.briefings).toEqual(WATCH);
  });

  it('writes a snapshot whole or not at all', () => {
    const home = homeDir();
    const snapshots = new Snapshots(join(home, 'snapshots'));
    const block = blockFromJson('macro.snapshot', '{"metrics":{}}', '2026-09-26T08:00:00.000Z');
    const path = snapshots.save({ ...block, generatedAt: '2026-09-26T07:00:00.000Z' }) as string;
    expect(readFileSync(path, 'utf8')).toBe('{"metrics":{}}');
    // Written once: a second save of the same time leaves the first.
    snapshots.save({ ...block, raw: '{"metrics":{"other":1}}', generatedAt: '2026-09-26T07:00:00.000Z' });
    expect(readFileSync(path, 'utf8')).toBe('{"metrics":{}}');
    expect(readdirSync(join(home, 'snapshots', 'macro.snapshot'))).toEqual([path.split(/[\\/]/).pop()]);
  });

  it("compares a keyed briefing that reads back the same with yesterday, and keeps the saved day's note for the demo", async () => {
    const same = (id: string) => readFileSync(join(BENCH_BRIEFINGS, `${id}.json`), 'utf8');
    const c = await collectDigest(engineOf(homeDir(), keyed(new Set(), same)), { watchlist: WATCH });
    expect(c.since).toBe('the end of 2026-09-25 UTC');
    expect(c.notes.join(' ')).not.toContain('one saved day');
    expect(c.items).toEqual([]);
    // CONTROL: the demo's saved day still says why it compares nothing.
    const demo = await collectDigest(engineOf(homeDir(), new FixtureConnector(BENCH_BRIEFINGS)), { watchlist: WATCH });
    expect(demo.notes.join(' ')).toContain('These briefings are one saved day');
  });

  it('says a packet that was not sent was not sent, and counts no checks for it', async () => {
    const home = homeDir();
    const small = { ...DIGEST, spec: { ...DIGEST.spec, data: { ...DIGEST.spec.data, maxPacketTokens: 50 } } };
    const view = await runDigest({ ...engineOf(home, keyed(), new Writer()), operation: small }, { watchlist: WATCH });
    expect(view.checks).toBeNull();
    expect(view.notes.join(' ')).toMatch(/The packet for macro\.snapshot was not sent to the model: /);
    expect(renderDigest(view)).not.toContain('0 of');
  });

  it('names only the format check for a reply that is not JSON, and counts no check that did not run', async () => {
    // The recheck (10-13): such a reply read "0 of 6 checks: the answer's format is wrong ·
    // … · advice words appear · …", though no check found advice words; five never ran.
    const home = homeDir();
    const journal = new Journal(join(home, 'journal'));
    const view = await runDigest(engineOf(home, keyed(), new Prose(), { journal }), { watchlist: WATCH });
    const line = "✗ 0 of 1 checks: the answer's format is wrong, so the other checks did not run on it";
    expect(view.checks).toEqual({ passed: 0, total: 1, ran: [{ id: 'schema', ok: false, reasons: ['format'] }] });
    // What `primerkit run digest` prints, and the summary the journal keeps.
    const printed = renderDigest(view);
    expect(printed).toContain(line);
    expect(printed).not.toMatch(/advice words|in the diff|cite its line|of 6 checks/);
    const root = join(home, 'journal');
    const summary = readdirSync(root).flatMap((day) => readdirSync(join(root, day, 'digest')).filter((r) => r.endsWith('-summary')).map((r) => join(root, day, 'digest', r)))[0]!;
    expect(readFileSync(join(summary, 'render.md'), 'utf8')).toContain(line);
    // One packet a briefing for a local model: where one reply was JSON and the other not, a
    // check that ran on only the one is neither named nor counted, and the line says so.
    const half = await runDigest(engineOf(homeDir(), keyed(), new Prose(1)), { watchlist: WATCH });
    expect(renderDigest(half)).toContain(line);
    // JSON in the wrong shape is held to its format alone, as prose is (the review of 10-14):
    // it never reads more than 0 of 1, however the shape is wrong.
    for (const shape of ['{"changes":"Net liquidity turned flat."}', '{"changes":[],"summary":"Net liquidity turned flat."}', '{"changes":[{"item":"x","text":"Net liquidity turned flat."}]}', '[]', '42']) {
      const wrong = await runDigest(engineOf(homeDir(), keyed(), new Prose(0, shape)), { watchlist: WATCH });
      expect(wrong.checks, shape).toEqual({ passed: 0, total: 1, ran: [{ id: 'schema', ok: false, reasons: ['format'] }] });
      expect(renderDigest(wrong), shape).toContain(line);
    }
    // CONTROL: replies that are JSON run all seven checks, and the line names each.
    const whole = await runDigest(engineOf(homeDir(), keyed(), new Writer()), { watchlist: WATCH });
    expect(whole.checks).toMatchObject({ passed: 7, total: 7 });
    expect(renderDigest(whole)).toContain('✓ 7 of 7 checks: answer format · claims cite their lines');
  });

  it('takes out the walk\'s "up 2.5% over 7 days", said of a line whose 7 day change is a fall, and says the item as the diff states it', async () => {
    // The walk of 2026-10-14 printed "Bitcoin price turned bullish, up 2.5% over 7 days" under
    // "6 of 6 checks", citing a line whose 7 day change was -2.5% (falling). Today and the day
    // before are made for the test from the saved btc.context: the price's signal turned
    // bullish from neutral, and its 7 day change is a fall. Test data, not PreReason's.
    type Served = { metrics: Record<string, { signal: string; context: string; trend: { direction: string; change_7d: number } }> };
    const today = JSON.parse(readFileSync(join(BENCH_BRIEFINGS, 'btc.context.json'), 'utf8')) as Served;
    const price = today.metrics['bitcoin-price']!;
    price.context = 'BTC at $84,512.32; 7d -2.5% (falling).';
    price.trend.direction = 'falling';
    price.trend.change_7d = -2.53;
    const before = JSON.parse(JSON.stringify(today)) as Served;
    before.metrics['bitcoin-price']!.signal = 'neutral';
    const data = Object.create(new FixtureConnector(BENCH_BRIEFINGS)) as FixtureConnector;
    Object.assign(data, {
      readsDates: true,
      fetch: async (req: { briefing: string; date?: string }) => blockFromJson(req.briefing, JSON.stringify(req.date ? before : today), req.date ? `${req.date}T23:59:59.999Z` : NOW.toISOString()),
    });
    // A local model that writes the walk's sentence for the price, and is told what failed.
    class Walk extends Writer {
      readonly repairs: Array<string[] | undefined> = [];
      constructor(private readonly move: string) {
        super();
      }
      override async complete(packet: Packet, repair?: Array<{ message: string }>) {
        this.repairs.push(repair?.map((f) => f.message));
        const items = packet.blocks.find((b) => b.id === 'diff')!.lines.map((l) => JSON.parse(l) as { id: string; briefing: string; line: number });
        return { text: JSON.stringify({ changes: items.map((i) => ({ item: i.id, text: `Bitcoin price turned bullish, ${this.move} over 7 days.`, citations: [{ block: i.briefing, line: i.line, quote: 'bullish' }] })) }) };
      }
    }
    const walk = new Walk('up 2.5%');
    const view = await runDigest(engineOf(homeDir(), data, walk), { watchlist: ['btc.context'] });
    const printed = renderDigest(view);
    expect(view.changes).toHaveLength(1);
    expect(printed).not.toContain('up 2.5%');
    expect(printed).toContain("- ◆ Bitcoin price's signal moved from neutral to bullish, as the diff states it [1].");
    expect(printed).toContain('✗ 6 of 7 checks: a direction the cited lines do not hold · 1 said as the diff states it');
    // The repair turn told the model why, in the words the wording review cleared.
    expect(walk.repairs[1]).toContain('"up 2.5%" is a direction the lines this claim cites do not hold: the change they state is a fall');
    // CONTROL: the same change said the way its line runs passes all seven checks.
    const fell = await runDigest(engineOf(homeDir(), data, new Walk('down 2.5%')), { watchlist: ['btc.context'] });
    expect(renderDigest(fell)).toContain('Bitcoin price turned bullish, down 2.5% over 7 days');
    expect(renderDigest(fell)).toContain('✓ 7 of 7 checks');
  });

  it('keeps nothing in the journal from a digest stopped part way, as one stopped run keeps nothing', async () => {
    const home = homeDir();
    const journal = new Journal(join(home, 'journal'));
    const stop = new AbortController();
    // A local model writes one packet a briefing; it is stopped on the second.
    await expect(runDigest(engineOf(home, keyed(), new Writer(2, stop), { signal: stop.signal, journal }), { watchlist: WATCH })).rejects.toThrow(RunCancelled);
    expect(existsSync(join(home, 'journal'))).toBe(false);
    // CONTROL: run to its end, both runs and the summary are kept.
    await runDigest(engineOf(home, keyed(), new Writer(), { journal }), { watchlist: WATCH });
    const root = join(home, 'journal');
    const runs = readdirSync(root).flatMap((day) => (existsSync(join(root, day, 'digest')) ? readdirSync(join(root, day, 'digest')) : []));
    expect(runs).toHaveLength(3);
  });
});
