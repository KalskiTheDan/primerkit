import { stylesOf } from './palette';
import type { Line } from './segments';

export type ColorMode = 'truecolor' | '16' | 'plain';

const rgb = (hex: string): string => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)).join(';');

// One line of segments as terminal text in the chosen mode.
export function renderLine(line: Line, mode: ColorMode): string {
  return line
    .map(([role, text]) => {
      if (mode === 'plain') return text;
      const [s, back] = stylesOf(role);
      const codes: string[] = [];
      if (mode === '16') {
        if (s.ansi16) codes.push(s.ansi16);
        if (back?.ansi16Bg) codes.push(back.ansi16Bg);
      } else {
        if (s.bold) codes.push('1');
        if (s.hex) codes.push(`38;2;${rgb(s.hex)}`);
        if (back?.hex) codes.push(`48;2;${rgb(back.hex)}`);
      }
      return codes.length ? `\x1b[${codes.join(';')}m${text}\x1b[0m` : text;
    })
    .join('');
}

export interface ModeInput {
  env: Record<string, string | undefined>;
  isTTY: boolean;
  plainFlag?: boolean;
  sixteenFlag?: boolean;
}

// The NO_COLOR convention, a pipe or --plain print the plain version. A terminal that
// says it has 24 bit colour gets it; every other terminal gets 16 colours.
export function colorMode({ env, isTTY, plainFlag = false, sixteenFlag = false }: ModeInput): ColorMode {
  if (plainFlag || env.NO_COLOR || !isTTY) return 'plain';
  if (sixteenFlag) return '16';
  const truecolor = env.COLORTERM === 'truecolor' || env.COLORTERM === '24bit' || Boolean(env.WT_SESSION) || env.TERM_PROGRAM === 'vscode';
  return truecolor ? 'truecolor' : '16';
}

export type GlyphMode = 'unicode' | 'ascii';

export interface GlyphInput {
  env: Record<string, string | undefined>;
  platform: string;
  color: ColorMode;
  unicodeFlag?: boolean;
}

// The old Windows console, where Windows PowerShell 5.1 opens, draws with fonts that
// lack braille, sextants and several symbols, so there the screens use their ASCII
// glyphs and keep their colour. Windows Terminal, VS Code, ConEmu and terminals that
// set TERM, such as Git Bash's, have the glyphs. --unicode overrides.
export function glyphMode({ env, platform, color, unicodeFlag = false }: GlyphInput): GlyphMode {
  if (color === 'plain') return 'ascii';
  if (unicodeFlag || platform !== 'win32') return 'unicode';
  const modern = Boolean(env.WT_SESSION) || Boolean(env.TERM_PROGRAM) || env.ConEmuANSI === 'ON' || Boolean(env.TERM);
  return modern ? 'unicode' : 'ascii';
}
