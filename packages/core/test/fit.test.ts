import { mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  Snapshots,
  answersOf,
  benchPacket,
  blockFromJson,
  blockFromMarkdown,
  buildPacket,
  citedLine,
  fitPacket,
  loadOperation,
  readNumber,
  scoreAnswer,
  sectionsFor,
  type BenchFile,
  type DataBlock,
  type ModelCapabilities,
} from '../src/index';

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = join(here, '..', '..', '..');
const ASK = loadOperation(join(ROOT, 'operations', 'ask'));
const FIXTURES = join(ROOT, 'operations', 'bench-comprehension', 'briefings-2026-09-25');
const BENCH = JSON.parse(readFileSync(join(ROOT, 'operations', 'bench-comprehension', 'questions-2026-09-25.json'), 'utf8')) as BenchFile;
const AT = '2026-09-25T09:06:00.000Z';
const md = (id: string) => blockFromMarkdown(id, readFileSync(join(FIXTURES, `${id}.md`), 'utf8'), AT);
const json = (id: string) => blockFromJson(id, readFileSync(join(FIXTURES, `${id}.json`), 'utf8'), AT);
const caps = (context: number | null, max?: number): ModelCapabilities => ({ local: true, schemaConstraint: true, contextTokens: context, canRaiseContext: max !== undefined, maxContextTokens: max ?? null, format: 'json' });

describe('snapshots', () => {
  it('keeps each briefing once per generated time, with file names Windows accepts', () => {
    const root = mkdtempSync(join(tmpdir(), 'primerkit-snap-'));
    const snaps = new Snapshots(root);
    const pulse = json('btc.pulse');
    const path = snaps.save(pulse)!;
    expect(path).not.toMatch(/\d:\d/);
    expect(snaps.save({ ...pulse, raw: 'changed' })).toBe(path);
    expect(readFileSync(path, 'utf8')).toBe(pulse.raw);
    expect(readdirSync(join(root, 'btc.pulse'))).toEqual(['2026-09-25T09-05-46.360Z.json']);
    expect(snaps.latest('btc.pulse', 'json')).toMatchObject({ generatedAt: '2026-09-25T09:05:46.360Z', raw: pulse.raw });
    expect(snaps.latest('btc.pulse', 'json', '2026-09-24T23:59:59Z')).toBeNull();
    expect(snaps.latest('btc.pulse', 'markdown')).toBeNull();
    expect(snaps.save({ ...pulse, raw: undefined })).toBeNull();
  });
});

describe('fitting a packet to the model', () => {
  const three = () => [json('btc.pulse'), json('btc.context'), json('macro.snapshot')];
  const asMarkdown = async (b: DataBlock) => md(b.id);

  it('sends a packet that fits as it is, and raises the context where the model can', async () => {
    const fitted = await fitPacket({ operation: ASK, question: 'Where does Bitcoin stand?', blocks: [json('btc.pulse')], caps: caps(4096, 8192) });
    expect(fitted).toMatchObject({ refused: false, notes: [] });
    expect(fitted.blocks).toHaveLength(1);
  });

  // An ask whose operation holds a packet to its own cap, as the ask operation does at 32,000.
  const capped = (tokens: number) => ({ ...ASK, spec: { ...ASK.spec, data: { ...ASK.spec.data, maxPacketTokens: tokens } } });
  const recorded = () => {
    const reads: string[] = [];
    return { reads, asMarkdown: async (b: DataBlock) => (reads.push(b.id), md(b.id)) };
  };
  const shapes = (blocks: DataBlock[]) => blocks.map((b) => `${b.id} ${b.format}`);

  it('reads a briefing as markdown before leaving it out, and names the cap when the cap is what binds', async () => {
    // The value check of 2026-10-08, R5 and R8: a model with room to spare, held to the
    // operation's cap, left out the briefing the question was about, and the note named the
    // model's context of 200,000 tokens. As markdown, that briefing fits the cap.
    const { reads, asMarkdown } = recorded();
    const question = 'What is the 10 year Treasury yield doing, and how does it move with stocks?';
    const fitted = await fitPacket({ operation: capped(6000), question, blocks: [json('cross.correlations'), json('macro.snapshot')], caps: caps(200_000), asMarkdown });
    expect(fitted.refused).toBe(false);
    expect(shapes(fitted.blocks)).toEqual(['cross.correlations json', 'macro.snapshot markdown']);
    expect(fitted.notes).toEqual(["macro.snapshot was read as markdown, to fit the ask operation's cap of 6,000 tokens a packet."]);
    expect(reads).toEqual(['macro.snapshot']);
    expect(fitted).toMatchObject({ limit: 200_000, cap: 6000 });
    expect(fitted.tokens).toBeLessThanOrEqual(6000);
  });

  it('leaves the least relevant out only when markdown does not fit either, then gives JSON back where it fits', async () => {
    const { reads, asMarkdown } = recorded();
    // 4,300: the ask's primer grew by its background rule (0.2.0) and by the clause that a
    // tenor or a listed index is a name (10-15), and at 4,200 btc.context is now read as
    // markdown too.
    const fitted = await fitPacket({ operation: ASK, question: 'Where does Bitcoin stand?', blocks: three(), caps: caps(4300, 4300), asMarkdown });
    expect(fitted.refused).toBe(false);
    expect(reads).toEqual(['macro.snapshot', 'btc.context', 'btc.pulse']);
    expect(shapes(fitted.blocks)).toEqual(['btc.pulse json', 'btc.context json']);
    expect(fitted.notes).toEqual(["macro.snapshot was not read, to fit the model's context of 4,300 tokens."]);
    expect(fitted.needed).toBeLessThanOrEqual(4300);
    const packet = buildPacket({ operation: ASK, question: 'q', blocks: fitted.blocks, notes: fitted.notes });
    expect(packet.text).toContain("Left out of this packet:\n- macro.snapshot was not read, to fit the model's context of 4,300 tokens.");
  });

  it('names each briefing left out and each read as markdown, with the cap they were for', async () => {
    const fitted = await fitPacket({ operation: capped(3000), question: 'How do yields move with stocks?', blocks: [json('cross.correlations'), json('macro.snapshot')], caps: caps(200_000), asMarkdown });
    expect(fitted.refused).toBe(false);
    expect(shapes(fitted.blocks)).toEqual(['cross.correlations markdown']);
    expect(fitted.notes).toEqual([
      "macro.snapshot was not read, to fit the ask operation's cap of 3,000 tokens a packet.",
      "cross.correlations was read as markdown, to fit the ask operation's cap of 3,000 tokens a packet.",
    ]);
  });

  it('names both bounds when the packet as read is over both', async () => {
    const fitted = await fitPacket({ operation: capped(3000), question: 'Where does Bitcoin stand?', blocks: three(), caps: caps(4096, 4096), asMarkdown });
    expect(fitted.notes[0]).toBe("macro.snapshot was not read, to fit the model's context of 4,096 tokens and the ask operation's cap of 3,000 tokens a packet.");
  });

  it('then reads markdown in place of JSON', async () => {
    const fitted = await fitPacket({ operation: ASK, question: 'Where does Bitcoin stand?', blocks: [json('macro.snapshot')], caps: caps(3072, 3072), asMarkdown });
    expect(fitted.blocks[0]?.format).toBe('markdown');
    expect(fitted.notes).toContain("macro.snapshot was read as markdown, to fit the model's context of 3,072 tokens.");
  });

  it('then reads only the sections on the metrics the question names, keeping their line numbers', async () => {
    const question = 'What is the 10 year Treasury yield doing?';
    const fitted = await fitPacket({ operation: ASK, question, blocks: [json('macro.snapshot')], caps: caps(2048, 2048), asMarkdown });
    const block = fitted.blocks[0]!;
    expect(fitted.notes.at(-1)).toMatch(/^Only the sections on the metrics the question names were read/);
    expect(block.numbers).toBeDefined();
    expect(block.lines.some((l) => l.startsWith('### 10Y Treasury Yield'))).toBe(true);
    expect(block.lines.some((l) => l.startsWith('### Fed Balance Sheet'))).toBe(false);
    const at = block.lines.findIndex((l) => l.startsWith('10Y Treasury yield at'));
    const packet = buildPacket({ operation: ASK, question, blocks: [block] });
    expect(citedLine(packet, 'macro.snapshot', block.numbers![at]!)).toBe(md('macro.snapshot').lines[16]);
    expect(packet.text).toContain(`[macro.snapshot L17] ${md('macro.snapshot').lines[16]}`);
  });

  it('refuses a packet that still does not fit, and says what context it needs', async () => {
    const fitted = await fitPacket({ operation: ASK, question: 'Where does Bitcoin stand?', blocks: [json('btc.pulse')], caps: caps(1200, 1200), asMarkdown });
    expect(fitted.refused).toBe(true);
    expect(fitted.needed).toBeGreaterThan(1200);
  });

  it('narrows a JSON block to its header, the metrics named, their correlations and its data quality', () => {
    const block = sectionsFor(json('macro.snapshot'), 'Where is net liquidity?');
    expect(block.lines.map((l) => (JSON.parse(l) as Record<string, unknown>).metric ?? Object.keys(JSON.parse(l) as object)[0])).toEqual(['briefing', 'net-liquidity', 'correlation', 'data_quality']);
    expect(sectionsFor(json('macro.snapshot'), 'Tell me a joke')).toEqual(json('macro.snapshot'));
  });
});

describe('the benchmark slice', () => {
  const pulse = BENCH.briefings.find((b) => b.briefing === 'btc.pulse')!;
  const q = (id: string) => pulse.questions.find((x) => x.id === id)!;

  it('scores answers as the comprehension benchmark does', () => {
    expect(readNumber('$84,512.32')).toBe(84512.32);
    expect(readNumber('−2.1%')).toBe(-2.1);
    expect(scoreAnswer(q('q01'), 84512.32)).toBe('correct');
    expect(scoreAnswer(q('q01'), '$84,512')).toBe('correct');
    expect(scoreAnswer(q('q01'), 80000)).toBe('wrong');
    expect(scoreAnswer(q('q03'), '2026-09-25')).toBe('correct');
    expect(scoreAnswer(q('q07'), 'Yes')).toBe('correct');
    expect(scoreAnswer(q('q07'), 'maybe')).toBe('unreadable');
    expect(scoreAnswer(q('q01'), null)).toBe('missing');
  });

  it('builds a packet whose schema asks for every question, and reads the reply', () => {
    const qs = pulse.questions.slice(0, 3);
    const packet = benchPacket(pulse, qs, 'markdown', md('btc.pulse').raw!, 'r');
    expect(packet.text).toContain('q01 [number; unit: US dollars] What is the latest value of Bitcoin Price (bitcoin-price)?');
    expect(packet.text).toContain('Reference time (when the data was generated): 2026-09-25 09:05 UTC.');
    expect((packet.schema.properties as { answers: { required: string[] } }).answers.required).toEqual(['q01', 'q02', 'q03']);
    expect(answersOf('```json\n{"answers": {"q01": 1}}\n```')).toEqual({ q01: 1 });
    expect(answersOf('Here you go: {"answers": {"q02": "x"}} thanks')).toEqual({ q02: 'x' });
    expect(answersOf('nothing')).toBeNull();
  });
});
