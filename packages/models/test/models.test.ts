import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingHttpHeaders, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Journal, blockFromJson, blockFromMarkdown, buildPacket, loadOperation, runOperation, type BenchFile, type Packet, type PacketFormat } from '@primerkit/core';
import {
  AnthropicModel,
  FITNESS_ASKING,
  ExtractiveModel,
  ModelError,
  OllamaModel,
  OpenAICompatibleModel,
  ScriptedModel,
  SLICE,
  adapterFor,
  chatMessages,
  checkFitness,
  checkMachine,
  autoCap,
  contextFor,
  contextFromListing,
  servedContext,
  serverUrl,
  isServerUrl,
  shapeOf,
  fitnessLines,
  fitnessPlan,
  formatSchema,
  listAnthropicModels,
  localFetch,
  listOpenAICompatibleModels,
  pullOllamaModel,
  strictCompatible,
  type PullProgress,
} from '../src/index';
import { repairMessage } from '../src/chat';

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = join(here, '..', '..', '..');
const ASK = loadOperation(join(ROOT, 'operations', 'ask'));
const FIXTURES = join(ROOT, 'operations', 'bench-comprehension', 'briefings-2026-09-25');
const BENCH = JSON.parse(readFileSync(join(ROOT, 'operations', 'bench-comprehension', 'questions-2026-09-25.json'), 'utf8')) as BenchFile;
const AT = '2026-09-25T09:06:00.000Z';
const md = (id: string) => blockFromMarkdown(id, readFileSync(join(FIXTURES, `${id}.md`), 'utf8'), AT);
const json = (id: string) => blockFromJson(id, readFileSync(join(FIXTURES, `${id}.json`), 'utf8'), AT);
const PULSE = md('btc.pulse');
const packet = buildPacket({ operation: ASK, question: 'Where does Bitcoin stand?', blocks: [PULSE], runId: 'r' });
const { $schema: _unused, ...BARE } = ASK.schema;

const GOOD = JSON.stringify({
  answer: 'BTC dominance is 58.5% and falling.',
  claims: [{ text: 'BTC dominance is 58.5% and falling.', citations: [{ block: 'btc.pulse', line: 11, quote: 'BTC dominance at 58.5%, falling.' }] }],
  not_in_data: [],
});
const KEY = `test-key-${'x'.repeat(8)}`;

// A model server on this machine: each test sets how it answers, and it records what it is sent.
interface Sent {
  path: string;
  body: Record<string, unknown>;
  headers: IncomingHttpHeaders;
}
type Answer = { status?: number; json?: unknown; ndjson?: unknown[] };
let route: (sent: Sent) => Answer;
const received: Sent[] = [];
let server: Server;
let base = '';

function standard({ path }: Sent): Answer {
  if (path === '/api/chat') return { json: { model: 'qwen2.5:7b', message: { role: 'assistant', content: GOOD }, prompt_eval_count: 900, eval_count: 60 } };
  if (path === '/api/show') return { json: { model_info: { 'qwen2.context_length': 32768 } } };
  if (path === '/v1/messages') return { json: { model: 'claude-test', content: [{ type: 'thinking', thinking: '' }, { type: 'text', text: GOOD }], stop_reason: 'end_turn', usage: { input_tokens: 900, output_tokens: 70 } } };
  if (path.startsWith('/v1/models')) return { json: { data: [{ id: 'text-embedding-3-small', created: 3 }, { id: 'model-new', created: 2, created_at: '2026-09-01' }, { id: 'model-old', created: 1, created_at: '2025-01-01' }] } };
  return { json: { model: 'local-model', choices: [{ message: { role: 'assistant', content: GOOD } }], usage: { prompt_tokens: 900, completion_tokens: 50 } } };
}

async function bodyOf(req: IncomingMessage): Promise<Record<string, unknown>> {
  let raw = '';
  for await (const chunk of req) raw += String(chunk);
  return JSON.parse(raw || '{}') as Record<string, unknown>;
}

beforeAll(async () => {
  server = createServer(async (req, res) => {
    const sent = { path: req.url ?? '', body: await bodyOf(req), headers: req.headers };
    received.push(sent);
    const answer = route(sent);
    res.statusCode = answer.status ?? 200;
    res.setHeader('Content-Type', 'application/json');
    if (answer.ndjson) res.end(answer.ndjson.map((l) => JSON.stringify(l)).join('\n') + '\n');
    else res.end(JSON.stringify(answer.json ?? {}));
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

beforeEach(() => {
  route = standard;
  received.length = 0;
});

afterAll(() => new Promise<void>((done) => server.close(() => done())));

describe('Ollama', () => {
  it('sends the packet with the schema as format, at temperature 0, and reports what it used', async () => {
    const model = new OllamaModel({ baseUrl: base, model: 'qwen2.5:7b', maxContextTokens: 8192 });
    const reply = await model.complete(packet);
    expect(reply).toEqual({ text: GOOD, modelReported: 'qwen2.5:7b', usage: { inputTokens: 900, outputTokens: 60 } });
    const chat = received.find((r) => r.path === '/api/chat')!;
    expect(chat.body).toMatchObject({ model: 'qwen2.5:7b', stream: false, format: ASK.schema, options: { temperature: 0, num_ctx: 4096 } });
    expect(chat.body.messages).toEqual(chatMessages(packet));
    expect(model.label).toBe('qwen2.5:7b, local, 8k');
    expect(await model.capabilities()).toMatchObject({ local: true, contextTokens: 4096, maxContextTokens: 8192, canRaiseContext: true, format: 'json' });
  });

  it('raises the context only as far as a packet needs, within the cap and the model limit', async () => {
    const big = buildPacket({ operation: ASK, question: 'q', blocks: [json('btc.pulse'), json('btc.context'), json('macro.snapshot')], runId: 'r' });
    expect(contextFor(big.tokens.count, 4096, 8192)).toBe(8192);
    expect(contextFor(1000, 4096, 8192)).toBe(4096);
    await new OllamaModel({ baseUrl: base, model: 'm', maxContextTokens: 16384 }).complete(big);
    const numCtx = (received.find((r) => r.path === '/api/chat')!.body.options as { num_ctx: number }).num_ctx;
    expect(numCtx).toBeGreaterThan(4096);
    expect(numCtx % 1024).toBe(0);
    expect(numCtx).toBeGreaterThanOrEqual(big.tokens.count * 1.15 + 1024);

    route = (s) => (s.path === '/api/show' ? { json: { model_info: { 'llama.context_length': 6144 } } } : standard(s));
    expect(await new OllamaModel({ baseUrl: base, model: 'small', maxContextTokens: 16384 }).capabilities()).toMatchObject({ maxContextTokens: 6144, format: 'markdown' });
  });

  it('uses the markdown packet when its cap is small', async () => {
    expect((await new OllamaModel({ baseUrl: base, model: 'm', maxContextTokens: 4096 }).capabilities()).format).toBe('markdown');
  });

  // qwen2.5:7b's shape as Ollama reports it: 28 layers, 28 heads, 4 of them for keys and
  // values, 3,584 wide, a 32k limit and 4.7 GB of weights.
  const QWEN7 = {
    'qwen2.context_length': 32768,
    'qwen2.block_count': 28,
    'qwen2.attention.head_count': 28,
    'qwen2.attention.head_count_kv': 4,
    'qwen2.embedding_length': 3584,
  };
  const GB = 1024 ** 3;

  it('finds how much context a model can have from its shape and the memory of the machine', () => {
    const shape = shapeOf(QWEN7, 4.7 * GB);
    expect(shape.kvBytesPerToken).toBe(2 * 28 * 4 * 128 * 2);
    expect(autoCap(shape, 32 * GB)).toBe(32768);
    expect(autoCap(shape, 8 * GB)).toBe(4096);
    expect(autoCap(shapeOf({ 'x.context_length': 131072 }, null), 64 * GB)).toBe(32768);
    expect(autoCap({ limit: null, kvBytesPerToken: null, weightsBytes: null }, 16 * GB)).toBe(32768);
    expect(autoCap(shape, 12 * GB)).toBe(Math.floor(Math.floor((12 * GB * 0.6 - 4.7 * GB * 1.1 - 512 * 1024 * 1024) / (2 * 28 * 4 * 128 * 2)) / 1024) * 1024);
  });

  it('raises its cap without a setting when the model and the machine can hold more', async () => {
    route = (s) => (s.path === '/api/show' ? { json: { model_info: QWEN7 } } : s.path === '/api/tags' ? { json: { models: [{ name: 'qwen2.5:7b', size: 4.7 * GB }] } } : standard(s));
    const roomy = new OllamaModel({ baseUrl: base, model: 'qwen2.5:7b', memoryBytes: 32 * GB });
    expect(roomy.label).toBe('qwen2.5:7b, local, 8k');
    expect(await roomy.capabilities()).toMatchObject({ maxContextTokens: 32768, contextTokens: 4096, canRaiseContext: true });
    expect(roomy.label).toBe('qwen2.5:7b, local, 32k');
    expect((await new OllamaModel({ baseUrl: base, model: 'qwen2.5:7b', memoryBytes: 8 * GB }).capabilities()).maxContextTokens).toBe(4096);
    expect((await new OllamaModel({ baseUrl: base, model: 'qwen2.5:7b', memoryBytes: 32 * GB, maxContextTokens: 8192 }).capabilities()).maxContextTokens).toBe(8192);
  });

  it('answers a whole run through the executor', async () => {
    const result = await runOperation({ operation: ASK, question: 'Where does Bitcoin stand?', blocks: [PULSE], model: new OllamaModel({ baseUrl: base, model: 'qwen2.5:7b' }) });
    expect(result.outcome).toBe('passed');
    expect(result.modelReported).toBe('qwen2.5:7b');
  });

  it('reports a server error as a model error, with what the server said', async () => {
    route = () => ({ status: 500, json: { error: 'model runner has unexpectedly stopped' } });
    await expect(new OllamaModel({ baseUrl: base, model: 'm' }).complete(packet)).rejects.toThrow(/500: model runner has unexpectedly stopped/);
  });

  it('pulls a named model with its progress, and says why a pull failed', async () => {
    route = () => ({ ndjson: [{ status: 'pulling manifest' }, { status: 'downloading', total: 100, completed: 50 }, { status: 'success' }] });
    const seen: PullProgress[] = [];
    await pullOllamaModel('qwen3:4b', (p) => seen.push(p), { baseUrl: base });
    expect(seen).toEqual([{ status: 'pulling manifest' }, { status: 'downloading', total: 100, completed: 50 }, { status: 'success' }]);
    expect(received[0]?.body).toEqual({ model: 'qwen3:4b', stream: true });

    route = () => ({ ndjson: [{ error: 'pull model manifest: file does not exist' }] });
    await expect(pullOllamaModel('nope', () => {}, { baseUrl: base })).rejects.toThrow(/file does not exist/);
  });
});

describe('an OpenAI compatible server, local or hosted', () => {
  it('reads the context a server or provider reports for the model', async () => {
    route = (s) => (s.path === '/api/v0/models/local-model' ? { json: { id: 'local-model', loaded_context_length: 16384 } } : { status: 404, json: {} });
    expect(await servedContext(`${base}/v1`, 'local-model', null)).toBe(16384);
    route = (s) => (s.path === '/v1/models' ? { json: { data: [{ id: 'other' }, { id: 'local-model', max_model_len: 32768 }] } } : { status: 404, json: {} });
    expect(await servedContext(`${base}/v1`, 'local-model', null)).toBe(32768);
    route = (s) => (s.path === '/props' ? { json: { default_generation_settings: { n_ctx: 8192 } } } : { status: 404, json: {} });
    expect(await servedContext(`${base}/v1`, 'local-model', null)).toBe(8192);
    route = () => ({ status: 404, json: {} });
    expect(await servedContext(`${base}/v1`, 'local-model', null)).toBeNull();
    expect(contextFromListing({ id: 'x', context_window: 131072 })).toBe(131072);
    expect(contextFromListing({ id: 'x', context_length: 200000 })).toBe(200000);

    route = (s) => (s.path === '/v1/models' ? { json: { data: [{ id: 'local-model', max_model_len: 32768 }] } } : { status: 404, json: {} });
    const model = new OpenAICompatibleModel({ baseUrl: `${base}/v1`, model: 'local-model' });
    expect(model.label).toBe('local-model, local');
    expect(await model.capabilities()).toMatchObject({ contextTokens: 32768, format: 'json' });
    expect(model.label).toBe('local-model, local, 32k');
  });

  // The request check of 2026-10-15 (row E6): a hosted provider was asked, with the person's
  // key, for LM Studio's and llama.cpp's own paths beside its model list.
  it('asks a hosted provider for its model list alone, and a server for its own paths too', async () => {
    route = (s) => (s.path === '/v1/models' ? { json: { data: [{ id: 'gpt-test', context_window: 131072 }] } } : { status: 404, json: {} });
    const hosted = new OpenAICompatibleModel({ baseUrl: `${base}/v1`, model: 'gpt-test', apiKey: KEY, provider: 'OpenAI' });
    expect(await hosted.capabilities()).toMatchObject({ contextTokens: 131072 });
    expect(received.map((r) => r.path)).toEqual(['/v1/models']);
    expect(received.map((r) => r.headers.authorization)).toEqual([`Bearer ${KEY}`]);
    // A provider whose list names no context keeps its usual one, with nothing else asked.
    received.length = 0;
    route = () => ({ status: 404, json: {} });
    const plain = new OpenAICompatibleModel({ baseUrl: `${base}/v1`, model: 'gpt-test', apiKey: KEY, provider: 'OpenAI', defaultContext: 128_000 });
    expect(await plain.capabilities()).toMatchObject({ contextTokens: 128_000 });
    expect(received.map((r) => r.path)).toEqual(['/v1/models']);
    // CONTROL: a server at a URL is still asked as LM Studio and llama.cpp, then its list.
    received.length = 0;
    const server = new OpenAICompatibleModel({ baseUrl: `${base}/v1`, model: 'gpt-test' });
    await server.capabilities();
    expect(received.map((r) => r.path)).toEqual(['/api/v0/models/gpt-test', '/v1/models', '/props']);
  });

  it('sends the schema through response_format, strict only where the schema allows it', async () => {
    const model = new OpenAICompatibleModel({ baseUrl: `${base}/v1`, model: 'local-model', contextTokens: 16384 });
    const reply = await model.complete(packet, [{ check: 'citations', message: 'the quote is not in [btc.pulse L11]' }]);
    expect(reply.text).toBe(GOOD);
    const sent = received[0]!;
    expect(sent.path).toBe('/v1/chat/completions');
    expect(sent.body).toMatchObject({ model: 'local-model', temperature: 0, response_format: { type: 'json_schema', json_schema: { schema: BARE, strict: false } } });
    expect(sent.headers.authorization).toBeUndefined();
    // The repair goes in the one user message with the packet: a strict chat template
    // refuses two user messages in a row.
    const messages = sent.body.messages as Array<{ role: string; content: string }>;
    expect(messages.map((m) => m.role)).toEqual(['system', 'user']);
    expect(messages[1]!.content.startsWith(packet.text)).toBe(true);
    expect(messages[1]!.content).toContain('- citations: the quote is not in [btc.pulse L11]');
    expect(model.label).toBe('local-model, local, 16k');
    expect(strictCompatible({ type: 'object', required: ['a'], additionalProperties: false, properties: { a: { type: 'string' } } })).toBe(true);
    expect(strictCompatible(BARE)).toBe(false);
  });

  it('sends a hosted provider its key, and steps down when a model refuses the schema or the temperature', async () => {
    let calls = 0;
    route = (s) => {
      calls += 1;
      if (calls === 1) return { status: 400, json: { error: { message: "Unsupported value: 'temperature' does not support 0 with this model." } } };
      if (calls === 2) return { status: 400, json: { error: { message: "Invalid parameter: 'response_format' of type 'json_schema' is not supported with this model." } } };
      return standard(s);
    };
    const model = new OpenAICompatibleModel({ baseUrl: `${base}/v1`, model: 'gpt-test', apiKey: KEY, provider: 'OpenAI' });
    expect(model.label).toBe('gpt-test, local');
    expect((await model.complete(packet)).text).toBe(GOOD);
    expect(received.map((r) => r.headers.authorization)).toEqual([`Bearer ${KEY}`, `Bearer ${KEY}`, `Bearer ${KEY}`]);
    expect(received[1]!.body.temperature).toBeUndefined();
    expect(received[2]!.body.response_format).toEqual({ type: 'json_object' });
  });

  it('says so when the answer was cut off at the length the server allows, or the model declined', async () => {
    const model = new OpenAICompatibleModel({ baseUrl: `${base}/v1`, model: 'local-model', contextTokens: 16384 });
    route = () => ({ json: { choices: [{ message: { role: 'assistant', content: '{"answer": "BTC' }, finish_reason: 'length' }] } });
    await expect(model.complete(packet)).rejects.toThrow('the model ran out of room before its answer was finished (finish reason: length)');
    route = () => ({ json: { choices: [{ message: { role: 'assistant', content: null, refusal: 'I cannot help with that.' }, finish_reason: 'stop' }] } });
    await expect(model.complete(packet)).rejects.toThrow('the model declined to answer this packet: I cannot help with that.');
  });

  it('reads a server address typed without http://, and gives a model LM Studio has not loaded the context it loads with', async () => {
    expect(serverUrl('127.0.0.1:1234/v1')).toBe('http://127.0.0.1:1234/v1');
    expect(serverUrl(' localhost:1234/v1 ')).toBe('http://localhost:1234/v1');
    expect(serverUrl('https://api.example.com/v1')).toBe('https://api.example.com/v1');
    expect(isServerUrl('127.0.0.1:1234/v1')).toBe(true);
    expect(isServerUrl('not an address')).toBe(false);
    const typed = new OpenAICompatibleModel({ baseUrl: base.replace('http://', ''), model: 'local-model', contextTokens: 16384 });
    expect(typed.label).toBe('local-model, local, 16k');
    expect((await typed.complete(packet)).text).toBe(GOOD);
    route = (s) => (s.path === '/api/v0/models/local-model' ? { json: { id: 'local-model', state: 'not-loaded', max_context_length: 131072 } } : { status: 404, json: {} });
    expect(await servedContext(`${base}/v1`, 'local-model', null)).toBe(4096);
    // CONTROL: loaded, it says what it was loaded with.
    route = (s) => (s.path === '/api/v0/models/local-model' ? { json: { id: 'local-model', state: 'loaded', loaded_context_length: 16384, max_context_length: 131072 } } : { status: 404, json: {} });
    expect(await servedContext(`${base}/v1`, 'local-model', null)).toBe(16384);
  });

  it('asks LM Studio again once a model it had not loaded has been loaded', async () => {
    const model = new OpenAICompatibleModel({ baseUrl: `${base}/v1`, model: 'local-model' });
    route = (s) => (s.path === '/api/v0/models/local-model' ? { json: { id: 'local-model', state: 'not-loaded', max_context_length: 131072 } } : { status: 404, json: {} });
    expect((await model.capabilities()).contextTokens).toBe(4096);
    route = (s) => (s.path === '/api/v0/models/local-model' ? { json: { id: 'local-model', state: 'loaded', loaded_context_length: 16384 } } : { status: 404, json: {} });
    expect((await model.capabilities()).contextTokens).toBe(16384);
  });

  it('lists the chat models a server offers, newest first', async () => {
    expect(await listOpenAICompatibleModels(`${base}/v1`, KEY)).toEqual(['model-new', 'model-old']);
    expect(received[0]!.headers.authorization).toBe(`Bearer ${KEY}`);
  });
});

describe('Claude through Anthropic', () => {
  const tooled = { json: { model: 'claude-old', content: [{ type: 'tool_use', name: 'answer', input: JSON.parse(GOOD) }], stop_reason: 'tool_use', usage: { input_tokens: 900, output_tokens: 70 } } };
  const refused = (message: string) => ({ status: 400, json: { type: 'error', error: { type: 'invalid_request_error', message } } });
  const objects = (schema: unknown): Array<Record<string, unknown>> => {
    if (!schema || typeof schema !== 'object') return [];
    if (Array.isArray(schema)) return schema.flatMap(objects);
    const s = schema as Record<string, unknown>;
    const own = s.type === 'object' || s.properties ? [s] : [];
    const props = Object.values((s.properties ?? {}) as object).flatMap(objects);
    const rest = Object.entries(s).filter(([k]) => k !== 'properties').flatMap(([, v]) => objects(v));
    return [...own, ...props, ...rest];
  };

  it('holds the answer to the schema with structured outputs: no tool, no temperature, room for thinking', async () => {
    const model = new AnthropicModel({ apiKey: KEY, model: 'claude-test', baseUrl: `${base}/v1` });
    const reply = await model.complete(packet, [{ check: 'schema', message: 'the response must have claims' }]);
    expect(reply).toEqual({ text: GOOD, modelReported: 'claude-test', usage: { inputTokens: 900, outputTokens: 70 } });
    expect(received).toHaveLength(1);
    const sent = received[0]!;
    expect(sent.path).toBe('/v1/messages');
    expect(sent.headers['x-api-key']).toBe(KEY);
    expect(sent.headers['anthropic-version']).toBe('2023-06-01');
    expect(sent.body).toMatchObject({ model: 'claude-test', max_tokens: 16000, output_config: { format: { type: 'json_schema', schema: formatSchema(BARE) } } });
    expect(sent.body.tools).toBeUndefined();
    expect(sent.body.tool_choice).toBeUndefined();
    expect(sent.body.temperature).toBeUndefined();
    expect((sent.body.messages as Array<{ content: string }>)[0]!.content).toContain('- schema: the response must have claims');
    expect(model.label).toBe('claude-test, Anthropic');
  });

  it("marks a packet's cacheable start for Anthropic's cache, and reports what the cache read and wrote", async () => {
    const last = buildPacket({ operation: ASK, question: 'Where does Bitcoin stand?', blocks: [PULSE], runId: 'r', questionLast: true });
    route = () => ({ json: { model: 'claude-test', content: [{ type: 'text', text: GOOD }], stop_reason: 'end_turn', usage: { input_tokens: 40, output_tokens: 70, cache_read_input_tokens: 0, cache_creation_input_tokens: 1200 } } });
    const model = new AnthropicModel({ apiKey: KEY, model: 'claude-test', baseUrl: `${base}/v1` });
    const reply = await model.complete(last, [{ check: 'schema', message: 'the response must have claims' }]);
    expect(reply.usage).toEqual({ inputTokens: 40, outputTokens: 70, cacheWriteTokens: 1200 });
    const content = (received[0]!.body.messages as Array<{ content: Array<{ type: string; text: string; cache_control?: unknown }> }>)[0]!.content;
    expect(content).toHaveLength(2);
    expect(content[0]).toEqual({ type: 'text', text: last.text.slice(0, last.cachePrefix), cache_control: { type: 'ephemeral' } });
    expect(content[1]!.cache_control).toBeUndefined();
    expect(content[1]!.text).toMatch(/^Question: Where does Bitcoin stand\?/);
    // The repair goes after the question, so the cached start stays the same.
    expect(content[0]!.text + content[1]!.text).toBe(`${last.text}\n\n${repairMessage([{ check: 'schema', message: 'the response must have claims' }])}`);
    route = () => ({ json: { model: 'claude-test', content: [{ type: 'text', text: GOOD }], stop_reason: 'end_turn', usage: { input_tokens: 40, output_tokens: 70, cache_read_input_tokens: 1200, cache_creation_input_tokens: 0 } } });
    expect((await model.complete(last)).usage).toEqual({ inputTokens: 40, outputTokens: 70, cacheReadTokens: 1200 });
    // A packet with its question first goes as one string, with no mark.
    await model.complete(packet);
    expect(typeof (received[2]!.body.messages as Array<{ content: unknown }>)[0]!.content).toBe('string');
  });

  it('sends structured outputs a schema they take: every object closed, no length or number bounds', () => {
    const sent = formatSchema(BARE);
    const text = JSON.stringify(sent);
    for (const word of ['minLength', 'maxLength', 'minimum', 'maximum', 'pattern']) expect(text).not.toContain(`"${word}"`);
    expect(JSON.stringify(BARE)).toContain('"minLength"');
    const closed = objects(sent);
    expect(closed.length).toBeGreaterThan(1);
    for (const object of closed) expect(object.additionalProperties).toBe(false);
    expect(formatSchema({ type: 'object', properties: { minimum: { type: 'string', minLength: 1 } }, required: ['minimum'] }))
      .toEqual({ type: 'object', properties: { minimum: { type: 'string' } }, required: ['minimum'], additionalProperties: false });
    expect(formatSchema({ type: 'array', items: { type: 'string' }, minItems: 3 })).toEqual({ type: 'array', items: { type: 'string' } });
    expect(formatSchema({ type: 'array', items: { type: 'string' }, minItems: 1 })).toEqual({ type: 'array', items: { type: 'string' }, minItems: 1 });
  });

  it('steps down to a tool the model must call where structured outputs are refused, and keeps that step for the model', async () => {
    route = (s) => (s.body.output_config ? refused("output_config.format: structured outputs are not supported for 'claude-old'.") : tooled);
    const model = new AnthropicModel({ apiKey: KEY, model: 'claude-old', baseUrl: `${base}/v1` });
    expect((await model.complete(packet)).text).toBe(GOOD);
    expect(received).toHaveLength(2);
    expect(received[1]!.body).toMatchObject({ temperature: 0, max_tokens: 4096, tool_choice: { type: 'tool', name: 'answer' }, tools: [{ name: 'answer', input_schema: BARE }] });
    expect(received[1]!.body.output_config).toBeUndefined();
    received.length = 0;
    expect((await new AnthropicModel({ apiKey: KEY, model: 'claude-old', baseUrl: `${base}/v1` }).complete(packet)).text).toBe(GOOD);
    expect(received).toHaveLength(1);
    expect(received[0]!.body.tool_choice).toEqual({ type: 'tool', name: 'answer' });
  });

  it('leaves the temperature out where the model refuses it', async () => {
    route = (s) => (s.body.output_config ? refused('output_config: Extra inputs are not permitted') : s.body.temperature !== undefined ? refused('temperature: not supported for this model') : tooled);
    expect((await new AnthropicModel({ apiKey: KEY, model: 'claude-mid', baseUrl: `${base}/v1` }).complete(packet)).text).toBe(GOOD);
    expect(received).toHaveLength(3);
    expect(received[2]!.body.temperature).toBeUndefined();
    expect(received[2]!.body.tool_choice).toEqual({ type: 'tool', name: 'answer' });
  });

  it('never steps down on a refusal that is not about the format, and names both refusals when the last step fails too', async () => {
    route = () => refused('prompt is too long: 1200000 tokens > 1000000 maximum');
    await expect(new AnthropicModel({ apiKey: KEY, model: 'claude-long', baseUrl: `${base}/v1` }).complete(packet)).rejects.toThrow(/answered 400: prompt is too long/);
    expect(received).toHaveLength(1);
    received.length = 0;
    route = (s) => (s.body.output_config ? refused('output_config.format: not supported') : refused('tool_choice: type "tool" and "any" are not supported for this model.'));
    await expect(new AnthropicModel({ apiKey: KEY, model: 'claude-odd', baseUrl: `${base}/v1` }).complete(packet)).rejects.toThrow(/tool_choice.*asked first with structured outputs: output_config.format: not supported/);
    expect(received).toHaveLength(2);
  });

  it('says so when Claude declines, or runs out of room before the answer ends', async () => {
    route = () => ({ json: { model: 'claude-test', content: [], stop_reason: 'refusal', stop_details: { type: 'refusal', category: null } } });
    await expect(new AnthropicModel({ apiKey: KEY, model: 'claude-test', baseUrl: `${base}/v1` }).complete(packet)).rejects.toThrow(/declined/);
    route = () => ({ json: { model: 'claude-test', content: [{ type: 'text', text: '{"answer": "BTC' }], stop_reason: 'max_tokens' } });
    await expect(new AnthropicModel({ apiKey: KEY, model: 'claude-test', baseUrl: `${base}/v1` }).complete(packet)).rejects.toThrow(/ran out of room/);
    // A tool answer cut off by the cap is cut off too.
    route = () => ({ json: { model: 'claude-old', content: [{ type: 'tool_use', name: 'answer', input: { answer: 'BTC' } }], stop_reason: 'max_tokens' } });
    await expect(new AnthropicModel({ apiKey: KEY, model: 'claude-test', baseUrl: `${base}/v1` }).complete(packet)).rejects.toThrow(/ran out of room/);
  });

  it('lists the models, newest first', async () => {
    expect(await listAnthropicModels(KEY, fetch, `${base}/v1`)).toEqual(['model-new', 'model-old', 'text-embedding-3-small']);
  });
});

describe('a model named in the config', () => {
  it('builds each kind of adapter, and names the variable a hosted key is missing from', () => {
    expect(adapterFor({ kind: 'ollama', name: 'qwen3:8b' }).id).toBe('ollama:qwen3:8b');
    expect(adapterFor({ kind: 'openai-compatible', name: 'm', baseUrl: 'http://127.0.0.1:1234/v1' }).label).toBe('m, local');
    expect(adapterFor({ kind: 'hosted', provider: 'anthropic', name: 'claude-x' }, { ANTHROPIC_API_KEY: KEY }).label).toBe('claude-x, Anthropic');
    expect(adapterFor({ kind: 'hosted', provider: 'deepseek', name: 'deepseek-chat' }, { DEEPSEEK_API_KEY: KEY }).label).toBe('deepseek-chat, DeepSeek');
    expect(() => adapterFor({ kind: 'hosted', provider: 'openai', name: 'gpt-x' }, {})).toThrow(/OPENAI_API_KEY is not set/);
    expect(() => adapterFor({ kind: 'hosted', provider: 'nobody', name: 'x' }, {})).toThrow(ModelError);
  });
});

describe('the machine check', () => {
  it('finds AI apps on the path, keys by name only, and local models that answer', async () => {
    const bin = mkdtempSync(join(tmpdir(), 'primerkit-path-'));
    writeFileSync(join(bin, process.platform === 'win32' ? 'claude.cmd' : 'claude'), '');
    const asked: string[] = [];
    const fakeFetch = (async (input: string | URL | Request) => {
      const url = String(input);
      asked.push(url);
      if (url.endsWith('/api/tags')) return new Response(JSON.stringify({ models: [{ name: 'qwen2.5:7b' }, { name: 'llama3.1:8b' }] }));
      throw new Error('connection refused');
    }) as typeof fetch;
    const secret = 'value-that-must-not-appear';
    const found = await checkMachine({ env: { PATH: bin, PATHEXT: '.CMD', ANTHROPIC_API_KEY: secret, DEEPSEEK_API_KEY: secret }, fetch: fakeFetch });
    expect(found.apps).toEqual(['Claude Code']);
    expect(found.keys).toEqual(['ANTHROPIC_API_KEY', 'DEEPSEEK_API_KEY']);
    expect(found.local.map((m) => `${m.runtime} ${m.name}`)).toEqual(['ollama qwen2.5:7b', 'ollama llama3.1:8b']);
    expect(found.ollama).toBe('running');
    expect(JSON.stringify(found)).not.toContain(secret);
    expect(asked.every((u) => u.startsWith('http://127.0.0.1:'))).toBe(true);
  });

  it('finds nothing on a bare machine, and tells installed from absent', async () => {
    const none = (async () => {
      throw new Error('connection refused');
    }) as typeof fetch;
    expect(await checkMachine({ env: { PATH: '' }, fetch: none })).toEqual({ apps: [], keys: [], local: [], ollama: 'absent' });
    const bin = mkdtempSync(join(tmpdir(), 'primerkit-ollama-'));
    writeFileSync(join(bin, process.platform === 'win32' ? 'ollama.exe' : 'ollama'), '');
    expect((await checkMachine({ env: { PATH: bin, PATHEXT: '.EXE' }, fetch: none })).ollama).toBe('installed');
  });

  it('finds LM Studio by its own folder in the home given, or by its lms command', async () => {
    const none = (async () => {
      throw new Error('connection refused');
    }) as typeof fetch;
    const home = mkdtempSync(join(tmpdir(), 'primerkit-home-'));
    expect((await checkMachine({ env: { PATH: '' }, fetch: none, home })).apps).toEqual([]);
    mkdirSync(join(home, '.lmstudio'));
    expect((await checkMachine({ env: { PATH: '' }, fetch: none, home })).apps).toEqual(['LM Studio']);
    // With no home given, its folder is not looked at.
    expect((await checkMachine({ env: { PATH: '' }, fetch: none })).apps).toEqual([]);
    const bin = mkdtempSync(join(tmpdir(), 'primerkit-lms-'));
    writeFileSync(join(bin, process.platform === 'win32' ? 'lms.exe' : 'lms'), '');
    expect((await checkMachine({ env: { PATH: bin, PATHEXT: '.EXE' }, fetch: none })).apps).toEqual(['LM Studio']);
  });
});

describe('the fitness check', () => {
  const data = (briefing: string, format: PacketFormat) => (format === 'markdown' ? readFileSync(join(FIXTURES, `${briefing}.md`), 'utf8') : json(briefing).lines.join('\n'));
  const input = {
    ask: ASK,
    askBlock: { markdown: md('btc.pulse'), json: json('btc.pulse') },
    largest: { markdown: ['btc.pulse', 'btc.context', 'macro.snapshot'].map(md), json: ['btc.pulse', 'btc.context', 'macro.snapshot'].map(json) },
    bench: BENCH,
    benchData: data,
  };
  // Right answers, from the key, for a reading test packet.
  const fromKey = (p: Packet) => {
    const b = BENCH.briefings.find((x) => p.question.startsWith(x.briefing))!;
    return JSON.stringify({ answers: Object.fromEntries(b.questions.filter((q) => SLICE.questions.includes(q.id)).map((q) => [q.id, q.key.answer])) });
  };

  it('finds a model that answers, cites and reads right fit for everything, and keeps the result', async () => {
    const root = mkdtempSync(join(tmpdir(), 'primerkit-fit-'));
    const model = new ScriptedModel([(p) => (p.operation.id === 'ask' ? GOOD : fromKey(p))]);
    const steps: string[] = [];
    const running: string[] = [];
    const result = await checkFitness({ ...input, model, journal: new Journal(root), onStep: (s) => (s.done ? steps.push(s.name) : running.push(s.text)) });
    // While it runs, the first step names the question the model is asked.
    expect(running[0]).toBe('asking "Where does Bitcoin stand?" of a saved briefing');
    expect(running[0]).toBe(FITNESS_ASKING);
    expect(result).toMatchObject({ verdict: 'fit for everything', shape: { valid: 5, total: 5 }, citations: { matched: 1, total: 1 }, format: 'markdown' });
    expect(result.reading).toEqual({ markdown: { right: 14, total: 14 }, json: { right: 14, total: 14 } });
    expect(steps).toEqual(['shape', 'citations', 'reading', 'context', 'speed']);
    expect(result.calls).toBe(5);
    expect(readdirSync(result.journalDir!).sort()).toContain('result.json');
    expect(fitnessLines(result)[0]!.text).toBe('Answer shape: 5 of 5 answers were valid JSON of the right shape.');
  });

  it('proposes JSON for a model that reads it better, where it fits', async () => {
    const markdownWrong = (p: Packet) => (p.question.endsWith('markdown') ? JSON.stringify({ answers: {} }) : fromKey(p));
    const model = new ScriptedModel([(p) => (p.operation.id === 'ask' ? GOOD : markdownWrong(p))], { contextTokens: 16384 });
    const result = await checkFitness({ ...input, model });
    expect(result.format).toBe('json');
    expect(result.reading.markdown.right).toBe(0);
  });

  it('gives no reading verdict where the runtime answered the reading test with errors', async () => {
    const model = new ScriptedModel([
      (p) => {
        if (p.operation.id === 'ask') return GOOD;
        throw new ModelError('Anthropic answered 429: rate limited', 429);
      },
    ]);
    const result = await checkFitness({ ...input, model });
    expect(result.verdict).toBe('not fit');
    expect(result.reason).toBe('the reading test could not be finished: 4 of its 4 calls answered with an error (Anthropic answered 429: rate limited); check again once the model answers');
    expect(fitnessLines(result).some((l) => l.text.startsWith('Reading:'))).toBe(false);
  });

  it("scores a reading packet the runtime refused as too big as the reading's own result, as before", async () => {
    // A server whose context the JSON packets do not fit: it answers 400. Markdown reads right.
    const model = new ScriptedModel([
      (p) => {
        if (p.operation.id === 'ask') return GOOD;
        if (p.question.endsWith('json')) throw new ModelError('the model server answered 400: the request exceeds the context length', 400);
        return fromKey(p);
      },
    ]);
    const result = await checkFitness({ ...input, model });
    expect(result.verdict).toBe('fit for everything');
    expect(result.format).toBe('markdown');
    expect(result.reading.json.right).toBe(0);
  });

  it('finds a model that cites right but reads badly fit for ask and digest only', async () => {
    const model = new ScriptedModel([(p) => (p.operation.id === 'ask' ? GOOD : JSON.stringify({ answers: {} }))]);
    const result = await checkFitness({ ...input, model });
    expect(result.verdict).toBe('fit for ask and digest only');
    expect(result.reason).toMatch(/read 0% of the reading test right, below the 90% set for everything/);
  });

  it('finds a model not fit when its answer cannot pass its checks, and says why', async () => {
    const result = await checkFitness({ ...input, model: new ScriptedModel(['not json at all']) });
    expect(result.verdict).toBe('not fit');
    expect(result.reason).toMatch(/did not pass its checks after the repair turn/);
    expect(result.shape.valid).toBe(0);
  });

  it('says how many calls and tokens it will send, for a hosted model', () => {
    const plan = fitnessPlan(input, 'json');
    expect(plan.calls).toBe(5);
    expect(plan.tokens).toBeGreaterThan(3000);
  });
});

describe('the stand ins', () => {
  it('the demo model lifts sentences with figures, so its answers pass their checks', async () => {
    const result = await runOperation({ operation: ASK, question: 'Where does Bitcoin stand?', blocks: [PULSE], model: new ExtractiveModel() });
    expect(result.outcome).toBe('passed');
    expect(result.response?.claims[0]?.citations[0]).toMatchObject({ block: 'btc.pulse', line: 7 });
  });

  it('the scripted model returns its scripts in turn', async () => {
    const model = new ScriptedModel(['one', (p) => p.question]);
    expect((await model.complete(packet)).text).toBe('one');
    expect((await model.complete(packet)).text).toBe('Where does Bitcoin stand?');
    expect(model.calls).toHaveLength(2);
    expect(existsSync(FIXTURES)).toBe(true);
  });
});

describe('a runtime on this machine', () => {
  // Node's fetch stops waiting for headers after five minutes, which a local model
  // reading a long packet can pass. localFetch waits as long as the model needs.
  it('waits for a slow answer, and carries the status, headers and body', async () => {
    const server = createServer((req, res) => {
      let body = '';
      req.on('data', (c: Buffer) => (body += c.toString()));
      req.on('end', () => setTimeout(() => {
        res.writeHead(201, { 'Content-Type': 'application/json', 'X-Seen': req.headers['x-test'] ?? '' });
        res.end(JSON.stringify({ echoed: body, method: req.method }));
      }, 300));
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    try {
      const { port } = server.address() as AddressInfo;
      const res = await localFetch(`http://127.0.0.1:${port}/api/chat`, { method: 'POST', headers: { 'X-Test': 'yes' }, body: '{"a":1}' });
      expect(res.status).toBe(201);
      expect(res.headers.get('x-seen')).toBe('yes');
      expect(await res.json()).toEqual({ echoed: '{"a":1}', method: 'POST' });
      const stop = new AbortController();
      const pending = localFetch(`http://127.0.0.1:${port}/`, { signal: stop.signal });
      stop.abort();
      await expect(pending).rejects.toThrow();
    } finally {
      server.close();
    }
  });

  it('says a runtime that is not there is not answering', async () => {
    const model = new OllamaModel({ model: 'qwen2.5:7b', baseUrl: 'http://127.0.0.1:9', maxContextTokens: 8192 });
    await expect(model.complete(buildPacket({ operation: ASK, question: 'q', blocks: [], runId: 'r' }))).rejects.toThrow('Ollama is not answering at http://127.0.0.1:9');
  });
});
