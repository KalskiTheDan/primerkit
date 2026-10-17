// A screen is lines, and a line is segments: a colour role and its text. The same
// segments print in colour, in 16 colours, or plain.

export type Segment = [role: string, text: string];
export type Line = Segment[];

// The terminal grid every screen fits: an 80 column terminal less its margins.
export const WIDTH = 76;
export const HEIGHT = 22;

// Maps characters with no plain equivalent to ASCII, so the plain version is ASCII only.
export const ASCII: Record<string, string> = {
  '▲': '^', '▼': 'v', '●': 'o', '◆': '+', '○': '.', '◉': '>', '✓': 'ok', '✗': 'x', '↳': '>', '›': '>',
  '·': '|', '│': '|', '└': '+', '─': '-', '═': '=', '║': '|', '╔': '+', '╗': '+', '╚': '+', '╝': '+', '┤': '+', '┬': '+',
  '█': '#', '▇': '#', '•': '*', '−': '-', '↑': '^', '↓': 'v', '←': '<-', '→': '->', '⠼': '/', '×': 'x', '▄': '.', '▀': "'", '…': '...',
  '¥': 'JPY', '€': 'EUR', '£': 'GBP', 'σ': 'sd',
};

export function ascii(text: string): string {
  return Array.from(text, (ch) => ASCII[ch] ?? (ch.charCodeAt(0) > 127 ? '?' : ch)).join('');
}

// t(role, text, plainText) builds a segment for the chosen version. In plain mode the
// plain text is used when given, and the text is mapped to ASCII otherwise.
export type Maker = (role: string, text: string, plainText?: string) => Segment;

export function maker(plain: boolean): Maker {
  return (role, text, plainText) => [role, plain ? (plainText ?? ascii(text)) : text];
}

// The columns a character takes in a terminal: two for the wide and full-width ones
// (Chinese, Japanese and Korean, full-width forms, most emoji), none for a combining mark,
// a variation selector or a zero-width joiner, one for the rest. Plain mode writes every
// character past ASCII as one "?", so it measures one column whatever this says.
const WIDE: Array<[number, number]> = [
  [0x1100, 0x115f], // Hangul Jamo
  [0x2e80, 0x303e], // CJK radicals, Kangxi, CJK symbols and punctuation
  [0x3041, 0x33ff], // Hiragana, Katakana, Bopomofo, Hangul compatibility, CJK compatibility
  [0x3400, 0x4dbf], // CJK extension A
  [0x4e00, 0x9fff], // CJK unified ideographs
  [0xa000, 0xa4cf], // Yi
  [0xac00, 0xd7a3], // Hangul syllables
  [0xf900, 0xfaff], // CJK compatibility ideographs
  [0xfe30, 0xfe4f], // CJK compatibility forms
  [0xff00, 0xff60], // full-width forms
  [0xffe0, 0xffe6], // full-width signs
  [0x1f300, 0x1f64f], // pictographs and emoticons
  [0x1f900, 0x1f9ff], // supplemental pictographs
  [0x1fa70, 0x1faff], // pictographs extended
  [0x20000, 0x3fffd], // CJK extensions B and later
];
const ZERO = /^[\u0300-\u036f\u200b-\u200f\u20d0-\u20ff\ufe00-\ufe0f]$/;

export function charWidth(ch: string): number {
  if (ZERO.test(ch)) return 0;
  const code = ch.codePointAt(0) ?? 0;
  return WIDE.some(([from, to]) => code >= from && code <= to) ? 2 : 1;
}

export function textWidth(text: string): number {
  let n = 0;
  for (const ch of text) n += charWidth(ch);
  return n;
}

export function widthOf(line: Line): number {
  return line.reduce((n, [, text]) => n + textWidth(text), 0);
}

// The end of a text that fits in a width, by the columns its characters take.
export function lastColumns(text: string, width: number): string {
  const chars = Array.from(text);
  let n = 0;
  let from = chars.length;
  while (from > 0 && n + charWidth(chars[from - 1] as string) <= width) {
    from -= 1;
    n += charWidth(chars[from] as string);
  }
  return chars.slice(from).join('');
}

// Fills a screen to the terminal's height, inserting blank lines at a position.
export function pad(lines: Line[], at?: number, height = HEIGHT): Line[] {
  const out = lines.slice();
  while (out.length < height) out.splice(at ?? out.length, 0, []);
  return out;
}

// Every segment of every line mapped to ASCII: the plain version of a screen.
export function toPlain(lines: Line[]): Line[] {
  return lines.map((line) => line.map(([role, text]): Segment => [role, ascii(text)]));
}

// Joins neighbouring segments of the same role.
export function merge(line: Line): Line {
  const out: Line = [];
  for (const [role, text] of line) {
    const last = out[out.length - 1];
    if (last && last[0] === role) last[1] += text;
    else out.push([role, text]);
  }
  return out;
}
