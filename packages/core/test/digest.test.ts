import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { blockFromJson, buildPacket, diffBlock, diffBriefing, itemSentence, loadOperation, metricName, numberItems, runChecks, runOperation, type ModelAdapter } from '../src/index';

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = join(here, '..', '..', '..');
const DIGEST = loadOperation(join(ROOT, 'operations', 'digest'));
const TODAY = readFileSync(join(ROOT, 'operations', 'bench-comprehension', 'briefings-2026-09-25', 'macro.snapshot.json'), 'utf8');
const now = blockFromJson('macro.snapshot', TODAY, '2026-09-26T08:00:00.000Z');

// Yesterday, made for the test from today's briefing: net liquidity was rising, the TGA's
// signal was at-trend, an extra metric was served, and the data quality was degraded.
// Test data, not PreReason's.
function yesterday(): string {
  const b = JSON.parse(TODAY) as { metrics: Record<string, { signal: string; trend: { direction: string }; value_formatted?: string }>; data_quality: { severity: string } };
  b.metrics['net-liquidity']!.trend.direction = 'rising';
  b.metrics['tga']!.signal = 'at-trend';
  b.metrics['old-metric'] = { signal: 'neutral', trend: { direction: 'flat' }, value_formatted: '1.0' };
  b.data_quality.severity = 'degraded';
  return JSON.stringify(b);
}

describe("the digest's diff", () => {
  it('finds each moved signal, turned direction, missing metric and quality change, and nothing else', () => {
    const { items, same } = diffBriefing('macro.snapshot', yesterday(), now);
    expect(items.map((i) => `${i.kind} ${i.metric} ${i.from}>${i.to}`)).toEqual([
      'signal tga at-trend>above-trend',
      'direction net-liquidity rising>flat',
      'missing old-metric 1.0>null',
      'quality null degraded>ok',
    ]);
    expect(same).toContain('fed-balance');
    expect(same).not.toContain('tga');
    const tga = items[0]!;
    expect(now.lines[tga.line - 1]).toMatch(/^\{"metric":"tga"/);
  });

  it('finds nothing to compare without a baseline', () => {
    expect(diffBriefing('macro.snapshot', null, now)).toEqual({ items: [], same: [] });
  });

  it('says an item in words when no model sentence covers it', () => {
    const [signal, direction] = numberItems(diffBriefing('macro.snapshot', yesterday(), now).items);
    expect(itemSentence(signal!)).toBe("TGA's signal moved from at-trend to above-trend.");
    expect(itemSentence(direction!)).toBe('Net liquidity turned flat, from rising.');
    expect(metricName('treasury-10y')).toBe('Treasury 10Y');
    expect(metricName('m2-supply')).toBe('M2 supply');
    // PreReason's dxy is the dollar fund's share price, UUP, never the Dollar Index.
    expect(metricName('dxy')).toBe('UUP');
  });
});

describe("the digest's checks", () => {
  const items = numberItems(diffBriefing('macro.snapshot', yesterday(), now).items).slice(0, 2);
  const packet = buildPacket({ operation: DIGEST, question: 'What changed?', blocks: [diffBlock(items, now.fetchedAt), now] });
  const change = (item: string, line: number, quote = '"metric"') => ({ item, text: 'It changed.', citations: [{ block: 'macro.snapshot', line, quote }] });
  const failures = (response: unknown) => runChecks(DIGEST, packet, response).flatMap((r) => r.failures);

  it('pass a digest that writes every item, citing its line', () => {
    expect(failures({ changes: items.map((i) => change(i.id, i.line)) })).toEqual([]);
  });

  it('fail a change that is not in the diff, or cites another line', () => {
    const invented = failures({ changes: [change('d1', items[0]!.line), change('d2', items[1]!.line), change('d9', 1)] });
    expect(invented).toContainEqual({ check: 'in_diff', claim: 2, message: 'd9 is not an item of the diff' });
    const wrongLine = failures({ changes: [change('d1', 1, '"briefing"'), change('d2', items[1]!.line)] });
    expect(wrongLine).toContainEqual(expect.objectContaining({ check: 'in_diff', claim: 0 }));
  });

  it('hold a direction to the line a change cites, or to its diff item where code found a move', () => {
    const all = numberItems(diffBriefing('macro.snapshot', yesterday(), now).items);
    const full = buildPacket({ operation: DIGEST, question: 'What changed?', blocks: [diffBlock(all, now.fetchedAt), now] });
    const said = (item: string, text: string) => {
      const at = all.find((i) => i.id === item)!;
      return { item, text, citations: [{ block: 'macro.snapshot', line: at.line, quote: '"data_quality"' }] };
    };
    const directions = (changes: unknown[]) => runChecks(DIGEST, full, { changes }).flatMap((r) => r.failures).filter((f) => f.check === 'grounded_directions');
    // d4 moved from degraded to ok: the data quality line states no change, its item does.
    expect(all[3]).toMatchObject({ id: 'd4', kind: 'quality', from: 'degraded', to: 'ok' });
    expect(directions([said('d4', "macro.snapshot's data quality is improving, from degraded to ok.")])).toEqual([]);
    // CONTROL: d3 went missing, which is no move from one state to another, so its line must
    // hold the direction, and the data quality line does not.
    expect(all[2]).toMatchObject({ id: 'd3', kind: 'missing', to: null });
    expect(directions([said('d4', 'Data quality moved.'), said('d3', 'Old metric is falling out of macro.snapshot.')])).toEqual([
      { check: 'grounded_directions', claim: 1, message: '"falling" is a direction the lines this claim cites do not hold: none of them states a change' },
    ]);
    // A metric's own line states its trend, so a direction cited to it holds.
    const tga = all[0]!;
    expect(directions([{ item: tga.id, text: "The TGA's signal moved to above-trend, rising 11.41% over 7 days.", citations: [{ block: 'macro.snapshot', line: tga.line, quote: '"metric":"tga"' }] }])).toEqual([]);
  });

  // The walk of 2026-10-14: "Bitcoin price turned bullish, up 2.5% over 7 days" passed every
  // check, its item a signal that moved, its line's 7 day change a fall.
  it("hold a move said with its figure to its line's sign, even where the item moved", () => {
    const all = numberItems(diffBriefing('macro.snapshot', yesterday(), now).items);
    const full = buildPacket({ operation: DIGEST, question: 'What changed?', blocks: [diffBlock(all, now.fetchedAt), now] });
    const directions = (changes: unknown[]) => runChecks(DIGEST, full, { changes }).flatMap((r) => r.failures).filter((f) => f.check === 'grounded_directions');
    // d1: the TGA's signal moved from at-trend to above-trend; its line's 7 day change is +11.41.
    const tga = all[0]!;
    expect(tga).toMatchObject({ kind: 'signal', from: 'at-trend', to: 'above-trend' });
    const said = (text: string) => ({ item: tga.id, text, citations: [{ block: 'macro.snapshot', line: tga.line, quote: '"metric":"tga"' }] });
    expect(directions([said("The TGA's signal moved to above-trend, down 11.41% over 7 days.")])).toEqual([
      { check: 'grounded_directions', claim: 0, message: '"down 11.41%" is a direction the lines this claim cites do not hold: the change they state is a rise' },
    ]);
    expect(directions([said("The TGA's signal moved to above-trend, after an 11.41% fall over 7 days.")]).map((f) => f.message)).toEqual(['"11.41% fall" is a direction the lines this claim cites do not hold: the change they state is a rise']);
    expect(directions([said("The TGA's signal moved to above-trend, falling 11.41% over 7 days.")]).map((f) => f.message)).toEqual(['"falling" is a direction the lines this claim cites do not hold: the change they state is a rise']);
    // CONTROL: the move the way its line runs passes, and the item's move is still enough for a
    // word said alone, which may say where the item moved from.
    expect(directions([said("The TGA's signal moved to above-trend, up 11.41% over 7 days.")])).toEqual([]);
    expect(directions([said("The TGA's signal moved to above-trend, from falling.")])).toEqual([]);
    // A line that states no change gives no sign to hold a move to: the item's move is the change.
    const quality = all[3]!;
    expect(directions([{ item: quality.id, text: "macro.snapshot's data quality moved from degraded to ok, up 2 points.", citations: [{ block: 'macro.snapshot', line: quality.line, quote: '"data_quality"' }] }])).toEqual([]);
  });

  it('mark an item left out softly, so the digest stands and says what it missed', async () => {
    const missed = failures({ changes: [change('d1', items[0]!.line)] });
    expect(missed).toEqual([{ check: 'coverage', message: 'd2 has no change', soft: true }]);
    const model: ModelAdapter = {
      id: 'x',
      label: 'x',
      capabilities: async () => ({ local: true, schemaConstraint: true, contextTokens: null, canRaiseContext: false, format: 'json' }),
      complete: async () => ({ text: JSON.stringify({ changes: [change('d1', items[0]!.line)] }) }),
    };
    const result = await runOperation({ operation: DIGEST, question: 'What changed?', blocks: [diffBlock(items, now.fetchedAt), now], model });
    expect(result.outcome).toBe('partial');
    expect(result.attempts).toBe(2);
    expect((result.response as unknown as { changes: unknown[] }).changes).toHaveLength(1);
  });
});
