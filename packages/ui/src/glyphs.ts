// Every glyph primerkit prints, with the plain fallback it prints under NO_COLOR, in
// a pipe, or where a font lacks it.

export interface Glyph {
  meaning: string;
  glyph: string;
  plain: string;
}

export const GLYPHS: readonly Glyph[] = [
  { meaning: 'A value rose', glyph: '▲', plain: '^' },
  { meaning: 'A value fell', glyph: '▼', plain: 'v' },
  { meaning: 'Unchanged', glyph: '●', plain: 'o' },
  { meaning: 'New, or a label that moved past its margin', glyph: '◆', plain: '+' },
  { meaning: 'Stale or missing', glyph: '○', plain: '.' },
  { meaning: 'Check passed', glyph: '✓', plain: 'ok' },
  { meaning: 'Check failed', glyph: '✗', plain: 'x' },
  { meaning: 'Where a figure came from', glyph: '↳', plain: '>' },
  { meaning: 'The prompt, and the chosen option', glyph: '›', plain: '>' },
  { meaning: 'Rail: done, current, to come', glyph: '● ◉ ○', plain: '[x] [>] [ ]' },
  { meaning: 'A block of lines that belong together', glyph: '│ └', plain: '| +' },
  { meaning: 'Separator', glyph: '·', plain: '|' },
  { meaning: 'Working', glyph: '⠋ ⠙ ⠹ ⠸ ⠼ ⠴ ⠦ ⠧ ⠇ ⠏', plain: '| / - \\' },
];

// The spinner a running step shows, a frame at a time.
export const SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
// The plain spinner starts on '/', so its first frame is not read as a block's line.
export const SPINNER_PLAIN = ['/', '-', '\\', '|'];
