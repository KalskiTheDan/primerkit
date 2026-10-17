import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { Journal, keepBench, type BenchResult } from '@primerkit/core';
import { latestBench, shareCardSvg, writeShareCard } from '../src/index';
import { LOCKUP_DARK } from '../src/logo-svg';

const RESULT: BenchResult = {
  model: 'qwen2.5:7b',
  fixtures: '2026-09-25',
  briefings: ['btc.pulse', 'btc.context', 'macro.snapshot', 'cross.correlations', 'btc.grid-stress'],
  arms: [
    { arm: 'markdown', correct: 117, total: 150, accuracy: 0.78, tokens: 820, perThousand: 0.95 },
    { arm: 'json', correct: 135, total: 150, accuracy: 0.9, tokens: 2900, perThousand: 0.31 },
    { arm: 'none', correct: 18, total: 150, accuracy: 0.12, tokens: 310, perThousand: 0.39 },
  ],
  runs: 3,
  answers: 45,
  seconds: 2460,
  best: 'markdown',
  checkedAt: '2026-09-26T14:01:00.000Z',
};

// The texts of the card, in the order they are drawn, with their size and colour.
const texts = (svg: string) => [...svg.matchAll(/<text x="(\d+)" y="(\d+)" fill="([^"]+)" font-size="(\d+)"[^>]*>([^<]*)<\/text>/g)].map(([, x, y, fill, size, words]) => ({ x: Number(x), y: Number(y), fill: fill ?? '', size: Number(size), words: words ?? '' }));

describe('the share card', () => {
  it("draws the person's own result in primerkit's frame", () => {
    const svg = shareCardSvg(RESULT);
    expect(svg).toContain('width="1200" height="675"');
    expect(svg).toContain('<rect width="1200" height="675" fill="#14110F"/>');
    expect(svg).toContain('>qwen2.5:7b</text>');
    expect(svg).toContain("right answers on PreReason's briefings, read three ways");
    expect(svg).toContain('primerkit bench · frozen fixtures of 2026-09-25 · 3 runs each · run on this machine');
    expect(svg).toContain('>PR</text>');
    // primerkit's logo heads the card, drawn from its paths; the old block banner, sand blocks
    // over mahogany lines, is gone.
    expect(svg).toContain(LOCKUP_DARK.paths);
    expect(svg).not.toContain('#935f2d');
  });

  it('draws the same logo as the file in assets/logo', () => {
    const file = readFileSync(fileURLToPath(new URL('../../../assets/logo/primerkit-lockup-dark-mode.svg', import.meta.url)), 'utf8').replace(/\r\n/g, '\n');
    expect(file).toContain(`viewBox="0 0 ${LOCKUP_DARK.width} ${LOCKUP_DARK.height}"`);
    expect(file).toContain(LOCKUP_DARK.paths);
  });

  // The walk of 10-14 found the card leading with markdown's 60% while JSON scored 86%,
  // which the card did not show at all.
  it('shows all three scores side by side, each named, in a fixed order, none drawn larger or apart', () => {
    // JSON scored most here, and markdown gave the most right answers per 1,000 tokens.
    const said = texts(shareCardSvg(RESULT));
    const scores = said.filter((t) => /^\d+%$|^n\/a$/.test(t.words));
    expect(scores.map((t) => t.words)).toEqual(['78%', '90%', '12%']);
    // One size, one colour and one line for the three, left to right.
    expect(new Set(scores.map((t) => `${t.size} ${t.fill} ${t.y}`)).size).toBe(1);
    expect(scores.map((t) => t.x)).toEqual([...scores.map((t) => t.x)].sort((a, b) => a - b));
    // Each is named above its score, in the same fixed order, the same way.
    const names = said.filter((t) => ['markdown', 'JSON', 'no data'].includes(t.words));
    expect(names.map((t) => t.words)).toEqual(['markdown', 'JSON', 'no data']);
    expect(new Set(names.map((t) => `${t.size} ${t.fill} ${t.y}`)).size).toBe(1);
    names.forEach((n, i) => expect(Math.abs(n.x - scores[i]!.x)).toBeLessThan(20));
    // Under each: its count and its cost, the same way for all.
    for (const words of ['117 of 150 right', '135 of 150 right', '18 of 150 right', 'about 82 tokens a question', 'about 290 tokens a question', '0.95 right per 1,000 tokens', '0.31 right per 1,000 tokens', 'no data read']) {
      expect(said.map((t) => t.words)).toContain(words);
    }
    // No score is larger than another, and nothing reads as a winner.
    expect(Math.max(...said.map((t) => t.size))).toBe(scores[0]!.size);
    expect(said.map((t) => t.words).join(' ')).not.toMatch(/best|most|winner|as markdown/i);

    // The order holds whatever scored most, and an arm that did not run is said so in its place.
    const swapped = { ...RESULT, arms: [RESULT.arms[2]!, RESULT.arms[1]!], best: 'json' as const };
    const parts = texts(shareCardSvg(swapped));
    expect(parts.filter((t) => /^\d+%$|^n\/a$/.test(t.words)).map((t) => t.words)).toEqual(['n/a', '90%', '12%']);
    expect(parts.map((t) => t.words)).toContain('not run');
  });

  it('writes a PNG where resvg is installed, and the SVG where it is not', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pk-card-'));
    const png = await writeShareCard(RESULT, dir);
    expect(png).toMatch(/primerkit-bench-20260926-140100\.png$/);
    expect([...readFileSync(png).subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const svg = await writeShareCard(RESULT, mkdtempSync(join(tmpdir(), 'pk-card-')), async () => null);
    expect(svg).toMatch(/\.svg$/);
    expect(readFileSync(svg, 'utf8')).toContain('<svg');
    // Rendering loads the machine's fonts, which is slow on a loaded laptop.
  }, 60_000);

  it('reads the newest benchmark back from the journal', () => {
    const journal = new Journal(mkdtempSync(join(tmpdir(), 'pk-card-')));
    expect(latestBench(journal.root)).toBeNull();
    keepBench(journal, RESULT, [], [], new Map(), new Date('2026-09-26T14:01:00Z'));
    expect(latestBench(journal.root)).toEqual(RESULT);
  });
});
