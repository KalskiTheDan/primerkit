import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { AnthropicWebSearch, ModelError, WEB_SEARCH_MAX_USES, WEB_SEARCH_PRICE, WebSearchError, listPrice, priceOf, readAnswer, tokensOf, webSearchFor, webSearchTool } from '../src/index';

// The web search the compare view asks, against a response written from the shapes the
// Messages API documents for its web search tool. No request leaves this machine.
const here = dirname(fileURLToPath(import.meta.url));
const RECORDED = JSON.parse(readFileSync(join(here, 'fixtures', 'web-search-net-liquidity.json'), 'utf8')) as Record<string, unknown>;
const TEXT = "Net liquidity has been drifting lower. The central bank's balance sheet stood at $6.61 trillion in the week to October 8, while the government's cash balance rose to $842 billion.\n\nReverse repo use stayed near zero, so it added little either way.";
const QUESTION = 'Is net liquidity rising or falling?';
const SYSTEM = 'Today is 2026-10-13. Answer the question with web search.';
const KEY = 'not-a-key';

interface Sent {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

// A fetch that answers from a script and records what it is sent.
function scripted(answers: Array<{ status?: number; json: unknown }>): { fetch: typeof fetch; sent: Sent[] } {
  const sent: Sent[] = [];
  let next = 0;
  const f = (async (input: string | URL | Request, init?: RequestInit) => {
    sent.push({ url: String(input), headers: Object.fromEntries(new Headers(init?.headers).entries()), body: JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown> });
    const a = answers[Math.min(next++, answers.length - 1)]!;
    return new Response(JSON.stringify(a.json), { status: a.status ?? 200, headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;
  return { fetch: f, sent };
}

const searcher = (model: string, f: typeof fetch) => new AnthropicWebSearch({ apiKey: KEY, model, fetch: f });

describe('the web side of the compare view', () => {
  it('sends the question alone, with the web search tool and nothing else: no briefing, no tool choice, no temperature, no beta', async () => {
    const { fetch, sent } = scripted([{ json: RECORDED }]);
    await searcher('claude-sonnet-5-5', fetch).ask(QUESTION, { system: SYSTEM });
    expect(sent).toHaveLength(1);
    const s = sent[0]!;
    expect(s.url).toBe('https://api.anthropic.com/v1/messages');
    expect(s.headers['x-api-key']).toBe(KEY);
    expect(s.headers['anthropic-version']).toBe('2023-06-01');
    expect(Object.keys(s.headers).some((h) => h.startsWith('anthropic-beta'))).toBe(false);
    expect(s.body).toEqual({ model: 'claude-sonnet-5-5', max_tokens: 16000, system: SYSTEM, messages: [{ role: 'user', content: QUESTION }], tools: [{ type: 'web_search_20260209', name: 'web_search', max_uses: 5 }] });
    expect(WEB_SEARCH_MAX_USES).toBe(5);
  });

  it('reads the answer as it came: the text joined as returned, the searches, the pages each once, what the text cites, and a search error as an error', async () => {
    const { fetch } = scripted([{ json: RECORDED }]);
    const a = await searcher('claude-sonnet-5-5', fetch).ask(QUESTION, { system: SYSTEM });
    expect(a.text).toBe(TEXT);
    expect(a.searches).toBe(3);
    expect(a.queries).toEqual(['net liquidity Fed balance sheet October 2026', 'Treasury General Account balance October 2026', 'net liquidity this week']);
    expect(a.pages.map((p) => p.url)).toEqual([
      'https://sample-central-bank.example/releases/weekly-balance-sheet/',
      'https://sample-statistics.example/series/total-assets',
      'https://sample-reserve-desk.example/operations/reverse-repo',
      'https://example-treasury.example/datasets/daily-statement/',
    ]);
    expect(a.pages[0]).toEqual({ url: 'https://sample-central-bank.example/releases/weekly-balance-sheet/', title: 'Weekly balance sheet - Sample Central Bank', pageAge: 'October 9, 2026' });
    expect(a.pages[2]!.pageAge).toBeNull();
    expect(a.cited.map((p) => p.url)).toEqual(['https://sample-central-bank.example/releases/weekly-balance-sheet/', 'https://example-treasury.example/datasets/daily-statement/']);
    expect(a.errors).toEqual(['too_many_requests']);
    expect(a.usage).toEqual({ inputTokens: 7412, outputTokens: 388 });
    expect(a).toMatchObject({ modelReported: 'claude-sonnet-5-5', stopReason: 'end_turn', tool: 'web_search_20260209', maxUses: 5, turns: 1 });
    // The journal's copy keeps what a person can read, and none of the encrypted bodies.
    expect(JSON.stringify(a.content)).not.toContain('encrypted');
    expect(JSON.stringify(a.content)).toContain('sample-central-bank.example');
  });

  it('branches on a list of pages or one error object before reading a search result', () => {
    expect(readAnswer([{ type: 'web_search_tool_result', content: { type: 'web_search_tool_result_error', error_code: 'max_uses_exceeded' } }, { type: 'text', text: 'x' }])).toEqual({ text: 'x', queries: [], pages: [], cited: [], errors: ['max_uses_exceeded'] });
    expect(readAnswer([{ type: 'web_search_tool_result', content: [] }, { type: 'web_search_tool_result', content: null }]).errors).toEqual([]);
  });

  it('takes the basic tool on older models, and on a 400 naming the newer one', async () => {
    expect(webSearchTool('claude-opus-5-5')).toBe('web_search_20260209');
    expect(webSearchTool('claude-sonnet-4-6')).toBe('web_search_20260209');
    expect(webSearchTool('claude-opus-4-6-20260115')).toBe('web_search_20260209');
    expect(webSearchTool('claude-haiku-4-5')).toBe('web_search_20250305');
    expect(webSearchTool('claude-sonnet-4-5')).toBe('web_search_20250305');
    const old = scripted([{ json: RECORDED }]);
    await searcher('claude-haiku-4-5', old.fetch).ask(QUESTION, { system: SYSTEM });
    expect(old.sent[0]!.body.tools).toEqual([{ type: 'web_search_20250305', name: 'web_search', max_uses: 5 }]);
    const refused = scripted([{ status: 400, json: { type: 'error', error: { type: 'invalid_request_error', message: "tools.0: 'web_search_20260209' is not supported on this model" } } }, { json: RECORDED }]);
    expect((await searcher('claude-sonnet-5', refused.fetch).ask(QUESTION, { system: SYSTEM })).tool).toBe('web_search_20250305');
    expect(refused.sent.map((s) => (s.body.tools as Array<{ type: string }>)[0]!.type)).toEqual(['web_search_20260209', 'web_search_20250305']);
  });

  it('carries on a paused turn with what Claude wrote so far, adds up what each turn used, and keeps the searches under the cap', async () => {
    const first = { model: 'claude-sonnet-5-5', content: [{ type: 'server_tool_use', id: 's1', name: 'web_search', input: { query: 'q1' } }, { type: 'web_search_tool_result', tool_use_id: 's1', content: [{ type: 'web_search_result', url: 'https://a.example/1', title: 'A', page_age: null, encrypted_content: 'fixture-body' }] }], stop_reason: 'pause_turn', usage: { input_tokens: 1000, output_tokens: 50, server_tool_use: { web_search_requests: 2 } } };
    const second = { model: 'claude-sonnet-5-5', content: [{ type: 'text', text: 'Done reading.' }], stop_reason: 'end_turn', usage: { input_tokens: 1500, output_tokens: 80, server_tool_use: { web_search_requests: 1 } } };
    const { fetch, sent } = scripted([{ json: first }, { json: second }]);
    const a = await searcher('claude-sonnet-5-5', fetch).ask(QUESTION, { system: SYSTEM });
    expect(sent).toHaveLength(2);
    expect(sent[1]!.body.messages).toEqual([{ role: 'user', content: QUESTION }, { role: 'assistant', content: first.content }]);
    expect((sent[1]!.body.tools as Array<{ max_uses: number }>)[0]!.max_uses).toBe(3);
    expect(a).toMatchObject({ text: 'Done reading.', searches: 3, turns: 2, usage: { inputTokens: 2500, outputTokens: 130 } });
    expect(a.pages.map((p) => p.url)).toEqual(['https://a.example/1']);
  });

  it('says so when Claude declines, runs out of room, returns no text, or the request fails', async () => {
    const run = (json: unknown, status?: number) => searcher('claude-sonnet-5-5', scripted([{ json, ...(status ? { status } : {}) }]).fetch).ask(QUESTION, { system: SYSTEM });
    await expect(run({ content: [], stop_reason: 'refusal' })).rejects.toThrow(/declined/);
    await expect(run({ content: [{ type: 'text', text: 'Net' }], stop_reason: 'max_tokens' })).rejects.toThrow(/ran out of room/);
    await expect(run({ content: [{ type: 'server_tool_use', name: 'web_search', input: { query: 'q' } }], stop_reason: 'end_turn' })).rejects.toThrow(/no answer/);
    await expect(run({ type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } }, 529)).rejects.toThrow(ModelError);
    await expect(run({ type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } }, 529)).rejects.toThrow(/Anthropic answered 529: Overloaded/);
  });

  // A first turn the server's loop paused after 2 paid searches, and turns after it.
  const PAUSED = { model: 'claude-sonnet-5-5', content: [{ type: 'server_tool_use', id: 's1', name: 'web_search', input: { query: 'q1' } }, { type: 'web_search_tool_result', tool_use_id: 's1', content: [{ type: 'web_search_result', url: 'https://a.example/1', title: 'A', page_age: null }] }, { type: 'server_tool_use', id: 's2', name: 'web_search', input: { query: 'q2' } }, { type: 'web_search_tool_result', tool_use_id: 's2', content: [] }], stop_reason: 'pause_turn', usage: { input_tokens: 1000, output_tokens: 50, server_tool_use: { web_search_requests: 2 } } };
  const stopped = (stop_reason: string, text: string) => ({ model: 'claude-sonnet-5-5', content: [{ type: 'text', text }], stop_reason, usage: { input_tokens: 1200, output_tokens: 300 } });
  const failure = async (run: Promise<unknown>): Promise<WebSearchError> => {
    const error = await run.then(() => null, (e: unknown) => e);
    expect(error).toBeInstanceOf(WebSearchError);
    return error as WebSearchError;
  };
  const sonnet = listPrice('claude-sonnet-5-5')!;

  it('carries what the turns before it used on a later turn that fails: 2 paid searches stay 2, with their tokens and their price', async () => {
    const http = scripted([{ json: PAUSED }, { status: 529, json: { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } } }]);
    const e = await failure(searcher('claude-sonnet-5-5', http.fetch).ask(QUESTION, { system: SYSTEM }));
    expect(http.sent).toHaveLength(2);
    expect(e.message).toBe('Anthropic answered 529: Overloaded');
    expect(e.status).toBe(529);
    expect(e.sofar).toMatchObject({ searches: 2, turns: 1, usage: { inputTokens: 1000, outputTokens: 50 }, queries: ['q1', 'q2'] });
    expect(e.sofar.pages.map((p) => p.url)).toEqual(['https://a.example/1']);
    expect(priceOf(e.sofar.usage, sonnet, e.sofar.searches)).toBeCloseTo((1000 * 2 + 50 * 10) / 1e6 + 0.02, 10);
    // A request that never reaches Anthropic carries them too.
    let n = 0;
    const gone = (async () => {
      if (n++) throw new TypeError('fetch failed');
      return new Response(JSON.stringify(PAUSED), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }) as typeof fetch;
    const lost = await failure(searcher('claude-sonnet-5-5', gone).ask(QUESTION, { system: SYSTEM }));
    expect(lost.message).toBe('Anthropic is not answering at https://api.anthropic.com');
    expect(lost.sofar).toMatchObject({ searches: 2, usage: { inputTokens: 1000, outputTokens: 50 } });
  });

  it('fails a reply cut off, or a refusal, after 2 paid searches, with the searches and tokens of every turn', async () => {
    const used = { searches: 2, turns: 2, usage: { inputTokens: 2200, outputTokens: 350 } };
    for (const stop of ['max_tokens', 'model_context_window_exceeded']) {
      const cut = await failure(searcher('claude-sonnet-5-5', scripted([{ json: PAUSED }, { json: stopped(stop, 'Net liquidity has been') }]).fetch).ask(QUESTION, { system: SYSTEM }));
      expect(cut.message).toBe(`Claude ran out of room before its answer was finished (stop reason: ${stop})`);
      expect(cut.sofar).toMatchObject({ ...used, stopReason: stop, text: 'Net liquidity has been' });
    }
    // A refusal is no answer, even with words before it.
    const refused = await failure(searcher('claude-sonnet-5-5', scripted([{ json: PAUSED }, { json: stopped('refusal', 'The balance sheet stood at') }]).fetch).ask(QUESTION, { system: SYSTEM }));
    expect(refused.message).toBe('Claude declined to answer (stop reason: refusal)');
    expect(refused.sofar).toMatchObject({ ...used, stopReason: 'refusal' });
    expect(priceOf(refused.sofar.usage, sonnet, refused.sofar.searches)).toBeCloseTo((2200 * 2 + 350 * 10) / 1e6 + 0.02, 10);
  });

  it('fails a turn still paused at the cap of 3 rounds as unfinished, never as an answer, with what it used', async () => {
    const once = { model: 'claude-sonnet-5-5', content: [{ type: 'text', text: "I'll search for the weekly balance sheet." }, { type: 'server_tool_use', id: 's', name: 'web_search', input: { query: 'balance sheet' } }, { type: 'web_search_tool_result', tool_use_id: 's', content: [] }], stop_reason: 'pause_turn', usage: { input_tokens: 800, output_tokens: 40, server_tool_use: { web_search_requests: 1 } } };
    const { fetch, sent } = scripted([{ json: once }]);
    const e = await failure(searcher('claude-sonnet-5-5', fetch).ask(QUESTION, { system: SYSTEM }));
    expect(sent).toHaveLength(3);
    expect(e.message).toBe('Claude did not finish its answer in 3 rounds (stop reason: pause_turn)');
    expect(e.sofar).toMatchObject({ searches: 3, turns: 3, stopReason: 'pause_turn', usage: { inputTokens: 2400, outputTokens: 120 } });
    // Paused with every search spent, it is no more finished.
    const spent = { ...once, usage: { ...once.usage, server_tool_use: { web_search_requests: 5 } } };
    const capped = scripted([{ json: spent }]);
    const c = await failure(searcher('claude-sonnet-5-5', capped.fetch).ask(QUESTION, { system: SYSTEM }));
    expect(capped.sent).toHaveLength(1);
    expect(c.message).toBe('Claude did not finish its answer in its 5 searches (stop reason: pause_turn)');
    expect(c.sofar).toMatchObject({ searches: 5, turns: 1 });
  });

  it('keeps text on either side of a search apart, and otherwise joins the text as it came', () => {
    const search = [{ type: 'server_tool_use', name: 'web_search', input: { query: 'q' } }, { type: 'web_search_tool_result', content: [] }];
    // An older model writes no space or break across a search: the passages stand a paragraph apart.
    expect(readAnswer([{ type: 'text', text: "I'll search for the weekly balance sheet." }, ...search, { type: 'text', text: 'Based on the results, ' }, { type: 'text', text: 'it stood at $6.61 trillion.' }]).text).toBe("I'll search for the weekly balance sheet.\n\nBased on the results, it stood at $6.61 trillion.");
    // Where the model put its own space or break, nothing is added.
    expect(readAnswer([{ type: 'text', text: 'One. ' }, ...search, { type: 'text', text: 'Two.' }]).text).toBe('One. Two.');
    expect(readAnswer([{ type: 'text', text: 'One.' }, ...search, { type: 'text', text: '\n\nTwo.' }]).text).toBe('One.\n\nTwo.');
    // Blocks with no search between them are one passage, as before.
    expect(readAnswer([{ type: 'text', text: 'One' }, { type: 'text', text: '.Two' }]).text).toBe('One.Two');
    expect(readAnswer([{ type: 'thinking', thinking: '' }, ...search, { type: 'text', text: 'Only.' }]).text).toBe('Only.');
  });

  it('is offered for a hosted Claude model only, on its own key', () => {
    expect(webSearchFor({ kind: 'hosted', provider: 'anthropic', name: 'claude-sonnet-5-5' }, { ANTHROPIC_API_KEY: KEY })?.model).toBe('claude-sonnet-5-5');
    expect(webSearchFor({ kind: 'hosted', provider: 'openai', name: 'gpt-x' }, { OPENAI_API_KEY: KEY })).toBeNull();
    expect(webSearchFor({ kind: 'ollama', name: 'qwen2.5:7b' }, {})).toBeNull();
    expect(webSearchFor({ kind: 'openai-compatible', name: 'm', baseUrl: 'http://127.0.0.1:1234/v1' }, {})).toBeNull();
    expect(() => webSearchFor({ kind: 'hosted', provider: 'anthropic', name: 'claude-sonnet-5-5' }, {})).toThrow(/ANTHROPIC_API_KEY is not set/);
  });
});

describe('list prices', () => {
  it("names a model's list price by its id, with or without a date, and none for a model it does not list", () => {
    expect(listPrice('claude-sonnet-5-5')).toEqual({ input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 });
    expect(listPrice('claude-opus-5-5')).toEqual({ input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 });
    expect(listPrice('claude-opus-5')).toEqual({ input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 });
    expect(listPrice('claude-haiku-4-5-20251001')).toEqual({ input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 });
    expect(listPrice('claude-test-2')).toBeNull();
    expect(listPrice('claude-sonnet-5-5-preview')).toBeNull();
  });

  it('prices tokens at their own rates and each search at $0.01', () => {
    const p = listPrice('claude-sonnet-5-5')!;
    expect(WEB_SEARCH_PRICE).toBe(0.01);
    expect(priceOf({ inputTokens: 1_000_000 }, p)).toBe(2);
    expect(priceOf({ outputTokens: 1_000_000 }, p)).toBe(10);
    expect(priceOf({ cacheReadTokens: 1_000_000, cacheWriteTokens: 1_000_000 }, p)).toBeCloseTo(2.7, 10);
    expect(priceOf({ inputTokens: 7412, outputTokens: 388 }, p, 3)).toBeCloseTo((7412 * 2 + 388 * 10) / 1e6 + 0.03, 10);
    expect(tokensOf({ inputTokens: 1, outputTokens: 2, cacheReadTokens: 3, cacheWriteTokens: 4 })).toBe(10);
  });
});
