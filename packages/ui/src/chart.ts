import type { Line, Maker } from './segments';

// Charts in text. Lines are fine braille dots, two by four to a character, so a line
// has no square steps; a line to compare with is dotted lighter, one dot in two; round
// points mark the values the text names. Sparklines run from a quarter cell to seven
// eighths, so no day draws as a hairline. Each has a plain version in ASCII for the old
// console and for pipes: `*` for a line, `.` for the one compared, `o` for a point.

// Monotone cubic interpolation (Fritsch and Carlson): the curve passes through every
// point and never overshoots between two, so it invents no high or low.
export function monotoneCubic(xs: number[], ys: number[]): (x: number) => number {
  const n = xs.length;
  if (n < 2) return () => ys[0] ?? 0;
  const d = xs.slice(1).map((x, i) => (ys[i + 1]! - ys[i]!) / (x - xs[i]!));
  const m = xs.map((_, i) => (i === 0 ? d[0]! : i === n - 1 ? d[n - 2]! : d[i - 1]! * d[i]! <= 0 ? 0 : (d[i - 1]! + d[i]!) / 2));
  for (let i = 0; i < n - 1; i += 1) {
    if (d[i] === 0) {
      m[i] = 0;
      m[i + 1] = 0;
      continue;
    }
    const a = m[i]! / d[i]!;
    const b = m[i + 1]! / d[i]!;
    const s = a * a + b * b;
    if (s > 9) {
      const tau = 3 / Math.sqrt(s);
      m[i] = tau * a * d[i]!;
      m[i + 1] = tau * b * d[i]!;
    }
  }
  return (x) => {
    let i = 0;
    while (i < n - 2 && x > xs[i + 1]!) i += 1;
    const h = xs[i + 1]! - xs[i]!;
    const t = Math.min(1, Math.max(0, (x - xs[i]!) / h));
    const t2 = t * t;
    const t3 = t2 * t;
    return (2 * t3 - 3 * t2 + 1) * ys[i]! + (t3 - 2 * t2 + t) * h * m[i]! + (-2 * t3 + 3 * t2) * ys[i + 1]! + (t3 - t2) * h * m[i + 1]!;
  };
}

const BRAILLE_BITS = [
  [0x01, 0x08],
  [0x02, 0x10],
  [0x04, 0x20],
  [0x40, 0x80],
];

// A grid of dots, two across and four down to a character.
class Dots {
  readonly bits: number[];

  constructor(readonly w: number, readonly h: number) {
    this.bits = new Array<number>(w * h).fill(0);
  }

  set(px: number, py: number): void {
    if (px < 0 || py < 0 || px >= this.w * 2 || py >= this.h * 4) return;
    const i = Math.floor(py / 4) * this.w + Math.floor(px / 2);
    this.bits[i] = (this.bits[i] ?? 0) | BRAILLE_BITS[py % 4]![px % 2]!;
  }

  // A straight run from one dot to the next; `every` 2 keeps one dot in two.
  line(x0: number, y0: number, x1: number, y1: number, every = 1, from = 0): number {
    const dx = Math.abs(x1 - x0);
    const dy = -Math.abs(y1 - y0);
    const sx = x0 < x1 ? 1 : -1;
    const sy = y0 < y1 ? 1 : -1;
    let err = dx + dy;
    let n = from;
    let x = x0;
    let y = y0;
    for (;;) {
      if (n % every === 0) this.set(x, y);
      n += 1;
      if (x === x1 && y === y1) return n;
      const e2 = 2 * err;
      if (e2 >= dy) {
        err += dy;
        x += sx;
      }
      if (e2 <= dx) {
        err += dx;
        y += sy;
      }
    }
  }
}

export interface ChartSeries {
  points: Array<[x: number, y: number]>;
  style: 'main' | 'compare';
  smooth?: boolean; // through the points by monotone cubic interpolation
}

export interface LineChartOptions {
  series: ChartSeries[];
  points: Array<{ x: number; y: number }>; // round points on the values the text names
  width: number; // the plot, in characters
  height: number; // the plot, in rows
  xRange: [number, number];
  yRange?: [number, number];
  yLabel: (value: number) => string;
  xTicks: Array<{ x: number; label: string }>;
  gutter?: number; // the width of the labels on the left
  // Names written right of the plot, each on the row of its value, so lines that share one
  // look can be told apart; two that would share a row take the nearest free one.
  ends?: Array<{ y: number; text: string; role?: string }>;
  plain: boolean;
}

// A line chart: rows of the plot with their labels, then the axis and the tick labels.
export function lineChart(t: Maker, chart: LineChartOptions): Line[] {
  // A point that is not a number is left out, and a chart with none is drawn empty on a
  // scale of 0 to 1, rather than stopping on a dot it cannot place.
  const finite = (x: number, y: number) => Number.isFinite(x) && Number.isFinite(y);
  const o = { ...chart, series: chart.series.map((s) => ({ ...s, points: s.points.filter(([x, y]) => finite(x, y)) })), points: chart.points.filter((p) => finite(p.x, p.y)), ...(chart.ends ? { ends: chart.ends.filter((e) => Number.isFinite(e.y)) } : {}) };
  const ys = [...o.series.flatMap((s) => s.points.map((p) => p[1])), ...o.points.map((p) => p.y)];
  let [y0, y1] = o.yRange ?? (ys.length ? [Math.min(...ys), Math.max(...ys)] : [0, 1]);
  if (y1 === y0) {
    y0 -= Math.abs(y0) * 0.05 || 1;
    y1 += Math.abs(y1) * 0.05 || 1;
  } else if (!o.yRange) {
    const padBy = (y1 - y0) * 0.08;
    y0 -= padBy;
    y1 += padBy;
  }
  const [x0, x1] = o.xRange;
  const W = o.width;
  const H = o.height;
  const px = (x: number) => Math.round(((x - x0) / (x1 - x0 || 1)) * (W * 2 - 1));
  const py = (y: number) => Math.round(((y1 - y) / (y1 - y0)) * (H * 4 - 1));
  const main = new Dots(W, H);
  const compare = new Dots(W, H);
  for (const s of o.series) {
    const dots = s.style === 'main' ? main : compare;
    const every = s.style === 'main' ? 1 : 2;
    const sorted = [...s.points].sort((a, b) => a[0] - b[0]);
    let path: Array<[number, number]>;
    if (s.smooth && sorted.length > 2) {
      const f = monotoneCubic(sorted.map((p) => p[0]), sorted.map((p) => p[1]));
      const first = px(sorted[0]![0]);
      const last = px(sorted.at(-1)![0]);
      path = [];
      for (let c = first; c <= last; c += 1) path.push([c, py(f(x0 + (c / (W * 2 - 1)) * (x1 - x0)))]);
    } else {
      path = sorted.map((p) => [px(p[0]), py(p[1])]);
    }
    let n = 0;
    for (let i = 1; i < path.length; i += 1) n = dots.line(path[i - 1]![0], path[i - 1]![1], path[i]![0], path[i]![1], every, n) - 1;
    if (path.length === 1) dots.set(path[0]![0], path[0]![1]);
  }
  const marks = new Set(o.points.map((p) => Math.floor(py(p.y) / 4) * W + Math.floor(px(p.x) / 2)));
  // A row's label names the value at the middle of its row, on every other row, except
  // where it would read the same as the label above it, as a tall chart over a narrow
  // range could. The gutter is as wide as the widest label drawn: the padded ends of the
  // range are never labelled, and below zero one of them once widened it to eleven columns.
  const valueAt = (r: number) => y1 - ((r + 0.5) / H) * (y1 - y0);
  const gutter = o.gutter ?? Math.max(0, ...Array.from({ length: H }, (_, r) => r).filter((r) => r % 2 === 0).map((r) => o.yLabel(valueAt(r)).length));
  const rows: Line[] = [];
  let above = '';
  for (let r = 0; r < H; r += 1) {
    const text = r % 2 === 0 ? o.yLabel(valueAt(r)) : '';
    const labelled = text !== '' && text !== above;
    if (labelled) above = text;
    const row: Line = [t('dim', (labelled ? text : '').padStart(gutter)), t('rule', labelled ? ' ┤' : ' │', labelled ? ' +' : ' |')];
    for (let c = 0; c < W; c += 1) {
      const i = r * W + c;
      if (marks.has(i)) row.push(t('bright', '●', 'o'));
      else if (main.bits[i]) row.push(t('chart', String.fromCharCode(0x2800 | main.bits[i]! | compare.bits[i]!), '*'));
      else if (compare.bits[i]) row.push(t('dim', String.fromCharCode(0x2800 | compare.bits[i]!), '.'));
      else row.push(t('fg', ' '));
    }
    rows.push(row);
  }
  const taken = new Set<number>();
  for (const end of [...(o.ends ?? [])].sort((a, b) => b.y - a.y)) {
    const at = Math.min(H - 1, Math.max(0, Math.floor(py(end.y) / 4)));
    const free = Array.from({ length: H * 2 }, (_, k) => at + (k % 2 ? -(k + 1) / 2 : k / 2)).find((r) => r >= 0 && r < H && !taken.has(r));
    if (free === undefined) continue;
    taken.add(free);
    rows[free]!.push(t(end.role ?? 'muted', ` ${end.text}`));
  }
  const axis = Array.from({ length: W }, () => '─');
  const labels = Array.from({ length: W + 12 }, () => ' ');
  for (const tick of o.xTicks) {
    const c = Math.min(W - 1, Math.floor(px(tick.x) / 2));
    axis[c] = '┬';
    const start = Math.max(0, Math.min(W + 12 - tick.label.length, c - Math.floor(tick.label.length / 2)));
    Array.from(tick.label).forEach((ch, k) => (labels[start + k] = ch));
  }
  rows.push([t('fg', ' '.repeat(gutter)), t('rule', ' └' + axis.join(''), ' +' + axis.join('').replace(/─/g, '-').replace(/┬/g, '+'))]);
  rows.push([t('fg', ' '.repeat(gutter + 2)), t('dim', labels.join('').trimEnd())]);
  return rows;
}

const SPARK = ['▂', '▃', '▄', '▅', '▆', '▇'];
const SPARK_PLAIN = ['.', '-', '~', '=', '+', '#'];

// A sparkline of up to `width` points, evenly picked from the values, oldest first. A
// missing value is a gap.
export function sparkline(values: Array<number | null>, plain: boolean, width = 16): string {
  if (!values.length) return '';
  const picked = values.length <= width ? values : Array.from({ length: width }, (_, i) => values[Math.round((i * (values.length - 1)) / (width - 1))] ?? null);
  const known = picked.filter((v): v is number => v !== null);
  const lo = Math.min(...known);
  const hi = Math.max(...known);
  const levels = plain ? SPARK_PLAIN : SPARK;
  return picked.map((v) => (v === null ? ' ' : levels[hi === lo ? 2 : Math.min(levels.length - 1, Math.floor(((v - lo) / (hi - lo)) * levels.length))]!)).join('');
}

const EIGHTHS = ['', '▏', '▎', '▍', '▌', '▋', '▊', '▉'];

// A bar a share of `width` long, in eighths of a character. The length is rounded to
// the eighth first: rounding only the part past the last whole cell sent 7.94 eighths
// to an eighth the table does not have, and a bar of almost one cell drew as nothing.
// A share above zero never draws as nothing: it takes at least the thinnest eighth, or a
// dot in plain text. Reverse repo, a few tenths of a percent of the Fed's balance sheet,
// had no bar at all beside the parts it is summed with.
export function bar(share: number, width: number, plain: boolean): string {
  const cells = Math.max(0, Math.min(1, share)) * width;
  const some = cells > 0;
  if (plain) return '#'.repeat(Math.round(cells)) || (some ? '.' : '');
  const eighths = Math.max(some ? 1 : 0, Math.round(cells * 8));
  return '█'.repeat(Math.floor(eighths / 8)) + (EIGHTHS[eighths % 8] ?? '');
}

// Where a level sits in its range, by its percentile: five cells and a round point.
export function rangeBar(percentile: number, plain: boolean): string {
  const at = Math.min(4, Math.max(0, Math.floor(percentile / 20)));
  return Array.from({ length: 5 }, (_, i) => (i === at ? (plain ? 'o' : '●') : plain ? '-' : '─')).join('');
}

// A nice step for a scale: 1, 2, 2.5, 4 or 5 times a power of ten, at least the value.
export function niceStep(value: number): number {
  if (!(value > 0)) return 1;
  const power = 10 ** Math.floor(Math.log10(value));
  return (([1, 2, 2.5, 4, 5, 10].find((m) => m * power >= value - 1e-12) ?? 10) * power);
}

// Days as columns above and below a line: a value in above it, out below, each as tall
// as it is at one step per half row, and `cell` characters wide, with a space between
// days. Returns the rows, top first, and the step.
export function flowColumns(values: Array<number | null>, plain: boolean, rows = { up: 3, down: 2 }, cell = 1): { rows: string[]; up: number; step: number } {
  // One step for both sides, so the tallest day in and the tallest day out each fit.
  const most = { in: Math.max(0, ...values.map((v) => v ?? 0)), out: Math.max(0, ...values.map((v) => -(v ?? 0))) };
  const step = niceStep(Math.max(most.in / (rows.up * 2), most.out / (rows.down * 2)));
  // A day that moved at all shows at least half a row.
  const halves = values.map((v) => (v === null ? null : v === 0 ? 0 : Math.sign(v) * Math.max(1, Math.round(Math.abs(v) / step))));
  const out: string[] = [];
  for (let r = rows.up; r >= 1; r -= 1) {
    out.push(
      halves
        .map((h) => {
          if (h === null || h <= 0) return ' ';
          if (h >= r * 2) return plain ? '#' : '█';
          if (h === r * 2 - 1) return plain ? '.' : '▄';
          return ' ';
        })
        .map((ch) => ch.repeat(cell))
        .join(' '),
    );
  }
  for (let r = 1; r <= rows.down; r += 1) {
    out.push(
      halves
        .map((h) => {
          if (h === null || h >= 0) return ' ';
          if (-h >= r * 2) return plain ? '#' : '█';
          if (-h === r * 2 - 1) return plain ? "'" : '▀';
          return ' ';
        })
        .map((ch) => ch.repeat(cell))
        .join(' '),
    );
  }
  return { rows: out, up: rows.up, step };
}
