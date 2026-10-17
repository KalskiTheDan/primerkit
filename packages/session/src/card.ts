import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BenchResult } from '@primerkit/core';
import { PALETTE } from '@primerkit/ui';
import { journalRows } from './journal-view';
import { LOCKUP_DARK } from './logo-svg';

// The share card: one image of the person's own benchmark result, in primerkit's frame,
// 1200 by 675. It is written on this machine only; nothing uploads, and the person
// decides whether to post it.

const W = 1200;
const H = 675;
const FRAME = '#14110F';
const SAND = PALETTE.pkLetter.hex;
const MUTED = PALETTE.muted.hex;
const AMBER = PALETTE.pr.hex;
const FONT = "Consolas, 'DejaVu Sans Mono', Menlo, 'Liberation Mono', monospace";

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const ARM_NAMES: Record<string, string> = { markdown: 'markdown', json: 'JSON', none: 'no data' };

// primerkit's logo as its files draw it for a dark ground, the mark `size` pixels tall with
// its top left corner at (x, y): paths, so it looks the same whatever fonts the machine has.
function logoSvg(x: number, y: number, size: number): string {
  const s = size / 128;
  return `<g transform="translate(${x - 32 * s} ${y - 32 * s}) scale(${s})">${LOCKUP_DARK.paths}</g>`;
}

// The three ways the briefings are read, always in this order, each drawn the same way.
const CARD_ARMS = ['markdown', 'json', 'none'] as const;
const COLUMN = 360;

// One way of reading as a column: its name, its share right, and what it cost. No column
// is drawn larger or in another colour than the others, whichever scored most.
function armColumn(r: BenchResult, arm: (typeof CARD_ARMS)[number], x: number): string {
  const a = r.arms.find((each) => each.arm === arm);
  const share = a?.accuracy === null || a?.accuracy === undefined ? 'n/a' : `${Math.round(a.accuracy * 100)}%`;
  // Each reading test asks ten questions of one briefing.
  const perQuestion = a?.tokens ? Math.round(a.tokens / 10) : null;
  const cost = arm === 'none' ? 'no data read' : a?.perThousand !== null && a?.perThousand !== undefined ? `${a.perThousand.toFixed(2)} right per 1,000 tokens` : '';
  return [
    `<text x="${x}" y="300" fill="${SAND}" font-size="28">${esc(ARM_NAMES[arm] ?? arm)}</text>`,
    `<text x="${x - 6}" y="420" fill="${AMBER}" font-size="120" font-weight="bold">${share}</text>`,
    a ? `<text x="${x}" y="462" fill="${SAND}" font-size="22">${a.correct} of ${a.total} right</text>` : `<text x="${x}" y="462" fill="${MUTED}" font-size="22">not run</text>`,
    perQuestion ? `<text x="${x}" y="496" fill="${MUTED}" font-size="20">about ${perQuestion.toLocaleString('en-US')} tokens a question</text>` : '',
    a && cost ? `<text x="${x}" y="526" fill="${MUTED}" font-size="20">${cost}</text>` : '',
  ].join('');
}

export function shareCardSvg(r: BenchResult): string {
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="${esc(FONT)}">`,
    `<rect width="${W}" height="${H}" fill="${FRAME}"/>`,
    logoSvg(60, 44, 56),
    `<text x="60" y="126" fill="${MUTED}" font-size="18">financial research on your own model</text>`,
    `<text x="60" y="196" fill="${SAND}" font-size="30">${esc(r.model)}</text>`,
    `<text x="60" y="232" fill="${MUTED}" font-size="20">right answers on PreReason's briefings, read three ways</text>`,
    ...CARD_ARMS.map((arm, i) => armColumn(r, arm, 60 + i * COLUMN)),
    `<line x1="60" y1="588" x2="${W - 60}" y2="588" stroke="${PALETTE.rule.hex}" stroke-width="1"/>`,
    `<text x="60" y="628" fill="${MUTED}" font-size="17">primerkit bench · frozen fixtures of ${esc(r.fixtures)} · ${r.runs} ${r.runs === 1 ? 'run' : 'runs'} each · run on this machine</text>`,
    `<text x="${W - 60}" y="630" fill="${AMBER}" font-size="30" font-weight="bold" text-anchor="end">PR</text>`,
    '</svg>',
  ].join('\n');
}

// The newest benchmark in the journal, run here or inside an AI app.
export function latestBench(journalRoot: string): BenchResult | null {
  const row = journalRows(journalRoot, 500).find((r) => r.operation === 'bench');
  if (!row) return null;
  try {
    return JSON.parse(readFileSync(join(row.dir, 'result.json'), 'utf8')) as BenchResult;
  } catch {
    return null;
  }
}

type Rasterise = (svg: string) => Promise<Buffer | null>;

// A PNG through resvg where it is installed; otherwise the card stays an SVG, which a
// browser opens and saves as an image.
const pngOf: Rasterise = async (svg) => {
  try {
    const { Resvg } = (await import('@resvg/resvg-js')) as { Resvg: new (svg: string, o: object) => { render(): { asPng(): Buffer } } };
    return new Resvg(svg, { fitTo: { mode: 'width', value: W }, font: { loadSystemFonts: true, defaultFontFamily: 'Consolas' } }).render().asPng();
  } catch {
    return null;
  }
};

export async function writeShareCard(r: BenchResult, dir: string, rasterise: Rasterise = pngOf): Promise<string> {
  mkdirSync(dir, { recursive: true });
  const base = `primerkit-bench-${r.checkedAt.slice(0, 19).replace(/[-:]/g, '').replace('T', '-')}`;
  const svg = shareCardSvg(r);
  const svgPath = join(dir, `${base}.svg`);
  writeFileSync(svgPath, svg);
  const png = await rasterise(svg);
  if (!png) return svgPath;
  const pngPath = join(dir, `${base}.png`);
  writeFileSync(pngPath, png);
  return existsSync(pngPath) ? pngPath : svgPath;
}
