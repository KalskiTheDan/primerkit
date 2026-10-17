import type { Line, Maker, Segment } from './segments';
import { WIDTH, charWidth, lastColumns, textWidth, widthOf } from './segments';

// The grammar of a screen: a top line, blocks that hang off one
// line down the left and close on the line crediting PreReason, and the input line.

export const RAIL_STEPS = ['Model', 'PreReason', 'First question', 'Digest'] as const;

// The first run's rail: done, current, to come. Where the window is narrower than the
// rail, its joins shorten, and narrower still it names the current step and its place.
export function rail(t: Maker, plain: boolean, current: number, width = WIDTH): Line {
  const full = (join: string): Line => {
    if (plain) return [t('fg', ' ' + RAIL_STEPS.map((s, i) => `${i < current ? '[x]' : i === current ? '[>]' : '[ ]'} ${s}`).join(join))];
    const segs: Line = [t('fg', ' ')];
    RAIL_STEPS.forEach((s, i) => {
      if (i > 0) segs.push(t('rule', join));
      if (i < current) segs.push(t('muted', `● ${s}`));
      else if (i === current) segs.push(t('accentBold', `◉ ${s}`));
      else segs.push(t('dim', `○ ${s}`));
    });
    return segs;
  };
  for (const line of [full(plain ? '   ' : ' ─── '), full(plain ? ' ' : ' ─ ')]) if (widthOf(line) <= width) return line;
  return [t('accentBold', ` ${plain ? '[>]' : '◉'} ${RAIL_STEPS[current] ?? ''}`), t('dim', `  step ${current + 1} of ${RAIL_STEPS.length}`)];
}

export interface TopInfo {
  model: string; // "qwen2.5:7b, local, 8k"
  connected: boolean;
  tier: string | null; // "free"; null while no data response has named it
  callsLeft?: number | null;
}

// The top line: the name, the model and where it runs, the PreReason tier, and the calls
// left today. A long model label or a large budget drops "today", then the word "calls",
// so the line keeps to one row.
// Narrower still, the calls go, then the model's details after its name, then
// "PreReason" shortens to its mark's letters.
export function topLine(t: Maker, info: TopInfo, width = WIDTH): Line {
  const prereason = !info.connected ? 'not connected' : (info.tier ?? 'connected');
  const short = info.model.split(',')[0] ?? info.model;
  const base = (model: string, pr: string): Line => [t('accentBold', ' primerkit '), t('dim', '·'), t('fg', ` ${model} `), t('dim', '·'), t('fg', ` ${pr} ${prereason} `)];
  const segs = base(info.model, 'PreReason');
  if (info.callsLeft != null) {
    const calls = info.callsLeft.toLocaleString('en-US');
    for (const words of [`${calls} calls left today`, `${calls} calls left`, `${calls} left`]) {
      const line = [...segs, t('dim', '·'), t('fg', ` ${words}`)];
      if (widthOf(line) <= width) return line;
    }
  }
  for (const line of [segs, base(short, 'PreReason'), base(short, 'PR')]) if (widthOf(line) <= width) return line;
  return base(short, 'PR');
}

// The line that credits PreReason's data, the only place the small PR mark appears.
// The mark says whose data it is, so the line names only what was read and when. Data
// from anywhere else would carry no mark and say "pulled from" its source instead;
// nothing primerkit reads comes from anywhere else yet.
// The credit under a block: what was read, and when it stood. A block read for a past day
// names that day, "as it stood on Aug 15, 2026", in place of the time it was generated.
export function prLine(t: Maker, what: string, time: string, stoodOn?: string): Line {
  // A board with no time of its own (a forward record with no run yet) names none.
  return [...prMarkLead(t), t('dim', `${what}${stoodOn ? ` · as it stood on ${stoodOn}` : time ? ` · generated ${time} UTC` : ''}`)];
}

// PreReason's mark as its logo has it: PR in amber on a charcoal tile, " PR ". Plain text
// has no tile, so there the mark is the two letters alone.
export function prTile(t: Maker): Segment {
  return t('pr/prTile', ' PR ', 'PR');
}

// The mark and the space before the words that follow it: one after the tile, whose own
// padding parts it from them, and two after the plain letters, as before the tile.
export function prMarkLead(t: Maker): Line {
  return [prTile(t), t('dim', ' ', '  ')];
}

export function askLine(t: Maker, text: string): Line {
  return [t('accentBold', ' › '), t('bright', text)];
}

// The input: the placeholder shortens to fit, and text longer than the line shows its
// end, where the cursor is, after an ellipsis.
export function inputLine(t: Maker, typed: string, cursor: boolean, width = WIDTH): Line {
  if (!typed) return [t('accentBold', ' › '), t('ph', width >= 51 ? 'Ask about the markets, or type / for a command' : 'Ask, or type / for a command')];
  const room = width - 4;
  // By the columns its characters take: a Chinese, Japanese or Korean character takes two.
  const over = textWidth(typed) > room;
  const tail = lastColumns(typed, room - 1);
  const shown = over ? `…${tail}` : typed;
  return [t('accentBold', ' › '), t('bright', shown, over ? `~${Array.from(tail).slice(-(room - 1)).join('')}` : undefined), ...(cursor ? [t('cursor', '█', '_')] : [])];
}

export function helpLine(t: Maker, text: string): Line {
  return [t('dim', `   ${text}`)];
}

// B's line: every line of a block hangs off the left, and the last one closes it.
export function block(t: Maker, body: Line[], closing: Line): Line[] {
  return [...body.map((l): Line => (l.length ? [t('rule', ' │ '), ...l] : [t('rule', ' │')])), [t('rule', ' └ '), ...closing]];
}

// A figure in a sentence draws bright, so a reader finds the numbers first.
const FIGURE = /^[+−-]?[$€£]?\d[\d,]*(\.\d+)?[%×x]?[KMBT]?$/;

// A numbered source marker, such as [1], draws dim.
const MARKER = /^\[\d+\]$/;

// Wraps plain text to a width, word by word, with figures bright and markers dim.
export function wrap(t: Maker, text: string, width: number): Line[] {
  const lines: Line[] = [];
  let line: Line = [];
  let used = 0;
  for (const word of text.split(/\s+/).filter(Boolean)) {
    const w = textWidth(word);
    if (line.length && used + 1 + w > width) {
      lines.push(line);
      line = [];
      used = 0;
    }
    if (line.length) {
      line.push(t('fg', ' '));
      used += 1;
    }
    const bare = word.replace(/[.,;:)]+$/, '');
    if (MARKER.test(bare)) {
      line.push(t('dim', bare));
      if (bare.length < word.length) line.push(t('fg', word.slice(bare.length)));
    } else if (FIGURE.test(bare)) {
      line.push(t('bright', bare));
      if (bare.length < word.length) line.push(t('fg', word.slice(bare.length)));
    } else {
      line.push(t('fg', word));
    }
    used += w;
  }
  if (line.length) lines.push(line);
  return lines;
}

// Cuts a line to a width, for text that may run long, such as a typed question.
export function clip(line: Line, width: number): Line {
  if (widthOf(line) <= width) return line;
  const out: Line = [];
  let used = 0;
  for (const [role, text] of line) {
    const room = width - used;
    if (room <= 0) break;
    if (textWidth(text) <= room) {
      out.push([role, text]);
      used += textWidth(text);
    } else {
      // The characters that fit before the ellipsis, by the columns each takes.
      let kept = '';
      for (const ch of text) {
        if (textWidth(kept) + charWidth(ch) > room - 1) break;
        kept += ch;
      }
      out.push([role, `${kept}…`]);
      used = width;
    }
  }
  return out;
}

// ------------------------------------------------------------------ the panel frame

// A panel's title bar: the function's code on its tile and the subject on the left, the date
// and the source of what it shows on the right, as one band across the width. Where the two
// do not fit, the right side goes, then the subject shortens. Plain text has no tile or band:
// the code stands in brackets.
export function titleBar(t: Maker, code: string, subject: string, right: string, width = WIDTH): Line {
  const tile = t('code/codeTile', ` ${code} `, `[${code}]`);
  const room = width - widthOf([tile]);
  const body = t('barText/bar', subject ? ` ${subject}` : '');
  const tail = right ? t('barDim/bar', ` ${right} `) : null;
  if (tail && widthOf([body, tail]) + 1 <= room) return [tile, body, t('barText/bar', ' '.repeat(room - widthOf([body, tail]))), tail];
  const kept = shortened(t, 'barText/bar', subject ? ` ${subject}` : '', room - 1);
  return [tile, kept, t('barText/bar', ' '.repeat(Math.max(0, room - widthOf([kept]))))];
}

// A text in a role at most `width` columns wide, cut with an ellipsis where it is wider.
function shortened(t: Maker, role: string, text: string, width: number): Segment {
  const whole = t(role, text);
  if (widthOf([whole]) <= width) return whole;
  let chars = Array.from(text);
  while (chars.length && widthOf([t(role, `${chars.join('')}…`)]) > width) chars = chars.slice(0, -1);
  return t(role, `${chars.join('')}…`);
}

// The status strip under every screen: label and value pairs in the order given, the most
// needed first. Where they do not all fit, the last go first; the first value shortens to
// what fits before it goes.
export function statusStrip(t: Maker, parts: ReadonlyArray<readonly [label: string, value: string]>, width = WIDTH): Line {
  const build = (n: number): Line => {
    const out: Line = [];
    parts.slice(0, n).forEach(([label, value], i) => {
      out.push(i ? t('barDim/bar', ' │ ', ' | ') : t('barDim/bar', ' '));
      if (label) out.push(t('barDim/bar', `${label} `));
      out.push(t('barText/bar', value));
    });
    return out;
  };
  const fill = (line: Line): Line => [...line, t('barText/bar', ' '.repeat(Math.max(0, width - widthOf(line))))];
  for (let n = parts.length; n > 0; n--) {
    const line = build(n);
    if (widthOf(line) + 1 <= width) return fill(line);
  }
  const [label = '', value = ''] = parts[0] ?? [];
  const lead = [t('barDim/bar', ' '), ...(label ? [t('barDim/bar', `${label} `)] : [])];
  return fill([...lead, shortened(t, 'barText/bar', value, width - 1 - widthOf(lead))]);
}

// Onboarding's two strips: what the person does at a step, and what the agent does there,
// each label in its own column and its words wrapped under their own start.
export const DUO_LABELS = { you: 'YOU DO', agent: 'AGENT DOES' } as const;
export function duo(t: Maker, you: string, agent: string, width = WIDTH): Line[] {
  const pad = 13;
  const strip = (label: string, role: string, text: string, words: string): Line[] =>
    wrapText(text, width - pad - 1).map((l, i): Line => [t('fg', ' '), t(i ? 'fg' : role, (i ? '' : label).padEnd(pad - 1)), t('fg', ' '), t(words, l)]);
  return [...strip(DUO_LABELS.you, 'accentBold', you, 'bright'), ...strip(DUO_LABELS.agent, 'muted', agent, 'fg')];
}

// Words wrapped to a width, by the columns they take; a word wider than the width stands alone.
function wrapText(text: string, width: number): string[] {
  const out: string[] = [];
  let line = '';
  for (const word of text.split(/\s+/).filter(Boolean)) {
    if (line && textWidth(line) + 1 + textWidth(word) > width) {
      out.push(line);
      line = word;
    } else line = line ? `${line} ${word}` : word;
  }
  if (line) out.push(line);
  return out;
}

// A change as a table cell: its sign's glyph and its figure, green for a rise and red for a
// fall the data states, muted where it is flat or not known. Never a view on the change.
export function changeCell(t: Maker, value: number | null, text: string, width: number): Segment {
  if (value === null || !Number.isFinite(value)) return t('dim', '·'.padStart(width), '-'.padStart(width));
  const glyph = value > 0 ? '▲' : value < 0 ? '▼' : '●';
  const role = value > 0 ? 'up' : value < 0 ? 'down' : 'muted';
  const plainGlyph = value > 0 ? '+' : value < 0 ? '-' : '=';
  const shown = `${glyph} ${text}`;
  return t(role, shown.padStart(width), `${plainGlyph}${text.replace(/^[+−-]/, '')}`.padStart(width));
}
