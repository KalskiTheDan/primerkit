import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DataBlock, PacketFormat } from './types';

// Every briefing read is kept as served, one file per briefing, format and generated
// time. The digest diffs against them, so a briefing
// is fetched once a day, not twice. Nothing here leaves the machine.

export interface Snapshot {
  briefing: string;
  format: PacketFormat;
  generatedAt: string;
  path: string;
}

const ext = (format: PacketFormat): string => (format === 'json' ? 'json' : 'md');

// A file name from an ISO time, with the colons Windows refuses taken out.
export function stampOf(iso: string): string {
  return iso.replace(/:/g, '-');
}

function isoOf(stamp: string): string {
  return stamp.replace(/T(\d{2})-(\d{2})-(\d{2})/, 'T$1:$2:$3');
}

export class Snapshots {
  constructor(readonly root: string) {}

  // Written once: a snapshot already kept for that generated time is left as it is. It is
  // written whole beside its place and then moved there, so a write cut short never leaves
  // a part of a snapshot where the digest reads one.
  save(block: DataBlock): string | null {
    if (block.raw === undefined) return null;
    const dir = join(this.root, block.id);
    mkdirSync(dir, { recursive: true });
    const path = join(dir, `${stampOf(block.generatedAt ?? block.fetchedAt)}.${ext(block.format)}`);
    if (existsSync(path)) return path;
    const part = `${path}.${process.pid}.part`;
    try {
      writeFileSync(part, block.raw);
      renameSync(part, path);
    } finally {
      rmSync(part, { force: true });
    }
    return path;
  }

  list(briefing: string, format: PacketFormat): Snapshot[] {
    const dir = join(this.root, briefing);
    if (!existsSync(dir)) return [];
    const suffix = `.${ext(format)}`;
    return readdirSync(dir)
      .filter((f) => f.endsWith(suffix))
      .sort()
      .map((f) => ({ briefing, format, generatedAt: isoOf(f.slice(0, -suffix.length)), path: join(dir, f) }));
  }

  // The newest snapshot generated at or before a time, or the newest of all.
  latest(briefing: string, format: PacketFormat, atOrBefore?: string): (Snapshot & { raw: string }) | null {
    const all = this.list(briefing, format).filter((s) => !atOrBefore || s.generatedAt <= atOrBefore);
    const last = all.at(-1);
    return last ? { ...last, raw: readFileSync(last.path, 'utf8') } : null;
  }
}
