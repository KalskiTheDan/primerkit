import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { blockFromJson, blockFromMarkdown, type DataBlock, type DataConnector } from '@primerkit/core';
import { assertBriefing, type ContextRequest } from './ids';

// When a folder's briefings were read: its saved-at.txt, where it keeps one, or else the
// morning the benchmark's briefings were read.
function savedAt(dir: string): string {
  const path = join(dir, 'saved-at.txt');
  return existsSync(path) ? readFileSync(path, 'utf8').trim() : '2026-09-25T09:06:00.000Z';
}

// Frozen briefings from a folder of <id>.md and <id>.json files, for tests and for the
// demo. It answers exactly like the live connector, from disk, with no key.
export class FixtureConnector implements DataConnector {
  readonly id = 'prereason';

  constructor(private readonly dir: string, private readonly fetchedAt = savedAt(dir)) {}

  has(briefing: string): boolean {
    return existsSync(join(this.dir, `${briefing}.md`)) || existsSync(join(this.dir, `${briefing}.json`));
  }

  async fetch(source: ContextRequest): Promise<DataBlock> {
    assertBriefing(source.briefing);
    const path = join(this.dir, `${source.briefing}.${source.format === 'json' ? 'json' : 'md'}`);
    // Said to a person in the demo, where a chart or a typed id asks for one not saved.
    if (!existsSync(path)) throw new Error(`${source.briefing} is not among the saved briefings. Connected to PreReason, primerkit reads it live.`);
    const text = readFileSync(path, 'utf8');
    return source.format === 'json' ? blockFromJson(source.briefing, text, this.fetchedAt) : blockFromMarkdown(source.briefing, text, this.fetchedAt);
  }
}
