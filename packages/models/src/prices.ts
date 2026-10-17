// List prices of the hosted models primerkit can name a cost for before a run, in dollars a
// million tokens: input, output, and the cache's reads and five minute writes. Anthropic's
// first party rates as of 2026-10-06; Haiku 5.5's are for a prompt of 100,000 tokens or fewer.
// A model not listed has no price primerkit can state, so nothing that must state one runs on it.

export interface ListPrice {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

const PRICES: ReadonlyArray<[string, ListPrice]> = [
  ['claude-fable-5-1', { input: 10, output: 50, cacheRead: 0.25, cacheWrite: 12.5 }],
  ['claude-fable-5', { input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5 }],
  ['claude-opus-5-5', { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 }],
  ['claude-opus-5', { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 }],
  ['claude-opus-4-8', { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 }],
  ['claude-opus-4-7', { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 }],
  ['claude-opus-4-6', { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 }],
  ['claude-sonnet-5-5', { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 }],
  ['claude-sonnet-5', { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 }],
  ['claude-sonnet-4-6', { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 }],
  ['claude-haiku-5-5', { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125 }],
  ['claude-haiku-4-5', { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 }],
];

// What one web search costs on Anthropic: $10 a thousand.
export const WEB_SEARCH_PRICE = 0.01;

// A model's list price by its id, or the id with a date after it; claude-opus-5 is not
// claude-opus-5-5.
export function listPrice(model: string): ListPrice | null {
  return PRICES.find(([id]) => model === id || new RegExp(`^${id}-\\d{8}$`).test(model))?.[1] ?? null;
}

export interface Usage {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}

// Every token a call read or wrote, the cache's included.
export const tokensOf = (u: Usage): number => (u.inputTokens ?? 0) + (u.outputTokens ?? 0) + (u.cacheReadTokens ?? 0) + (u.cacheWriteTokens ?? 0);

// What tokens and searches come to at list prices, in dollars.
export function priceOf(u: Usage, p: ListPrice, searches = 0): number {
  return ((u.inputTokens ?? 0) * p.input + (u.outputTokens ?? 0) * p.output + (u.cacheReadTokens ?? 0) * p.cacheRead + (u.cacheWriteTokens ?? 0) * p.cacheWrite) / 1e6 + searches * WEB_SEARCH_PRICE;
}
