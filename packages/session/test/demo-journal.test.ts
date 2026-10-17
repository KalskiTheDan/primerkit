import { readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { BRIEF_DAYS, DEMO_DAY, DEMO_JOURNAL, demoDeps, journalLevels } from '../src/index';

// The demo's board draws its 30 days from macro.snapshot as it stood on each of the 29 days
// before its own day, read on the same free key, and the demo still keeps nothing.
describe("the demo's journal", () => {
  it('holds macro.snapshot for each of the 30 days that end on the demo day, one file a day', () => {
    const files = readdirSync(`${DEMO_JOURNAL}/macro.snapshot`).filter((f) => f.endsWith('.json'));
    expect(files).toHaveLength(BRIEF_DAYS);
    const { snapshots } = demoDeps({ version: '0.0.0' });
    const kept = journalLevels(snapshots, 'macro.snapshot', BRIEF_DAYS, DEMO_DAY);
    expect(kept.days[0]).toBe('2026-09-17');
    expect(kept.days.at(-1)).toBe(DEMO_DAY);
    expect(kept.kept).toBe(BRIEF_DAYS);
    // Every day gives net liquidity a level, so its bars draw on every row of the column.
    expect(kept.levels.get('net-liquidity')?.every((v) => v !== null)).toBe(true);
  });

  it('is read and never written, so the demo keeps nothing', () => {
    const { snapshots, demo } = demoDeps({ version: '0.0.0' });
    expect(demo?.day).toBe(DEMO_DAY);
    const block = { id: 'macro.snapshot', source: 'prereason', format: 'json' as const, fetchedAt: '2026-10-17T09:00:00.000Z', generatedAt: '2026-10-17T09:00:00.000Z', lines: [], raw: '{}' };
    expect(snapshots?.save(block)).toBeNull();
    expect(readdirSync(`${DEMO_JOURNAL}/macro.snapshot`).some((f) => f.startsWith('2026-10-17'))).toBe(false);
  });
});
