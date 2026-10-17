import { mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  BENCH_ARMS,
  Journal,
  benchItems,
  benchLines,
  keepBench,
  recordAnswer,
  runBench,
  summarizeBench,
  type BenchFile,
  type BenchItem,
  type ModelAdapter,
  type Packet,
  type PacketFormat,
} from '../src/index';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const bench = JSON.parse(readFileSync(join(ROOT, 'operations', 'bench-comprehension', 'questions-2026-09-25.json'), 'utf8')) as BenchFile;
const FIXTURES = join(ROOT, 'operations', 'bench-comprehension', 'briefings-2026-09-25');
const data = (briefing: string, format: PacketFormat) => readFileSync(join(FIXTURES, `${briefing}.${format === 'json' ? 'json' : 'md'}`), 'utf8');

// The key's own answers for the briefing a packet reads.
function keyed(packet: Packet): string {
  const briefing = packet.runId.split('__')[0];
  const b = bench.briefings.find((x) => x.briefing === briefing)!;
  return JSON.stringify({ answers: Object.fromEntries(b.questions.map((q) => [q.id, q.key.answer])) });
}

function model(reply: (packet: Packet, n: number) => string): ModelAdapter {
  let n = 0;
  return {
    id: 'test',
    label: 'test model',
    capabilities: async () => ({ local: true, schemaConstraint: true, contextTokens: null, canRaiseContext: false, format: 'markdown' }),
    complete: async (packet) => ({ text: reply(packet, n++) }),
  };
}

describe('the benchmark runner', () => {
  const items = benchItems(bench, data);

  it('reads each briefing in three arms, three runs each, run by run', () => {
    expect(BENCH_ARMS).toEqual(['markdown', 'json', 'none']);
    expect(items).toHaveLength(5 * 3 * 3);
    expect(items.slice(0, 15).every((i) => i.run === 1)).toBe(true);
    expect(items[15]?.run).toBe(2);
    // The runs of a briefing and arm share one packet.
    const first = items.find((i) => i.key === 'btc.pulse__markdown__r1')!;
    const third = items.find((i) => i.key === 'btc.pulse__markdown__r3')!;
    expect(third.packet).toBe(first.packet);
  });

  it('gives the no data arm no DATA section and tells the model so', () => {
    const none = items.find((i) => i.arm === 'none')!.packet.text;
    expect(none).not.toContain('\nDATA\n');
    expect(none).toContain('There is no DATA section.');
    const markdown = items.find((i) => i.arm === 'markdown')!.packet.text;
    expect(markdown).toContain('\nDATA\n<<<\n');
    expect(markdown).toContain('use no tools and read no other file');
  });

  it("scores a reply by code: the key's answers are all right, a reply without answers is all missing", () => {
    const item = items[0] as BenchItem;
    const right = recordAnswer(item, keyed(item.packet));
    expect(right).toMatchObject({ correct: 10, total: 10, answered: true });
    const none = recordAnswer(item, 'I cannot answer that.');
    expect(none).toMatchObject({ correct: 0, answered: false });
    expect(Object.values(none.statuses).every((s) => s === 'missing')).toBe(true);
  });

  it('pools accuracy per arm and reports the median right answers per 1,000 tokens', async () => {
    const answers = model((p) => (p.runId.endsWith('__markdown') ? keyed(p) : p.runId.endsWith('__json') ? '{"answers":{}}' : 'no idea'));
    const { records, replies, stopped } = await runBench(answers, benchItems(bench, data, { runs: 1 }));
    expect(stopped).toBeNull();
    expect(replies.size).toBe(15);
    const result = summarizeBench(records, { model: 'test', fixtures: '2026-09-25', now: new Date('2026-09-26T12:00:00Z') });
    const markdown = result.arms.find((a) => a.arm === 'markdown')!;
    expect(markdown.accuracy).toBe(1);
    const perBriefing = [...new Set(records.filter((r) => r.arm === 'markdown').map((r) => 1 / (r.tokens / 1000)))].sort((a, b) => a - b);
    expect(markdown.perThousand).toBeCloseTo(perBriefing[2]!, 10);
    expect(result.arms.find((a) => a.arm === 'json')!.accuracy).toBe(0);
    expect(result.best).toBe('markdown');
    expect(result).toMatchObject({ briefings: ['btc.pulse', 'btc.context', 'macro.snapshot', 'cross.correlations', 'btc.grid-stress'], runs: 1, answers: 15 });

    const lines = benchLines(result);
    expect(lines[0]).toMatch(/^5 briefings \| 3 arms \| 1 run each \| 15 answers \| /);
    expect(lines.find((l) => l.startsWith('markdown'))).toMatch(/^markdown\s+100%\s+[\d,]+\s+#{20} \d\.\d\d$/);
    expect(lines.find((l) => l.startsWith('none'))).toMatch(/no data read$/);
    expect(lines).toContain('Per 1,000 tokens, markdown gave this model the most right answers.');
  });

  it('stops when the model cannot be reached, and keeps what was answered', async () => {
    const flaky = model((p, n) => {
      if (n === 2) throw new Error('Ollama is not answering at http://127.0.0.1:11434');
      return keyed(p);
    });
    const { records, stopped } = await runBench(flaky, items);
    expect(records).toHaveLength(2);
    expect(stopped).toBe('Ollama is not answering at http://127.0.0.1:11434');
  });

  it('keeps the result, every answer and one copy of each packet in the journal', async () => {
    const run = benchItems(bench, data, { runs: 2, briefings: ['btc.pulse'] });
    const { records, replies } = await runBench(model(keyed), run);
    const result = summarizeBench(records, { model: 'test', fixtures: '2026-09-25' });
    const journal = new Journal(mkdtempSync(join(tmpdir(), 'pk-bench-')));
    const dir = keepBench(journal, result, records, run, replies);
    const files = readdirSync(dir).sort();
    expect(files).toEqual(['answers.json', 'packet.btc.pulse__json.md', 'packet.btc.pulse__markdown.md', 'packet.btc.pulse__none.md', 'render.md', 'result.json']);
    const kept = JSON.parse(readFileSync(join(dir, 'answers.json'), 'utf8')) as Array<{ key: string; reply: string }>;
    expect(kept).toHaveLength(6);
    expect(kept[0]?.reply).toContain('"answers"');
    expect(readFileSync(join(dir, 'render.md'), 'utf8')).toMatch(/^Benchmark {2}test on the frozen fixtures of 2026-09-25\n1 briefing \| 3 arms \| 2 runs each/);
  });
});

describe('the best arm', () => {
  const rec = (arm: 'markdown' | 'json' | 'none', correct: number, tokens: number): Parameters<typeof summarizeBench>[0][number] => ({ key: `b__${arm}`, briefing: 'b', arm, run: 1, correct, total: 4, tokens, answered: true, statuses: {}, seconds: 1 });
  const meta = { model: 'test', fixtures: '2026-09-25' };
  const lineOf = (records: Parameters<typeof summarizeBench>[0]) => benchLines(summarizeBench(records, meta)).find((l) => l.startsWith('Per 1,000') || l.startsWith('No arm'));

  it('is named only when one arm with data gave more right answers per 1,000 tokens than every other', () => {
    expect(summarizeBench([rec('markdown', 2, 1000), rec('json', 3, 1000), rec('none', 1, 100)], meta).best).toBe('json');
    expect(lineOf([rec('markdown', 2, 1000), rec('json', 3, 1000)])).toBe('Per 1,000 tokens, JSON gave this model the most right answers.');
    // Nothing right in any arm with data: no arm gave the most.
    expect(summarizeBench([rec('markdown', 0, 1000), rec('json', 0, 1200), rec('none', 1, 100)], meta).best).toBeNull();
    expect(lineOf([rec('markdown', 0, 1000), rec('json', 0, 1200), rec('none', 1, 100)])).toBe('No arm with data gave this model a right answer.');
    // As many right answers for as many tokens: a tie, said as one.
    expect(summarizeBench([rec('markdown', 2, 1000), rec('json', 2, 1000)], meta).best).toBeNull();
    expect(lineOf([rec('markdown', 2, 1000), rec('json', 2, 1000)])).toBe('Per 1,000 tokens, markdown and JSON gave this model as many right answers.');
  });
});
