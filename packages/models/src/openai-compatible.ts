import type { CheckFailure, ModelAdapter, ModelCapabilities, ModelReply, Packet } from '@primerkit/core';
import { ModelError, bareSchema, chatMessages, errorText, isLocalUrl, localFetch, reach, serverUrl, strictCompatible } from './chat';
import { servedContextOf } from './context';
import { chatModels } from './providers';

export interface OpenAICompatibleOptions {
  baseUrl: string; // LM Studio's http://localhost:1234/v1, or a provider's API
  model: string;
  apiKey?: string | null; // a hosted provider's key; a local server takes none
  provider?: string; // "OpenAI", for the label
  contextTokens?: number; // set by the person, for a server that reports none
  defaultContext?: number; // a provider's usual context, where its list reports none
  fetch?: typeof fetch;
}

// How the answer is held to the schema, strongest first. A runtime that refuses one
// is asked with the next, and the checks enforce the schema whichever is used.
const SCHEMA_MODES = ['json_schema', 'json_object', 'none'] as const;
type SchemaMode = (typeof SCHEMA_MODES)[number];

// Any server that speaks the OpenAI API: a local one (LM Studio, llama.cpp's server,
// vLLM) or a hosted provider with the person's key (OpenAI, Google, xAI, DeepSeek,
// Mistral, Groq, OpenRouter).
export class OpenAICompatibleModel implements ModelAdapter {
  readonly id: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private mode: SchemaMode = 'json_schema';
  private temperature = true;
  private detected: Promise<{ tokens: number | null; provisional: boolean } | null> | null = null;
  private found: number | null = null;

  constructor(private readonly options: OpenAICompatibleOptions) {
    this.baseUrl = serverUrl(options.baseUrl).replace(/\/$/, '');
    this.fetchImpl = options.fetch ?? localFetch;
    const local = isLocalUrl(this.baseUrl);
    this.id = local ? `local:${this.baseUrl}:${options.model}` : `${(options.provider ?? 'remote').toLowerCase()}:${options.model}`;
  }

  get label(): string {
    const local = isLocalUrl(this.baseUrl);
    const ctx = this.found ?? this.options.contextTokens;
    const size = local && ctx ? `, ${Math.round(ctx / 1024)}k` : '';
    return `${this.options.model}, ${local ? 'local' : (this.options.provider ?? new URL(this.baseUrl).host)}${size}`;
  }

  // The context: the person's setting, else what the server or provider reports for the
  // model, else the provider's usual context.
  async capabilities(): Promise<ModelCapabilities> {
    this.detected ??= this.options.contextTokens ? Promise.resolve(null) : servedContextOf(this.baseUrl, this.options.model, this.options.apiKey ?? null, this.fetchImpl, Boolean(this.options.provider));
    const served = await this.detected;
    // A model LM Studio has not loaded yet is asked about again next time: it loads on the
    // first call, with the context it is then given.
    if (served?.provisional) this.detected = null;
    const ctx = this.options.contextTokens ?? served?.tokens ?? this.options.defaultContext ?? null;
    this.found = ctx;
    return {
      local: isLocalUrl(this.baseUrl),
      schemaConstraint: this.mode !== 'none',
      contextTokens: ctx,
      canRaiseContext: false,
      maxContextTokens: null,
      format: ctx !== null && ctx < 8192 ? 'markdown' : 'json',
    };
  }

  private headers(): Record<string, string> {
    return { 'Content-Type': 'application/json', ...(this.options.apiKey ? { Authorization: `Bearer ${this.options.apiKey}` } : {}) };
  }

  private body(packet: Packet, repair?: CheckFailure[]): Record<string, unknown> {
    const schema = bareSchema(packet.schema);
    const format =
      this.mode === 'json_schema'
        ? { response_format: { type: 'json_schema', json_schema: { name: 'answer', schema, strict: strictCompatible(schema) } } }
        : this.mode === 'json_object'
          ? { response_format: { type: 'json_object' } }
          : {};
    return { model: this.options.model, messages: chatMessages(packet, repair), ...(this.temperature ? { temperature: 0 } : {}), ...format };
  }

  async complete(packet: Packet, repair?: CheckFailure[], signal?: AbortSignal): Promise<ModelReply> {
    for (;;) {
      const res = await reach(
        this.fetchImpl,
        `${this.baseUrl}/chat/completions`,
        { method: 'POST', ...(signal ? { signal } : {}), headers: this.headers(), body: JSON.stringify(this.body(packet, repair)) },
        this.options.provider ?? 'The model server',
      );
      if (res.ok) {
        const body = (await res.json()) as { choices?: Array<{ message?: { content?: string | null; refusal?: string | null }; finish_reason?: string }>; model?: string; usage?: { prompt_tokens?: number; completion_tokens?: number } };
        const choice = body.choices?.[0];
        const text = choice?.message?.content;
        // An answer cut off at the length the server allows is unfinished, and a refusal is
        // said in the model's own words, as the Anthropic adapter says them.
        if (choice?.finish_reason === 'length') throw new ModelError('the model ran out of room before its answer was finished (finish reason: length)');
        if (typeof choice?.message?.refusal === 'string' && choice.message.refusal.trim()) throw new ModelError(`the model declined to answer this packet: ${choice.message.refusal.trim()}`);
        if (typeof text !== 'string') throw new ModelError('the model returned no message');
        return {
          text,
          ...(body.model ? { modelReported: body.model } : {}),
          ...(body.usage ? { usage: { inputTokens: body.usage.prompt_tokens, outputTokens: body.usage.completion_tokens } } : {}),
        };
      }
      const message = await errorText(res);
      // Some models take only their default temperature; some runtimes take no schema.
      if (res.status === 400 && this.temperature && /temperature/i.test(message)) {
        this.temperature = false;
        continue;
      }
      const next = SCHEMA_MODES[SCHEMA_MODES.indexOf(this.mode) + 1];
      if (res.status === 400 && next && /response_format|json_schema|json_object|schema|structured/i.test(message)) {
        this.mode = next;
        continue;
      }
      throw new ModelError(`${this.options.provider ?? 'the model server'} answered ${res.status}: ${message}`, res.status);
    }
  }
}

// The chat models a provider or server lists, newest first where it says when.
export async function listOpenAICompatibleModels(baseUrl: string, apiKey: string | null, fetchImpl: typeof fetch = fetch): Promise<string[]> {
  const res = await fetchImpl(`${baseUrl.replace(/\/$/, '')}/models`, { headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {} });
  if (!res.ok) throw new ModelError(`the model list answered ${res.status}: ${await errorText(res)}`, res.status);
  const body = (await res.json()) as { data?: Array<{ id?: string; created?: number }> };
  const models = (body.data ?? []).filter((m): m is { id: string; created?: number } => typeof m.id === 'string');
  models.sort((a, b) => (b.created ?? 0) - (a.created ?? 0));
  return chatModels(models.map((m) => m.id));
}
