import type { CheckFailure, ModelAdapter, ModelCapabilities, ModelReply, Packet } from '@primerkit/core';
import { ModelError, chatMessages, errorText, isLocalUrl, localFetch, reach } from './chat';
import { autoCap, shapeOf, type ModelShape } from './context';

export const OLLAMA_URL = 'http://127.0.0.1:11434';
// Ollama's own default context below 24 GiB of graphics memory, which covers most machines.
export const OLLAMA_DEFAULT_CONTEXT = 4096;
// The cap a label shows before the model has been asked for its shape.
export const OLLAMA_DEFAULT_CAP = 8192;
// Room kept for the answer, and a margin because packets are counted with a proxy tokenizer.
export const ANSWER_TOKENS = 1024;
export const PROXY_MARGIN = 1.15;

export interface OllamaOptions {
  baseUrl?: string;
  model: string;
  contextTokens?: number; // where a request starts: Ollama's default
  // The person's own cap, from the config. Without one, the cap is found from the model
  // and this machine's memory.
  maxContextTokens?: number;
  memoryBytes?: number; // this machine's memory, for tests
  fetch?: typeof fetch;
}

// The context a packet needs, in whole thousands, with the answer's room and the margin.
export function contextFor(packetTokens: number, base: number, max: number): number {
  const needed = Math.ceil((packetTokens * PROXY_MARGIN + ANSWER_TOKENS) / 1024) * 1024;
  return Math.min(max, Math.max(base, needed));
}

// Ollama through its own API: the context is set per request (num_ctx) and raised only
// as far as a packet needs, the schema goes through format, and it runs at temperature
// 0.
export class OllamaModel implements ModelAdapter {
  readonly id: string;
  private readonly baseUrl: string;
  private readonly base: number;
  private readonly fetchImpl: typeof fetch;
  private shape: Promise<ModelShape> | null = null;
  private found: number | null = null; // the cap, once the model has been asked

  constructor(private readonly options: OllamaOptions) {
    this.baseUrl = (options.baseUrl ?? OLLAMA_URL).replace(/\/$/, '');
    this.base = options.contextTokens ?? OLLAMA_DEFAULT_CONTEXT;
    this.fetchImpl = options.fetch ?? localFetch;
    this.id = `ollama:${options.model}`;
  }

  // "qwen2.5:7b, local, 32k": the cap once it is known, the default until then.
  get label(): string {
    const cap = this.found ?? this.options.maxContextTokens ?? OLLAMA_DEFAULT_CAP;
    return `${this.options.model}, local, ${Math.round(cap / 1024)}k`;
  }

  // The model's limit, its layer shape and its size, as Ollama reports them.
  modelShape(): Promise<ModelShape> {
    const post = (path: string) =>
      this.fetchImpl(`${this.baseUrl}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model: this.options.model }) });
    this.shape ??= Promise.all([
      post('/api/show')
        .then(async (res) => (res.ok ? (((await res.json()) as { model_info?: Record<string, unknown> }).model_info ?? {}) : {}))
        .catch(() => ({})),
      this.fetchImpl(`${this.baseUrl}/api/tags`)
        .then(async (res) => (res.ok ? ((await res.json()) as { models?: Array<{ name?: string; size?: number }> }).models ?? [] : []))
        .catch(() => []),
    ]).then(([info, models]) => {
      const size = models.find((m) => m.name === this.options.model || m.name === `${this.options.model}:latest`)?.size;
      return shapeOf(info, typeof size === 'number' ? size : null);
    });
    return this.shape;
  }

  // Kept for callers that need only the model's own limit.
  async modelLimit(): Promise<number | null> {
    return (await this.modelShape()).limit;
  }

  async capabilities(): Promise<ModelCapabilities> {
    const shape = await this.modelShape();
    const own = this.options.maxContextTokens;
    const max = own ? Math.max(this.base, Math.min(own, shape.limit ?? own)) : autoCap(shape, this.options.memoryBytes);
    this.found = max;
    return {
      local: isLocalUrl(this.baseUrl),
      schemaConstraint: true,
      contextTokens: Math.min(this.base, max),
      canRaiseContext: max > this.base,
      maxContextTokens: max,
      // JSON reads best where the context holds it; a small context gets markdown.
      format: max >= 8192 ? 'json' : 'markdown',
    };
  }

  async complete(packet: Packet, repair?: CheckFailure[], signal?: AbortSignal): Promise<ModelReply> {
    const caps = await this.capabilities();
    const numCtx = contextFor(packet.tokens.count, caps.contextTokens ?? this.base, caps.maxContextTokens ?? OLLAMA_DEFAULT_CAP);
    const res = await reach(
      this.fetchImpl,
      `${this.baseUrl}/api/chat`,
      {
        method: 'POST',
        ...(signal ? { signal } : {}),
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: this.options.model,
          stream: false,
          format: packet.schema,
          options: { temperature: 0, num_ctx: numCtx },
          messages: chatMessages(packet, repair),
        }),
      },
      'Ollama',
    );
    if (!res.ok) throw new ModelError(`Ollama answered ${res.status}: ${await errorText(res)}`, res.status);
    const body = (await res.json()) as { message?: { content?: string }; model?: string; prompt_eval_count?: number; eval_count?: number };
    const text = body.message?.content;
    if (typeof text !== 'string') throw new ModelError('Ollama returned no message');
    return {
      text,
      ...(body.model ? { modelReported: body.model } : {}),
      usage: { inputTokens: body.prompt_eval_count, outputTokens: body.eval_count },
    };
  }
}

export interface PullProgress {
  status: string;
  completed?: number;
  total?: number;
}

// Downloads a model through Ollama's own API, reporting its progress, for a model name
// the person typed that Ollama does not have yet.
export async function pullOllamaModel(model: string, onProgress: (p: PullProgress) => void, options: { baseUrl?: string; fetch?: typeof fetch; signal?: AbortSignal } = {}): Promise<void> {
  const res = await reach(
    options.fetch ?? fetch,
    `${(options.baseUrl ?? OLLAMA_URL).replace(/\/$/, '')}/api/pull`,
    {
      method: 'POST',
      ...(options.signal ? { signal: options.signal } : {}),
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, stream: true }),
    },
    'Ollama',
  );
  if (!res.ok || !res.body) throw new ModelError(`Ollama answered ${res.status}: ${await errorText(res)}`, res.status);
  const decoder = new TextDecoder();
  let buffer = '';
  let done = false;
  const handle = (line: string) => {
    if (!line.trim()) return;
    const event = JSON.parse(line) as PullProgress & { error?: string };
    if (event.error) throw new ModelError(`Ollama could not pull ${model}: ${event.error}`);
    onProgress({ status: event.status, ...(event.completed !== undefined ? { completed: event.completed } : {}), ...(event.total !== undefined ? { total: event.total } : {}) });
    if (event.status === 'success') done = true;
  };
  for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
    buffer += decoder.decode(chunk, { stream: true });
    let at: number;
    while ((at = buffer.indexOf('\n')) >= 0) {
      handle(buffer.slice(0, at));
      buffer = buffer.slice(at + 1);
    }
  }
  handle(buffer);
  if (!done) throw new ModelError(`Ollama stopped before ${model} was pulled`);
}
