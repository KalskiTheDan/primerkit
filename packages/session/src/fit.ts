import { WIDTH, block, charWidth, prLine, prMarkLead, prTile, textWidth, widthOf, type Line, type Maker } from '@primerkit/ui';
import type { Board } from './boards';

// The columns a board's lines take inside its block on the grid: the grid's width less
// the block's frame. A sentence on a board wraps here however wide the window is.
export const BOARD_ROOM = WIDTH - 4;

// The room inside a block in a terminal `columns` wide: all of it, since a chart takes
// the window's whole width, and the grid's without a terminal. The last column stays
// empty, where some terminals wrap a line that reaches it.
export function roomFor(columns: number | undefined): number {
  return columns ? columns - 4 : BOARD_ROOM;
}

// Words wrapped to a width, each line after the first starting with `indent`. A word
// wider than a whole line, such as a path or a link, is broken so it is shown whole.
export function wrapWords(text: string, width: number, indent = ''): string[] {
  // Widths in columns: a Chinese, Japanese or Korean character takes two.
  const length = textWidth;
  const out: string[] = [];
  let line = '';
  for (const word of text.split(/\s+/).filter(Boolean)) {
    if (line && length(line) + 1 + length(word) <= width) {
      line = `${line} ${word}`;
      continue;
    }
    if (line) out.push(line);
    const pieces = breakWord(word, width - length(out.length ? indent : ''), width - length(indent));
    for (const piece of pieces.slice(0, -1)) out.push((out.length ? indent : '') + piece);
    line = (out.length ? indent : '') + (pieces.at(-1) ?? '');
  }
  if (line) out.push(line);
  return out;
}

// A word in pieces, the first at most `first` wide and the rest `later`: each broken
// after the last /, \, - or . in its second half, or at the width where there is none.
function breakWord(word: string, first: number, later: number): string[] {
  const out: string[] = [];
  let rest = Array.from(word);
  let width = Math.max(1, first);
  while (textWidth(rest.join('')) > width) {
    // The most characters that fit the width in columns, one at the least.
    let fit = 0;
    for (let n = 0; fit < rest.length && n + charWidth(rest[fit] as string) <= width; fit += 1) n += charWidth(rest[fit] as string);
    fit = Math.max(1, fit);
    let cut = fit;
    for (let i = fit; i > fit / 2; i--) {
      if ('/\\-.'.includes(rest[i - 1] ?? '')) {
        cut = i;
        break;
      }
    }
    out.push(rest.slice(0, cut).join(''));
    rest = rest.slice(cut);
    width = Math.max(1, later);
  }
  out.push(rest.join(''));
  return out;
}

// Words wrapped to a width in one colour, each line after the first indented.
export function wrapIn(t: Maker, role: string, text: string, width: number, indent = ''): Line[] {
  return wrapWords(text, width, indent).map((l): Line => [t(role, l)]);
}

// A heading too wide for one line: the parts of its subtitle (split at " · ") that fit
// beside the title in `room`, and the rest, which go under it, as many to a line as fit. A
// part is never cut where it fits a line, so a read time stays whole; a subtitle in one
// part goes under the title whole, to be wrapped as before.
export function besideTitle(title: string, subtitle: string, room: number): { beside: string; under: string[] } {
  const parts = subtitle.split(' · ');
  let n = 0;
  while (n < parts.length && textWidth(` ${title}  ${parts.slice(0, n + 1).join(' · ')}`) <= room) n += 1;
  const under: string[] = [];
  for (const part of parts.slice(n)) {
    const last = under.at(-1);
    if (last !== undefined && textWidth(` ${last} · ${part}`) <= room) under[under.length - 1] = `${last} · ${part}`;
    else under.push(part);
  }
  return { beside: parts.slice(0, n).join(' · '), under };
}

// Lines written for the grid's width, kept as written where each fits the width, and
// wrapped again as one text where the window is narrower.
export function reflow(lines: readonly string[], width: number, indent = ''): string[] {
  return lines.every((l) => textWidth(l) <= width) ? [...lines] : wrapWords(lines.join(' '), width, indent);
}

// A board's lines fitted to a width. A sentence wider than it wraps, each line after
// the first indented; a line laid out in columns (spaces running between its words)
// never does, or its columns would close up.
export function fitLines(t: Maker, lines: Line[], width: number): Line[] {
  return lines.flatMap((l): Line[] => (widthOf(l) > width && l.length === 1 && l[0] && !/\S {2,}\S/.test(l[0][1]) ? wrapIn(t, l[0][0], l[0][1], width, '  ') : [l]));
}

// Plain text printed once in a terminal `columns` wide: an answer, a digest. A line
// longer than the window wraps at a space, and its later lines start where its words
// do, past any indent or list mark ("- ", "1. ", "[1] "). A line laid out in columns
// (spaces running between its words) or with no space to wrap at is left as it is, and
// so is all of it without a terminal: a pipe or a file gets the text unchanged.
export function fitText(text: string, columns: number | undefined): string {
  if (!columns) return text;
  const width = columns - 1;
  const length = textWidth;
  return text
    .split('\n')
    .map((line) => {
      if (length(line) <= width || /\S {2,}\S/.test(line.trim())) return line;
      const lead = /^\s*(?:[-*•] |\d+\. |\[\d+\] )?/.exec(line)?.[0] ?? '';
      const indent = ' '.repeat(length(lead));
      const out: string[] = [];
      let current = lead;
      for (const word of line.slice(lead.length).split(' ').filter(Boolean)) {
        if (current.trim() && length(current) + 1 + length(word) > width) {
          out.push(current);
          current = indent + word;
        } else current = current.trim() ? `${current} ${word}` : `${current}${word}`;
      }
      out.push(current);
      return out.join('\n');
    })
    .join('\n');
}

// A board as printed once in a terminal `columns` wide (undefined when the output is
// not a terminal: the grid's width). Draw it in roomFor(columns) first. The heading puts
// its date on a line of its own when the two do not fit one, and a sentence wraps in the
// room, at most the grid's however wide the window. A line the board could not narrow
// may still take the window's width; one wider than the window is not printed broken: a
// line says how wide a window the board needs, wrapped to the window, and `drawn` is
// false.
export function printedBoard(t: Maker, board: Board, time: string, columns: number | undefined, closing?: Line): { lines: Line[]; drawn: boolean } {
  const room = roomFor(columns);
  const title: Line = [t('accentBold', ` ${board.title}`), t('muted', `  ${board.subtitle}`)];
  const split = columns && widthOf(title) > columns - 1 ? besideTitle(board.title, board.subtitle, columns - 1) : null;
  const heading: Line[] =
    columns && split
      ? [[t('accentBold', ` ${board.title}`), ...(split.beside ? [t('muted', `  ${split.beside}`)] : [])], ...split.under.flatMap((u) => wrapIn(t, 'muted', u, columns - 2, '  ')).map((l): Line => [t('muted', ' '), ...l])]
      : [title];
  const body = fitLines(t, board.lines, Math.min(room, BOARD_ROOM));
  const widest = Math.max(0, ...body.map(widthOf));
  if (columns && widest > columns - 4) {
    const note = `Too narrow to draw: it needs a window at least ${widest + 4} columns wide, and this one is ${columns}.`;
    return { lines: [...heading, ...wrapIn(t, 'muted', note, columns - 2, ' ').map((l): Line => [t('muted', ' '), ...l])], drawn: false };
  }
  // The credit keeps to the window too: without the time where the whole line does not
  // fit, and the mark alone where the sources do not either.
  const credits: Line[] = [prLine(t, board.sources, time), [...prMarkLead(t), t('dim', board.sources)], [prTile(t)]];
  const credit = closing ?? credits.find((c) => !columns || widthOf(c) + 3 <= columns - 1) ?? credits.at(-1)!;
  return { lines: [...heading, ...block(t, body, credit)], drawn: true };
}
