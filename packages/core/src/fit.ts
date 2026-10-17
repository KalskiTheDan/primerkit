import { buildPacket } from './packet';
import type { DataBlock, ModelCapabilities, Operation } from './types';

// Fitting a packet to the model's context and to the operation's own cap on a packet.
// Raise first, where the runtime allows it; then shrink in a fixed order and say so:
// markdown in place of JSON, the least relevant briefing first, so a briefing is read in
// fewer tokens before any is left out; then fewer briefings; then JSON again for those
// still read, where it fits; then only the sections on the metrics the question names.
// A packet that still does not fit is not sent, and the result names the context it
// would need. Every block left out is named, to the model in the packet and on screen,
// with the bound it was left out for: the model's context, the operation's cap, or both.

export const ANSWER_ROOM = 1024;
// Packets are counted with a proxy tokenizer; a model's own may count more.
export const PROXY_MARGIN = 1.15;

export interface FitOptions {
  operation: Operation;
  question: string;
  blocks: DataBlock[]; // the most relevant first
  caps: ModelCapabilities;
  // The same briefing as markdown, fetched when the JSON will not fit.
  asMarkdown?: (block: DataBlock) => Promise<DataBlock>;
}

export interface Fitted {
  blocks: DataBlock[];
  notes: string[];
  tokens: number; // the fitted packet, as the proxy tokenizer counts it
  needed: number; // the context the fitted packet needs, with room for the answer
  limit: number | null; // the most context this model can give; null when unknown
  cap: number | null; // the operation's own cap on a packet; null when it has none
  refused: boolean;
}

export function contextNeeded(operation: Operation, question: string, blocks: DataBlock[], notes: string[]): { tokens: number; needed: number } {
  const tokens = buildPacket({ operation, question, blocks, notes, runId: 'fit' }).tokens.count;
  return { tokens, needed: Math.ceil(tokens * PROXY_MARGIN) + ANSWER_ROOM };
}

const thousands = (n: number): string => n.toLocaleString('en-US');

export async function fitPacket(opts: FitOptions): Promise<Fitted> {
  const limit = opts.caps.maxContextTokens ?? opts.caps.contextTokens;
  const cap = opts.operation.spec.data.maxPacketTokens ?? null;
  const asRead = opts.blocks; // each block as it was read, the most relevant first
  let blocks = asRead.slice();
  const left: string[] = []; // the briefings not read, the least relevant first
  let narrowed = false;
  let room = '';
  // The notes say what the packet holds now, so they are written from it at each measure.
  const notes = (): string[] => {
    const markdown = blocks.filter((b, i) => b.format === 'markdown' && asRead[i]?.format === 'json').map((b) => b.id);
    return [
      ...left.map((id) => `${id} was not read, to fit ${room}.`),
      ...(markdown.length ? [`${markdown.join(', ')} ${markdown.length === 1 ? 'was' : 'were'} read as markdown, to fit ${room}.`] : []),
      ...(narrowed ? [`Only the sections on the metrics the question names were read, to fit ${room}.`] : []),
    ];
  };
  const measure = () => contextNeeded(opts.operation, opts.question, blocks, notes());
  const overContext = (m: { needed: number }) => limit !== null && m.needed > limit;
  const overCap = (m: { tokens: number }) => cap !== null && m.tokens > cap;
  const fits = (m: { tokens: number; needed: number }) => !overContext(m) && !overCap(m);
  const fitted = (m: { tokens: number; needed: number }): Fitted => ({ blocks, notes: notes(), tokens: m.tokens, needed: m.needed, limit, cap, refused: !fits(m) });

  let m = measure();
  if (fits(m)) return fitted(m);
  // The bound the packet as read is over, named in every note: a model with a large
  // context can still be held to the operation's cap.
  room = [
    ...(overContext(m) ? [`the model's context of ${thousands(limit!)} tokens`] : []),
    ...(overCap(m) ? [`the ${opts.operation.spec.id} operation's cap of ${thousands(cap!)} tokens a packet`] : []),
  ].join(' and ');

  // 1. Markdown in place of JSON, the least relevant briefing first: a briefing read in
  // fewer tokens is kept rather than left out. A metric is markdown already.
  if (opts.asMarkdown) {
    for (let i = blocks.length - 1; i >= 0 && !fits(m); i -= 1) {
      const b = blocks[i] as DataBlock;
      if (b.format !== 'json') continue;
      blocks[i] = await opts.asMarkdown(b);
      m = measure();
    }
  }
  // 2. Fewer briefings: the least relevant go first.
  while (blocks.length > 1 && !fits(m)) {
    left.push((blocks.pop() as DataBlock).id);
    m = measure();
  }
  // 3. JSON again, the most relevant first, wherever it fits once the rest are in.
  for (let i = 0; i < blocks.length && fits(m); i += 1) {
    const read = blocks[i] as DataBlock;
    if (read === asRead[i]) continue;
    blocks[i] = asRead[i] as DataBlock;
    const again = measure();
    if (fits(again)) m = again;
    else blocks[i] = read;
  }
  // 4. Only the sections on the metrics the question names.
  if (!fits(m)) {
    const sections = blocks.map((b) => sectionsFor(b, opts.question));
    if (sections.some((b, i) => b.lines.length < (blocks[i]?.lines.length ?? 0))) {
      blocks = sections;
      narrowed = true;
      m = measure();
    }
  }
  return fitted(m);
}

// Words that say which metric a question is about, three letters or more.
const STOP = new Set('the and are for from has have how its now over this that what when where which with does doing into than then there these they will your about since today'.split(' '));

function wordsOf(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((w) => w.length >= 3 && !STOP.has(w)),
  );
}

const touches = (text: string, words: Set<string>) => [...wordsOf(text)].some((w) => words.has(w));

// A block cut to its header and the sections on the metrics the question names. The
// lines keep the briefing's own numbers. A block where no section matches is kept whole.
export function sectionsFor(block: DataBlock, question: string): DataBlock {
  const words = wordsOf(question);
  const keep: number[] = [];
  if (block.format === 'json') {
    block.lines.forEach((line, i) => {
      if (i === 0 || line.startsWith('{"data_quality"')) return keep.push(i);
      const named = /^\{"(?:metric|correlation)":"([^"]+)"/.exec(line)?.[1];
      if (named && touches(named.replace(/[-_]/g, ' '), words)) keep.push(i);
      return undefined;
    });
  } else {
    let section: number[] = [];
    let heading = '';
    const flush = () => {
      if (heading && touches(heading, words)) keep.push(...section);
      section = [];
      heading = '';
    };
    block.lines.forEach((line, i) => {
      if (/^#{1,2}\s/.test(line)) {
        flush();
        if (!keep.length || /^#\s/.test(line)) keep.push(i); // the title and the header lines
      } else if (/^###\s/.test(line)) {
        flush();
        heading = line;
        section = [i];
      } else if (heading) {
        section.push(i);
      } else if (keep.length && keep.at(-1) === i - 1) {
        keep.push(i);
      }
    });
    flush();
  }
  const matched = keep.length > (block.format === 'json' ? 2 : 4);
  if (!matched || keep.length === block.lines.length) return block;
  const numbers = keep.map((i) => block.numbers?.[i] ?? i + 1);
  return { ...block, lines: keep.map((i) => block.lines[i] as string), numbers };
}
