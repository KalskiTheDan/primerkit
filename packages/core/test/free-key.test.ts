import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { FREE_PRICE_DAYS, RoutineError, loadOperation, loadRoutine, newRoutine, priceDaysFor, trackRoutine, type ModelAdapter, type RoutineSource } from '../src/index';

// A routine on a free key: a new one had price_days 200 written in, and its first run failed
// at PreReason, since a free key reads the last 30 days.

const here = dirname(fileURLToPath(import.meta.url));
const BASE = loadOperation(join(here, '..', '..', '..', 'operations', 'routine'));
const NOW = () => new Date('2026-10-14T10:00:00.000Z');

// A PreReason that counts what it is asked and has nothing to give.
class Counted implements RoutineSource {
  readonly asked: string[] = [];
  async briefing(id: string): Promise<{ raw: string }> {
    this.asked.push(id);
    throw new Error('not read here');
  }
  async closes(from: string, to: string) {
    this.asked.push(`price ${from} ${to}`);
    return [];
  }
}
// A model that is never reached: a run stopped before the data never asks it.
const model = { id: 'none', label: 'none, local', capabilities: async () => ({ local: true, schemaConstraint: false, contextTokens: null, canRaiseContext: false, format: 'markdown' as const }), complete: async () => ({ text: '' }) } satisfies ModelAdapter;

const made = (priceDays?: number) => {
  const home = mkdtempSync(join(tmpdir(), 'pk-free-routine-'));
  return newRoutine(home, 'wf', priceDays);
};

describe('a new routine on a free key', () => {
  it('reads the days a free key reads, and says why in routine.yaml', () => {
    expect([priceDaysFor('free'), priceDaysFor('basic'), priceDaysFor(null), priceDaysFor(undefined)]).toEqual([28, 200, 200, 200]);
    const free = made(priceDaysFor('free'));
    const yaml = readFileSync(join(free.dir, 'routine.yaml'), 'utf8');
    expect(yaml).toContain('  price_days: 28\n');
    expect(yaml).toContain("A free PreReason key\n  # reads the last 30 days, and a run counts back from yesterday's close, so 28 is the\n  # most it reads.");
    expect(loadRoutine(free.dir).spec.priceDays).toBe(FREE_PRICE_DAYS);
    // CONTROL: any other key keeps the 200 the research view's H4 needs.
    expect(readFileSync(join(made().dir, 'routine.yaml'), 'utf8')).toContain('  price_days: 200\n');
  });
});

describe('a run whose price table a free key cannot read', () => {
  it('stops before any call, with the number to write', async () => {
    const routine = loadRoutine(made().dir);
    writeFileSync(routine.rulesPath, '# Rules\n1. Watch.\n');
    const source = new Counted();
    const error = await trackRoutine({ base: BASE, routine, model, source, format: 'markdown', now: NOW, tier: 'free' }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RoutineError);
    expect((error as RoutineError).file).toBe('routine.yaml');
    expect((error as RoutineError).problems).toEqual(["price_days 200 reaches past what a Free key reads (the last 30 days, and a run counts back from yesterday's close). Write 28 in routine.yaml, or use a Basic key."]);
    expect(source.asked).toEqual([]);
    // CONTROL: a basic key reads it, and 28 on a free key fits: each asks PreReason.
    for (const [tier, days] of [['basic', 200], ['free', 28]] as const) {
      const fits = loadRoutine(made(days).dir);
      const asked = new Counted();
      await trackRoutine({ base: BASE, routine: fits, model, source: asked, format: 'markdown', now: NOW, tier }).catch(() => null);
      expect(asked.asked[0]).toBe(`price ${tier === 'free' ? '2026-09-15' : '2026-03-27'} 2026-10-13`);
    }
  });
});
