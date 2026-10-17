import { ModelError, errorText, reach } from './chat';
import type { Usage } from './prices';

// One question asked of Claude with Anthropic's web search tool and nothing else: no packet,
// no briefing, no schema. Its text comes back as Claude wrote it, with the searches it ran,
// the pages they returned and the pages its text cites, and what the calls used. Errors
// of a search come back inside the answer, not as a failed request, and are kept as such.

export interface WebSearchOptions {
  apiKey: string;
  model: string;
  baseUrl?: string;
  fetch?: typeof fetch;
  maxUses?: number;
}

export interface WebPage {
  url: string;
  title: string;
  pageAge: string | null; // as the search result gives it
}

export interface WebAnswer {
  text: string; // every text block, in order, joined as they came
  searches: number;
  queries: string[];
  pages: WebPage[]; // what the searches returned, each once
  cited: WebPage[]; // what the text cites, each once
  errors: string[]; // a search's own error codes, such as max_uses_exceeded
  usage: Usage;
  modelReported?: string;
  stopReason: string | null;
  tool: string;
  maxUses: number;
  turns: number;
  content: unknown[]; // the content as returned, less the encrypted bodies, for the journal
}

export interface WebSearcher {
  readonly model: string;
  readonly maxUses: number; // the most searches one question may run
  ask(question: string, options: { system: string; signal?: AbortSignal }): Promise<WebAnswer>;
}

// A web search that ended without an answer, with what its turns had used and returned by
// then: the searches and tokens of the turns before a failure are paid for all the same.
export class WebSearchError extends ModelError {
  constructor(
    message: string,
    readonly sofar: WebAnswer,
    status: number | null = null,
  ) {
    super(message, status);
  }
}

export const WEB_SEARCH_MAX_USES = 5;
const VERSION = '2023-06-01';
const DYNAMIC = 'web_search_20260209';
const BASIC = 'web_search_20250305';
// A turn paused by the server's own loop is sent again, at most this many times in all.
const MAX_TURNS = 3;

// The newer tool filters results before the model reads them, on the models that have it;
// older models take the basic one. Neither is declared beside code execution.
const NEWER = /^claude-(?:opus-(?:5-5|5|4-8|4-7|4-6)|sonnet-(?:5-5|5|4-6))(?:-\d{8})?$/;
export function webSearchTool(model: string): string {
  return NEWER.test(model) ? DYNAMIC : BASIC;
}

// A model that refused the newer tool with a 400 naming it is asked with the basic one
// while primerkit runs.
const TOOLS = new Map<string, string>();

interface Block {
  type?: string;
  text?: string;
  name?: string;
  input?: { query?: unknown };
  content?: unknown;
  citations?: Array<{ type?: string; url?: unknown; title?: unknown }>;
}

interface Body {
  content?: Block[];
  model?: string;
  stop_reason?: string;
  usage?: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number; server_tool_use?: { web_search_requests?: number } };
}

// The encrypted bodies are for Anthropic alone; the journal keeps what a person can read.
function readable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(readable);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).filter(([k]) => !k.startsWith('encrypted')).map(([k, v]) => [k, readable(v)]));
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '');

export class AnthropicWebSearch implements WebSearcher {
  readonly model: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  readonly maxUses: number;

  constructor(private readonly options: WebSearchOptions) {
    this.model = options.model;
    this.baseUrl = (options.baseUrl ?? 'https://api.anthropic.com/v1').replace(/\/$/, '');
    this.fetchImpl = options.fetch ?? fetch;
    this.maxUses = options.maxUses ?? WEB_SEARCH_MAX_USES;
  }

  // No temperature and no tool_choice: the newest models refuse both, and the tool is the
  // only one declared, so the model chooses when to search.
  private async send(tool: string, system: string, messages: unknown[], maxUses: number, signal?: AbortSignal): Promise<Response> {
    return reach(this.fetchImpl, `${this.baseUrl}/messages`, {
      method: 'POST',
      ...(signal ? { signal } : {}),
      headers: { 'Content-Type': 'application/json', 'x-api-key': this.options.apiKey, 'anthropic-version': VERSION },
      body: JSON.stringify({ model: this.model, max_tokens: 16_000, system, messages, tools: [{ type: tool, name: 'web_search', max_uses: maxUses }] }),
    }, 'Anthropic');
  }

  async ask(question: string, { system, signal }: { system: string; signal?: AbortSignal }): Promise<WebAnswer> {
    let tool = TOOLS.get(this.model) ?? webSearchTool(this.model);
    const content: Block[] = [];
    const usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
    let searches = 0;
    let counted = false;
    let turns = 0;
    let body: Body = {};
    // What the turns so far used and returned, as an answer has it.
    const sofar = (): WebAnswer => {
      const answer = readAnswer(content);
      return {
        ...answer,
        // Where the usage does not count the searches, each search Claude asked for is one.
        searches: counted ? searches : answer.queries.length,
        usage: Object.fromEntries(Object.entries(usage).filter(([, n]) => n > 0)) as Usage,
        ...(body.model ? { modelReported: body.model } : {}),
        stopReason: body.stop_reason ?? null,
        tool,
        maxUses: this.maxUses,
        turns,
        content: readable(content) as unknown[],
      };
    };
    // Every way a search ends without an answer carries what it spent.
    const failed = (message: string, status: number | null = null): WebSearchError => new WebSearchError(message, sofar(), status);
    for (;;) {
      // A paused turn goes back with what Claude wrote so far, and the server carries on;
      // the searches it may still run are what is left of the cap.
      const messages = [{ role: 'user', content: question }, ...(content.length ? [{ role: 'assistant', content }] : [])];
      let res: Response;
      try {
        res = await this.send(tool, system, messages, this.maxUses - searches, signal);
      } catch (error) {
        // A stop is not a failure, and goes on as it came.
        if (!(error instanceof ModelError)) throw error;
        throw failed(error.message, error.status);
      }
      if (!res.ok) {
        const message = await errorText(res);
        if (res.status === 400 && tool === DYNAMIC && message.includes(DYNAMIC)) {
          tool = BASIC;
          TOOLS.set(this.model, BASIC);
          continue;
        }
        throw failed(`Anthropic answered ${res.status}: ${message}`, res.status);
      }
      try {
        body = (await res.json()) as Body;
      } catch (error) {
        if (signal?.aborted) throw error;
        throw failed('Anthropic returned an answer that could not be read');
      }
      turns += 1;
      content.push(...(body.content ?? []));
      const u = body.usage ?? {};
      usage.inputTokens += u.input_tokens ?? 0;
      usage.outputTokens += u.output_tokens ?? 0;
      usage.cacheReadTokens += u.cache_read_input_tokens ?? 0;
      usage.cacheWriteTokens += u.cache_creation_input_tokens ?? 0;
      if (typeof u.server_tool_use?.web_search_requests === 'number') {
        searches += u.server_tool_use.web_search_requests;
        counted = true;
      }
      if (body.stop_reason !== 'pause_turn' || turns >= MAX_TURNS || this.maxUses - searches < 1) break;
    }
    // A turn still paused at a cap is not finished: what Claude wrote so far can be "I'll
    // search for…", which is no answer.
    if (body.stop_reason === 'pause_turn') throw failed(turns >= MAX_TURNS ? `Claude did not finish its answer in ${MAX_TURNS} rounds (stop reason: pause_turn)` : `Claude did not finish its answer in its ${this.maxUses} searches (stop reason: pause_turn)`);
    if (body.stop_reason === 'refusal') throw failed('Claude declined to answer (stop reason: refusal)');
    if (body.stop_reason === 'max_tokens' || body.stop_reason === 'model_context_window_exceeded') throw failed(`Claude ran out of room before its answer was finished (stop reason: ${body.stop_reason})`);
    const answer = sofar();
    if (!answer.text.trim()) throw failed('Anthropic returned no answer');
    return answer;
  }
}

// What the content holds: the text as written, the searches, what they returned, and what
// the text cites. A result's content is a list of pages, or one error object.
export function readAnswer(blocks: unknown[]): Pick<WebAnswer, 'text' | 'queries' | 'pages' | 'cited' | 'errors'> {
  const content = blocks as Block[];
  const texts: string[] = [];
  const queries: string[] = [];
  const pages = new Map<string, WebPage>();
  const cited = new Map<string, WebPage>();
  const errors: string[] = [];
  let tail = ''; // the text so far, its last block with words
  let between = false; // a search, its result or thinking since that block
  for (const block of content) {
    if (block.type === 'text' && typeof block.text === 'string') {
      // Text on either side of a search is two passages. Where the model put no space or
      // break between them, as older models do not, they stand a paragraph apart, as their
      // blocks do, and are not glued into one word ("…born.Based on…"). Nothing else changes.
      if (block.text) {
        if (between && tail && !/\s$/.test(tail) && !/^\s/.test(block.text)) texts.push('\n\n');
        tail = block.text;
        between = false;
      }
      texts.push(block.text);
      for (const c of block.citations ?? []) {
        if (c.type === 'web_search_result_location' && str(c.url) && !cited.has(str(c.url))) cited.set(str(c.url), { url: str(c.url), title: str(c.title), pageAge: null });
      }
      continue;
    }
    between = true;
    if (block.type === 'server_tool_use' && block.name === 'web_search') {
      queries.push(str(block.input?.query));
    } else if (block.type === 'web_search_tool_result') {
      if (Array.isArray(block.content)) {
        for (const r of block.content as Array<{ type?: string; url?: unknown; title?: unknown; page_age?: unknown }>) {
          if (r.type === 'web_search_result' && str(r.url) && !pages.has(str(r.url))) pages.set(str(r.url), { url: str(r.url), title: str(r.title), pageAge: str(r.page_age) || null });
        }
      } else if (block.content && typeof block.content === 'object') {
        errors.push(str((block.content as { error_code?: unknown }).error_code) || 'unknown');
      }
    }
  }
  return { text: texts.join(''), queries, pages: [...pages.values()], cited: [...cited.values()], errors };
}
