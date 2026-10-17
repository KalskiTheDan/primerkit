import type { CheckFailure, ModelAdapter, ModelCapabilities, ModelReply, Packet, TokenPrice } from '@primerkit/core';
import { ModelError, SYSTEM_PROMPT, bareSchema, errorText, reach, repairMessage } from './chat';
import { listPrice } from './prices';

export interface AnthropicOptions {
  apiKey: string;
  model: string; // "claude-sonnet-5-5"
  baseUrl?: string;
  contextTokens?: number;
  fetch?: typeof fetch;
}

const VERSION = '2023-06-01';

// How the answer is held to the schema. `format`: structured outputs, the answer is the reply's
// text, on the models that have them (Claude's 5 line, Opus 4.8, Haiku 4.5). `tool`: a tool the
// model must call, whose input is the answer, at temperature 0, for older models; the newest
// models refuse a forced tool call, and some refuse any temperature, each with a 400. Each step
// down is taken only on the API's own 400 naming what it refused, and the step that answered is
// kept for that model while primerkit runs.
type Mode = 'format' | 'tool' | 'tool-no-temperature';
const MODES = new Map<string, Mode>();

function stepDown(mode: Mode, message: string): Mode | null {
  if (mode === 'format' && /output_config|output_format|json_schema|structured output/i.test(message)) return 'tool';
  if (mode === 'tool' && /temperature/i.test(message)) return 'tool-no-temperature';
  return null;
}

// Structured outputs take a narrower schema: every object closed, and no length, number or
// larger array bounds. The checks still hold the answer to the whole schema afterwards.
const DROPPED = new Set(['minLength', 'maxLength', 'pattern', 'minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'multipleOf', 'maxItems']);
export function formatSchema(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(formatSchema);
  if (!schema || typeof schema !== 'object') return schema;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(schema as Record<string, unknown>)) {
    if (DROPPED.has(key)) continue;
    if (key === 'minItems' && typeof value === 'number' && value > 1) continue;
    out[key] = key === 'properties' && value && typeof value === 'object'
      ? Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([name, sub]) => [name, formatSchema(sub)]))
      : formatSchema(value);
  }
  if (out.type === 'object' || out.properties) out.additionalProperties = false;
  return out;
}

// Claude through Anthropic's Messages API, with the person's own key.
export class AnthropicModel implements ModelAdapter {
  readonly id: string;
  readonly label: string;
  readonly price: TokenPrice | null;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: AnthropicOptions) {
    this.baseUrl = (options.baseUrl ?? 'https://api.anthropic.com/v1').replace(/\/$/, '');
    this.fetchImpl = options.fetch ?? fetch;
    this.id = `anthropic:${options.model}`;
    this.label = `${options.model}, Anthropic`;
    // Its list price, where primerkit knows it, so a run's cost is named from the tokens reported.
    this.price = listPrice(options.model);
  }

  async capabilities(): Promise<ModelCapabilities> {
    // JSON reads best for Claude.
    return { local: false, schemaConstraint: true, contextTokens: this.options.contextTokens ?? 200_000, canRaiseContext: false, maxContextTokens: null, format: 'json' };
  }

  private request(mode: Mode, packet: Packet, content: string | ContentBlock[]): Record<string, unknown> {
    const common = { model: this.options.model, system: SYSTEM_PROMPT, messages: [{ role: 'user', content }] };
    // Thinking counts against max_tokens on the models that think, so the format step leaves room.
    if (mode === 'format') return { ...common, max_tokens: 16_000, output_config: { format: { type: 'json_schema', schema: formatSchema(bareSchema(packet.schema)) } } };
    return {
      ...common,
      max_tokens: 4096,
      ...(mode === 'tool' ? { temperature: 0 } : {}),
      tools: [{ name: 'answer', description: 'Return the answer, matching the schema.', input_schema: bareSchema(packet.schema) }],
      tool_choice: { type: 'tool', name: 'answer' },
    };
  }

  async complete(packet: Packet, repair?: CheckFailure[], signal?: AbortSignal): Promise<ModelReply> {
    const repairText = repairMessage(repair);
    const content = cached(repairText ? `${packet.text}\n\n${repairText}` : packet.text, packet.cachePrefix);
    const key = `${this.baseUrl} ${this.options.model}`;
    let mode: Mode = MODES.get(key) ?? 'format';
    let first: string | null = null;
    for (;;) {
      const res = await reach(this.fetchImpl, `${this.baseUrl}/messages`, {
        method: 'POST',
        ...(signal ? { signal } : {}),
        headers: { 'Content-Type': 'application/json', 'x-api-key': this.options.apiKey, 'anthropic-version': VERSION },
        body: JSON.stringify(this.request(mode, packet, content)),
      }, 'Anthropic');
      if (res.ok) {
        MODES.set(key, mode);
        return read((await res.json()) as AnthropicBody);
      }
      const message = await errorText(res);
      const next = res.status === 400 ? stepDown(mode, message) : null;
      if (!next) throw new ModelError(`Anthropic answered ${res.status}: ${message}${first ? ` (asked first with structured outputs: ${first})` : ''}`, res.status);
      first ??= message;
      mode = next;
    }
  }
}

type ContentBlock = { type: 'text'; text: string; cache_control?: { type: 'ephemeral' } };

// A packet whose start is the same for every question (the pick step's catalog) sends that
// start as its own block, marked for Anthropic's cache: the first question pays a quarter more
// for that start, and the next within five minutes reads it at a tenth of the price or less. A
// start too short for the model's minimum is simply not cached. Every other packet goes as one
// string, as before.
function cached(text: string, prefix: number | undefined): string | ContentBlock[] {
  if (!prefix || prefix >= text.length) return text;
  return [
    { type: 'text', text: text.slice(0, prefix), cache_control: { type: 'ephemeral' } },
    { type: 'text', text: text.slice(prefix) },
  ];
}

interface AnthropicBody {
  content?: Array<{ type?: string; name?: string; input?: unknown; text?: string }>;
  model?: string;
  stop_reason?: string;
  usage?: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number };
}

function read(body: AnthropicBody): ModelReply {
  if (body.stop_reason === 'refusal') throw new ModelError('Claude declined to answer this packet (stop reason: refusal)');
  const call = body.content?.find((c) => c.type === 'tool_use' && c.name === 'answer');
  const text = call ? JSON.stringify(call.input) : body.content?.find((c) => c.type === 'text')?.text;
  // A tool answer cut off by the cap is cut off too: its input is unfinished.
  if (body.stop_reason === 'max_tokens') throw new ModelError('Claude ran out of room before its answer was finished (stop reason: max_tokens)');
  if (typeof text !== 'string') throw new ModelError('Anthropic returned no answer');
  return {
    text,
    ...(body.model ? { modelReported: body.model } : {}),
    ...(body.usage ? { usage: usageOf(body.usage) } : {}),
  };
}

function usageOf(u: NonNullable<AnthropicBody['usage']>): NonNullable<ModelReply['usage']> {
  return {
    inputTokens: u.input_tokens,
    outputTokens: u.output_tokens,
    ...(u.cache_read_input_tokens ? { cacheReadTokens: u.cache_read_input_tokens } : {}),
    ...(u.cache_creation_input_tokens ? { cacheWriteTokens: u.cache_creation_input_tokens } : {}),
  };
}

export async function listAnthropicModels(apiKey: string, fetchImpl: typeof fetch = fetch, baseUrl = 'https://api.anthropic.com/v1'): Promise<string[]> {
  const res = await fetchImpl(`${baseUrl.replace(/\/$/, '')}/models?limit=100`, { headers: { 'x-api-key': apiKey, 'anthropic-version': VERSION } });
  if (!res.ok) throw new ModelError(`the model list answered ${res.status}: ${await errorText(res)}`, res.status);
  const body = (await res.json()) as { data?: Array<{ id?: string; created_at?: string }> };
  return (body.data ?? [])
    .filter((m): m is { id: string; created_at?: string } => typeof m.id === 'string')
    .sort((a, b) => (b.created_at ?? '').localeCompare(a.created_at ?? ''))
    .map((m) => m.id);
}
