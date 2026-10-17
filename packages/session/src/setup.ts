import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { blockFromJson, blockFromMarkdown, type BenchFile, type ConfigModel, type DataBlock, type ModelAdapter, type ModelCapabilities, type Operation, type PacketFormat } from '@primerkit/core';
import type { FitnessInput, ModelSpec } from '@primerkit/models';
import type { CatalogEntry } from '@primerkit/connector-prereason';

// The config's model as a spec, and back. A key is never part of either.
export function specFromConfig(m: ConfigModel): ModelSpec {
  if (m.kind === 'hosted') return { kind: 'hosted', provider: m.provider ?? '', name: m.name };
  if (m.kind === 'openai-compatible') return { kind: 'openai-compatible', name: m.name, baseUrl: m.base_url ?? 'http://127.0.0.1:1234/v1', ...(m.context_tokens ? { contextTokens: m.context_tokens } : {}) };
  return { kind: 'ollama', name: m.name, ...(m.base_url ? { baseUrl: m.base_url } : {}), ...(m.max_context ? { maxContext: m.max_context } : {}) };
}

export function configFromSpec(spec: ModelSpec): ConfigModel {
  if (spec.kind === 'hosted') return { kind: 'hosted', provider: spec.provider, name: spec.name };
  if (spec.kind === 'openai-compatible') return { kind: 'openai-compatible', name: spec.name, base_url: spec.baseUrl, ...(spec.contextTokens ? { context_tokens: spec.contextTokens } : {}) };
  return { kind: 'ollama', name: spec.name, ...(spec.baseUrl ? { base_url: spec.baseUrl } : {}), ...(spec.maxContext ? { max_context: spec.maxContext } : {}) };
}

// A model with the packet format its fitness check proposed, where the config keeps one.
export function withFormat(model: ModelAdapter, format: PacketFormat | undefined): ModelAdapter {
  if (!format) return model;
  return {
    id: model.id,
    label: model.label,
    capabilities: async (): Promise<ModelCapabilities> => ({ ...(await model.capabilities()), format }),
    complete: (packet, repair, signal) => model.complete(packet, repair, signal),
  };
}

// The digest's watchlist when the person has set none: three briefings, on macro, on
// correlations across markets and on Bitcoin, in that order, where the catalog still
// lists them, or else the first three the tier reads.
export const DEFAULT_WATCHLIST = ['macro.snapshot', 'cross.correlations', 'btc.context'];

export function defaultWatchlist(readable: CatalogEntry[]): string[] {
  const listed = DEFAULT_WATCHLIST.filter((id) => readable.some((b) => b.id === id));
  return listed.length ? listed : readable.slice(0, 3).map((b) => b.id);
}

// The fitness check reads saved briefings and the benchmark slice, never PreReason.
export function fitnessInputs(root: string, ask: Operation): Pick<FitnessInput, 'ask' | 'askBlock' | 'largest' | 'bench' | 'benchData'> {
  const dir = join(root, 'operations', 'bench-comprehension', 'briefings-2026-09-25');
  const at = '2026-09-25T09:06:00.000Z';
  const md = (id: string): DataBlock => blockFromMarkdown(id, readFileSync(join(dir, `${id}.md`), 'utf8'), at);
  const json = (id: string): DataBlock => blockFromJson(id, readFileSync(join(dir, `${id}.json`), 'utf8'), at);
  const largest = ['btc.pulse', 'btc.context', 'macro.snapshot'];
  const bench = JSON.parse(readFileSync(join(root, 'operations', 'bench-comprehension', 'questions-2026-09-25.json'), 'utf8')) as BenchFile;
  return {
    ask,
    askBlock: { markdown: md('btc.pulse'), json: json('btc.pulse') },
    largest: { markdown: largest.map(md), json: largest.map(json) },
    bench,
    benchData: (briefing, format) => (format === 'markdown' ? readFileSync(join(dir, `${briefing}.md`), 'utf8') : json(briefing).lines.join('\n')),
  };
}
