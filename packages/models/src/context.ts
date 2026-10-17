import { totalmem } from 'node:os';

// How much context a model can be given, found from the model and the machine rather
// than fixed. An Ollama model reports its own limit and its layer shape; the machine's
// memory says how much of that its key and value cache can use. A server or a provider
// reports a context figure where its model list carries one.

export const MIN_CONTEXT = 4096;
// The most primerkit asks of a local model, whatever it could hold: a longer context
// makes every answer slower to start, and packets are far smaller.
export const MAX_LOCAL_CONTEXT = 32768;

export interface ModelShape {
  limit: number | null; // the model's own context limit
  kvBytesPerToken: number | null; // the key and value cache one token of context takes
  weightsBytes: number | null; // the model's size in memory, near its size on disk
}

// Reads an Ollama model's shape from what /api/show reports.
export function shapeOf(modelInfo: Record<string, unknown>, weightsBytes: number | null): ModelShape {
  const num = (suffix: string): number | null => {
    const key = Object.keys(modelInfo).find((k) => k.endsWith(suffix));
    const n = key ? Number(modelInfo[key]) : NaN;
    return Number.isFinite(n) && n > 0 ? n : null;
  };
  const layers = num('.block_count');
  const heads = num('.attention.head_count');
  const kvHeads = num('.attention.head_count_kv') ?? heads;
  const width = num('.embedding_length');
  const headDim = num('.attention.key_length') ?? (width && heads ? width / heads : null);
  // Keys and values, two bytes each at Ollama's default f16 cache.
  const kvBytesPerToken = layers && kvHeads && headDim ? 2 * layers * kvHeads * headDim * 2 : null;
  return { limit: num('.context_length'), kvBytesPerToken, weightsBytes };
}

// The context an Ollama model can be given on this machine: its own limit, within what
// the memory left after its weights can hold for the cache (six tenths of the machine's
// memory, the rest kept for the system and other programs), within the local maximum, in
// whole thousands, and never below Ollama's own default.
export function autoCap(shape: ModelShape, memoryBytes = totalmem()): number {
  let cap = Math.min(shape.limit ?? MAX_LOCAL_CONTEXT, MAX_LOCAL_CONTEXT);
  if (shape.kvBytesPerToken) {
    const room = memoryBytes * 0.6 - (shape.weightsBytes ?? 0) * 1.1 - 512 * 1024 * 1024;
    cap = Math.min(cap, Math.floor(Math.max(0, room) / shape.kvBytesPerToken));
  }
  return Math.max(MIN_CONTEXT, Math.floor(cap / 1024) * 1024);
}

// The fields servers and providers use for a model's context in their model lists:
// vLLM's max_model_len, OpenRouter's context_length, Groq's context_window, Mistral's
// max_context_length, and LM Studio's loaded_context_length (what it was loaded with).
const CONTEXT_FIELDS = ['loaded_context_length', 'max_model_len', 'context_length', 'context_window', 'max_context_length', 'max_input_tokens'];

export function contextFromListing(entry: Record<string, unknown> | undefined): number | null {
  if (!entry) return null;
  for (const field of CONTEXT_FIELDS) {
    const n = Number(entry[field]);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return null;
}

async function getJson(fetchImpl: typeof fetch, url: string, headers: Record<string, string>): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 3000);
  try {
    const res = await fetchImpl(url, { headers, signal: controller.signal });
    return res.ok ? await res.json() : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// The context a server or provider reports for a model, or null where it reports none.
// LM Studio's own API says what a model was loaded with; the OpenAI style list says what
// vLLM, OpenRouter, Groq and Mistral report; llama.cpp's server says its n_ctx.
export async function servedContext(baseUrl: string, model: string, apiKey: string | null, fetchImpl: typeof fetch = fetch): Promise<number | null> {
  return (await servedContextOf(baseUrl, model, apiKey, fetchImpl)).tokens;
}

// The same, and whether the answer is for now only: a model LM Studio has not loaded yet,
// which is to be asked about again once it has been. A hosted provider is asked for its model
// list alone: LM Studio's and llama.cpp's own paths are a server's, and asking a provider for
// them sends the person's key for nothing (the request check of 2026-10-15, row E6).
export async function servedContextOf(baseUrl: string, model: string, apiKey: string | null, fetchImpl: typeof fetch = fetch, hosted = false): Promise<{ tokens: number | null; provisional: boolean }> {
  const base = baseUrl.replace(/\/$/, '');
  const headers: Record<string, string> = apiKey ? { Authorization: `Bearer ${apiKey}` } : {};
  if (hosted) {
    const listing = (await getJson(fetchImpl, `${base}/models`, headers)) as { data?: Array<Record<string, unknown>> } | null;
    return { tokens: contextFromListing(listing?.data?.find((m) => m.id === model)), provisional: false };
  }
  const root = base.replace(/\/v1$/, '');
  const studio = (await getJson(fetchImpl, `${root}/api/v0/models/${encodeURIComponent(model)}`, headers)) as Record<string, unknown> | null;
  // A model LM Studio has not loaded reports only the most it was trained for; LM Studio
  // loads it on the first call with its own setting, often 4,096, so the packet is fitted to
  // the least a model loads with until it has been loaded.
  if (studio && typeof studio.state === 'string' && studio.state !== 'loaded') return { tokens: MIN_CONTEXT, provisional: true };
  const fromStudio = contextFromListing(studio ?? undefined);
  if (fromStudio) return { tokens: fromStudio, provisional: false };
  const listing = (await getJson(fetchImpl, `${base}/models`, headers)) as { data?: Array<Record<string, unknown>> } | null;
  const fromList = contextFromListing(listing?.data?.find((m) => m.id === model));
  if (fromList) return { tokens: fromList, provisional: false };
  const props = (await getJson(fetchImpl, `${root}/props`, headers)) as { default_generation_settings?: { n_ctx?: unknown } } | null;
  const nCtx = Number(props?.default_generation_settings?.n_ctx);
  return { tokens: Number.isFinite(nCtx) && nCtx > 0 ? nCtx : null, provisional: false };
}
