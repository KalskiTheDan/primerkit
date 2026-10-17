import { execFileSync } from 'node:child_process';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// What a public release would contain must be clean of research: references to the
// design documents, PreReason's internal paths, and notes about the owner stay in
// notes/, which the export leaves out.

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const RESEARCH = [
  /\bdesign doc\b/i,
  /\blook doc\b/i,
  /§\s?\d/,
  /scripts\/qa\//,
  /docs\/(architecture|sessions)\//,
  /fixtures-\d{8}T\d{6}Z/,
  /PreReason's (repository|repo)\b/,
  /\bthe owner\b/i,
  /\byardstick\b/i,
  /\bside item\b/i,
  // Names from how primerkit was made, which mean nothing to a reader of a release: a review
  // by its internal name, numbered lanes and rounds of testing, where the code was kept, and
  // a machine's user name.
  /\breg lane\b/i,
  /\blane \d/i,
  /\bprivate repo/i,
  /\bkalsk\b/,
  /\bround \d/i,
  /\bstoryboard round\b/i,
  /PreReason-shared/i,
];

// Files whose words are not ours: the licence, and data PreReason served.
const DATA = [/^LICENSE$/, /^NOTICE$/, /\/fixtures\/[^/]+\/(btc|macro|cross|eth|fx)\.[^/]+\.(md|json)$/, /\/fixtures\/catalog-[\d-]+\.json$/, /^package-lock\.json$/];

function exported(): string[] {
  const tracked = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], { cwd: ROOT, encoding: 'utf8' }).split('\n').filter(Boolean);
  const ignored = new Set(
    execFileSync('git', ['check-attr', '--stdin', 'export-ignore'], { cwd: ROOT, encoding: 'utf8', input: tracked.join('\n') })
      .split('\n')
      .filter((l) => l.endsWith(': export-ignore: set'))
      .map((l) => l.slice(0, l.indexOf(': export-ignore'))),
  );
  return tracked.filter((f) => !ignored.has(f));
}

// A control character in source is invisible in an editor and changes what the code
// does: a backspace where \b was meant is how one got in once.
const CONTROL = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/;
const TEXT = /\.(ts|mts|mjs|js|json|md|yaml|yml|txt)$/;
// A picture's bytes are no lines to scan, and read as text they match a pattern by chance.
// Where a PNG could carry words is a text chunk, so a shipped PNG holds image chunks only.
const IMAGE = /\.(png|gif)$/;
const PNG_TEXT = new Set(['tEXt', 'iTXt', 'zTXt', 'eXIf']);
function pngChunks(bytes: Buffer): string[] {
  const types: string[] = [];
  for (let at = 8; at + 8 <= bytes.length; ) {
    const type = bytes.toString('latin1', at + 4, at + 8);
    types.push(type);
    if (type === 'IEND') break;
    at += 12 + bytes.readUInt32BE(at);
  }
  return types;
}

// Where a GIF could carry words: a comment or plain text extension, or an application
// extension other than the loop count (NETSCAPE2.0).
function gifBlocks(bytes: Buffer): { comments: number; plain: number; apps: string[]; images: number } {
  const out = { comments: 0, plain: 0, apps: [] as string[], images: 0 };
  let at = 13;
  if (bytes[10]! & 0x80) at += 3 * (1 << ((bytes[10]! & 7) + 1));
  const subBlocks = () => {
    while (at < bytes.length && bytes[at] !== 0) at += bytes[at]! + 1;
    at += 1;
  };
  while (at < bytes.length && bytes[at] !== 0x3b) {
    if (bytes[at] === 0x21) {
      const label = bytes[at + 1];
      at += 2;
      if (label === 0xfe) out.comments += 1;
      else if (label === 0x01) out.plain += 1;
      else if (label === 0xff) out.apps.push(bytes.toString('latin1', at + 1, at + 12));
      subBlocks();
    } else if (bytes[at] === 0x2c) {
      const flags = bytes[at + 9]!;
      at += 10;
      if (flags & 0x80) at += 3 * (1 << ((flags & 7) + 1));
      at += 1;
      subBlocks();
      out.images += 1;
    } else break;
  }
  return out;
}

function scan(files: string[]): { research: string[]; control: string[] } {
  const research: string[] = [];
  const control: string[] = [];
  for (const file of files) {
    if (IMAGE.test(file)) continue;
    let text: string;
    try {
      text = readFileSync(join(ROOT, file), 'utf8');
    } catch {
      continue; // a file deleted in the working tree
    }
    const lines = text.split(/\r?\n/);
    if (TEXT.test(file)) lines.forEach((line, i) => CONTROL.test(line) && control.push(`${file}:${i + 1}`));
    if (file === 'test/release.test.ts' || DATA.some((re) => re.test(file))) continue;
    lines.forEach((line, i) => {
      if (RESEARCH.some((re) => re.test(line))) research.push(`${file}:${i + 1}: ${line.trim().slice(0, 100)}`);
    });
  }
  return { research, control };
}

describe('a public release', () => {
  const files = exported();

  it('leaves the private notes out', () => {
    expect(files.some((f) => f.startsWith('notes/'))).toBe(false);
    expect(files).toContain('README.md');
  });

  it('carries no research reference and no control character in any file it ships', () => {
    const found = scan(files);
    expect(found.research).toEqual([]);
    expect(found.control).toEqual([]);
  });

  it('ships its GIF pictures with no comment or text in them, only frames and their loop', () => {
    const gifs = files.filter((f) => f.endsWith('.gif'));
    for (const file of gifs) {
      const bytes = readFileSync(join(ROOT, file));
      expect(bytes.toString('latin1', 0, 6), file).toBe('GIF89a');
      const found = gifBlocks(bytes);
      expect(found.images, file).toBeGreaterThan(0);
      expect({ comments: found.comments, plain: found.plain }, file).toEqual({ comments: 0, plain: 0 });
      expect(found.apps.filter((a) => a !== 'NETSCAPE2.0'), file).toEqual([]);
    }
    // CONTROL: a one pixel GIF with a comment extension is found.
    const planted = Buffer.concat([
      Buffer.from('GIF89a', 'latin1'),
      Buffer.from('01000100000000', 'hex'),
      Buffer.from('21fe04', 'hex'), Buffer.from('lane', 'latin1'), Buffer.from('00', 'hex'),
      Buffer.from('2c00000000010001000002024401003b', 'hex'),
    ]);
    expect(gifBlocks(planted)).toEqual({ comments: 1, plain: 0, apps: [], images: 1 });
  });

  it('ships its PNG pictures with no text chunk in them, so no word rides along in a picture', () => {
    const pngs = files.filter((f) => f.endsWith('.png'));
    for (const file of pngs) {
      const chunks = pngChunks(readFileSync(join(ROOT, file)));
      expect(chunks[0], file).toBe('IHDR');
      expect(chunks.at(-1), file).toBe('IEND');
      expect(chunks.filter((c) => PNG_TEXT.has(c)), file).toEqual([]);
    }
    // CONTROL: a PNG with a text chunk is found.
    const ihdr = Buffer.from('0000000d49484452000000010000000108060000001f15c489', 'hex');
    const text = Buffer.concat([Buffer.from('0000000474455874', 'hex'), Buffer.from('lane'), Buffer.from('00000000', 'hex')]);
    const iend = Buffer.from('0000000049454e44ae426082', 'hex');
    const planted = pngChunks(Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), ihdr, text, iend]));
    expect(planted.filter((c) => PNG_TEXT.has(c))).toEqual(['tEXt']);
  });

  it('finds both when a file carries them (the control for the two checks above)', () => {
    const planted = 'test/release-control.md';
    writeFileSync(join(ROOT, planted), 'As the design doc says, see §3.2.\nA regex with a backspace: /x\b/\n');
    try {
      const found = scan(exported());
      expect(found.research.filter((f) => f.startsWith(planted))).toHaveLength(1);
      expect(found.control).toEqual([`${planted}:2`]);
    } finally {
      rmSync(join(ROOT, planted));
    }
  });

  it('knows each name from how primerkit was made, and not the words that only look like one', () => {
    const named = (line: string) => RESEARCH.some((re) => re.test(line));
    for (const line of ['as the reg lane cleared it', 'lane 03 ran it', 'in the private repository', 'typed by kalsk', 'found in round 8', 'as the storyboard round drew it', 'a PreReason-shared folder']) expect(named(line), line).toBe(true);
    for (const line of ['Copyright 2026 Daniel Kalski', 'github.com/KalskiTheDan/primerkit', 'around 09:05 UTC', 'Math.round(x)', 'a second round of small words']) expect(named(line), line).toBe(false);
  });
});
