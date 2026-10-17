import { createHash, randomUUID } from 'node:crypto';
import { countTokens } from 'gpt-tokenizer/encoding/o200k_base';
import type { DataBlock, Operation, Packet, PacketFormat } from './types';

// Claude's tokenizer is not published, so packets are counted with OpenAI's
// o200k_base, and the count says so.
export const TOKENIZER_LABEL = 'o200k_base (gpt-tokenizer), a proxy';

export function tokenCount(text: string): number {
  return countTokens(text);
}

// The briefing's own "Generated:" time, from its markdown.
function generatedFromMarkdown(lines: string[]): string | undefined {
  for (const line of lines) {
    const m = /^\*Generated:\s*(.+?)\*$/.exec(line.trim());
    if (m?.[1]) {
      const when = new Date(m[1]);
      return Number.isNaN(when.getTime()) ? m[1] : when.toISOString();
    }
  }
  return undefined;
}

// A markdown briefing as a block of numbered lines. PreReason's markdown has no line
// anchors, so numbering is the environment's job. Blank lines are left out, and the
// MCP's account line is removed before numbering.
export function blockFromMarkdown(id: string, markdown: string, fetchedAt: string, source = 'prereason'): DataBlock {
  const lines = markdown
    .split(/\r?\n/)
    .map((l) => l.replace(/\s+$/, ''))
    .filter((l) => l.length > 0)
    .filter((l, i) => !(i === 0 && /^\[Account: .+ tier\]$/.test(l)));
  const generatedAt = generatedFromMarkdown(lines);
  return { id, source, format: 'markdown', fetchedAt, lines, raw: markdown, ...(generatedAt ? { generatedAt } : {}) };
}

// Keys of the served JSON that describe the response rather than the markets.
const JSON_SKIP = new Set(['_timing', 'briefing_used', 'briefing_metadata', 'metrics', 'correlations', 'date', 'generated_at', 'data_quality']);

// A JSON briefing as a block, one object per line, so its lines are numbered and
// cited exactly like markdown lines.
export function blockFromJson(id: string, body: string | Record<string, unknown>, fetchedAt: string, source = 'prereason'): DataBlock {
  const json = (typeof body === 'string' ? JSON.parse(body) : body) as Record<string, unknown>;
  const meta = (json.briefing_metadata ?? {}) as Record<string, unknown>;
  const lines: string[] = [];
  lines.push(JSON.stringify({ briefing: json.briefing_used ?? id, name: meta.name, date: json.date, generated_at: json.generated_at }));
  for (const [slug, metric] of Object.entries((json.metrics ?? {}) as Record<string, object>)) {
    lines.push(JSON.stringify({ metric: slug, ...metric }));
  }
  for (const [pair, value] of Object.entries((json.correlations ?? {}) as Record<string, object>)) {
    lines.push(JSON.stringify({ correlation: pair, ...value }));
  }
  for (const [key, value] of Object.entries(json)) {
    if (!JSON_SKIP.has(key)) lines.push(JSON.stringify({ [key]: value }));
  }
  if (json.data_quality) lines.push(JSON.stringify({ data_quality: json.data_quality }));
  const generatedAt = typeof json.generated_at === 'string' ? json.generated_at : undefined;
  const raw = typeof body === 'string' ? body : JSON.stringify(body);
  return { id, source, format: 'json', fetchedAt, lines, raw, ...(generatedAt ? { generatedAt } : {}) };
}

export function lineId(block: string, line: number): string {
  return `[${block} L${line}]`;
}

// The packet as the model reads it: the primer, the question, every block with its
// lines numbered, and the schema the answer must match.
// The number a block's line carries: its own position, or the briefing's numbering
// when the block holds only some lines.
export function lineNumber(block: DataBlock, index: number): number {
  return block.numbers?.[index] ?? index + 1;
}

// A packet read for a past day says so after the question, and each briefing says the day
// it stood as of in place of the time PreReason generated it.
export function packetText(primer: string, question: string, blocks: DataBlock[], schema: Record<string, unknown>, notes: string[] = [], asOf?: string): string {
  return layout(primer, question, blocks, schema, notes, asOf, false).text;
}

// With the question last, everything before it is the same for every question asked of the
// same blocks, so a provider can cache that start; cachePrefix is where the question begins.
function layout(primer: string, question: string, blocks: DataBlock[], schema: Record<string, unknown>, notes: string[], asOf: string | undefined, questionLast: boolean): { text: string; cachePrefix?: number } {
  const ask = [`Question: ${question}`, ''];
  if (asOf) ask.push(`As of: ${asOf}. Every line below stands as it stood on that day. Answer as of that day, and give data_as_of as ${asOf}.`, '');
  const parts = [primer.trim(), ''];
  if (!questionLast) parts.push(...ask);
  for (const b of blocks) {
    const when = asOf ? `, as it stood on ${asOf}` : b.generatedAt ? `, generated ${b.generatedAt}` : '';
    parts.push(b.heading ? `${b.heading}:` : `Briefing ${b.id}, ${b.format}${when}${b.numbers ? ', some lines only' : ''}:`);
    b.lines.forEach((line, i) => parts.push(`${lineId(b.id, lineNumber(b, i))} ${line}`));
    parts.push('');
  }
  if (notes.length) parts.push('Left out of this packet:', ...notes.map((n) => `- ${n}`), '');
  const prefix = questionLast ? `${parts.join('\n')}\n` : null;
  if (questionLast) parts.push(...ask);
  parts.push('Return JSON that matches this schema, with nothing outside it:', JSON.stringify(schema));
  return { text: parts.join('\n'), ...(prefix ? { cachePrefix: prefix.length } : {}) };
}

export interface PacketInput {
  operation: Operation;
  question: string;
  blocks: DataBlock[];
  runId?: string;
  notes?: string[];
  asOf?: string; // the past day the blocks were read for
  questionLast?: boolean; // the question after the blocks, so the start can be cached
}

export function buildPacket({ operation, question, blocks, runId, notes = [], asOf, questionLast = false }: PacketInput): Packet {
  const { text, cachePrefix } = layout(operation.primer, question, blocks, operation.schema, notes, asOf, questionLast);
  return {
    runId: runId ?? newRunId(),
    operation: { id: operation.spec.id, version: operation.spec.version },
    question,
    primer: operation.primer,
    blocks,
    schema: operation.schema,
    notes,
    ...(asOf ? { asOf } : {}),
    text,
    ...(cachePrefix ? { cachePrefix } : {}),
    hash: createHash('sha256').update(text).digest('hex'),
    tokens: { label: TOKENIZER_LABEL, count: tokenCount(text) },
  };
}

// A run id that sorts by time: 20260926T134512Z and six random characters.
// A run id as newRunId makes it, so an id handed in from outside can be checked before it
// becomes part of a path.
export const RUN_ID = /^\d{8}T\d{6}Z-[0-9a-f]{6}$/;

export function newRunId(now = new Date()): string {
  const stamp = now.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  return `${stamp}-${randomUUID().slice(0, 6)}`;
}

export function preferredFormat(format: PacketFormat | undefined): PacketFormat {
  return format ?? 'json';
}
