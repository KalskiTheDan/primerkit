import type { ModelAdapter } from '@primerkit/core';
import { AnthropicModel, listAnthropicModels } from './anthropic';
import { ModelError } from './chat';
import { OllamaModel, OLLAMA_URL } from './ollama';
import { OpenAICompatibleModel, listOpenAICompatibleModels } from './openai-compatible';
import { keyFor, providerById, type Provider } from './providers';
import { AnthropicWebSearch } from './web-search';

// Which model to run, as the config keeps it. A hosted model's key is never part of it:
// it is read from the provider's environment variable when a request needs it.
export type ModelSpec =
  | { kind: 'ollama'; name: string; baseUrl?: string; maxContext?: number }
  | { kind: 'openai-compatible'; name: string; baseUrl: string; contextTokens?: number }
  | { kind: 'hosted'; provider: string; name: string };

export function adapterFor(spec: ModelSpec, env: Record<string, string | undefined> = process.env, fetchImpl?: typeof fetch): ModelAdapter {
  const f = fetchImpl ? { fetch: fetchImpl } : {};
  if (spec.kind === 'ollama') {
    return new OllamaModel({ model: spec.name, baseUrl: spec.baseUrl ?? OLLAMA_URL, ...(spec.maxContext ? { maxContextTokens: spec.maxContext } : {}), ...f });
  }
  if (spec.kind === 'openai-compatible') {
    return new OpenAICompatibleModel({ model: spec.name, baseUrl: spec.baseUrl, ...(spec.contextTokens ? { contextTokens: spec.contextTokens } : {}), ...f });
  }
  const provider = providerById(spec.provider);
  if (!provider) throw new ModelError(`primerkit does not know the provider ${spec.provider}`);
  const key = keyFor(provider, env);
  if (!key) throw new ModelError(`${provider.keyEnv[0]} is not set, so ${provider.name} cannot be asked`);
  if (provider.api === 'anthropic') return new AnthropicModel({ apiKey: key, model: spec.name, baseUrl: provider.baseUrl, contextTokens: provider.contextTokens, ...f });
  return new OpenAICompatibleModel({ baseUrl: provider.baseUrl, apiKey: key, model: spec.name, provider: provider.name, defaultContext: provider.contextTokens, ...f });
}

// The web search the compare view asks beside the briefings: Anthropic's own tool, on the
// person's key, for a hosted Claude model, and none for any other model.
export function webSearchFor(spec: ModelSpec, env: Record<string, string | undefined> = process.env, fetchImpl?: typeof fetch): AnthropicWebSearch | null {
  if (spec.kind !== 'hosted') return null;
  const provider = providerById(spec.provider);
  if (provider?.api !== 'anthropic') return null;
  const key = keyFor(provider, env);
  if (!key) throw new ModelError(`${provider.keyEnv[0]} is not set, so ${provider.name} cannot be asked`);
  return new AnthropicWebSearch({ apiKey: key, model: spec.name, baseUrl: provider.baseUrl, ...(fetchImpl ? { fetch: fetchImpl } : {}) });
}

// The models a provider offers, asked with the person's key, which goes to that provider only.
export function listProviderModels(provider: Provider, env: Record<string, string | undefined> = process.env, fetchImpl: typeof fetch = fetch): Promise<string[]> {
  const key = keyFor(provider, env);
  if (!key) return Promise.reject(new ModelError(`${provider.keyEnv[0]} is not set`));
  return provider.api === 'anthropic' ? listAnthropicModels(key, fetchImpl, provider.baseUrl) : listOpenAICompatibleModels(provider.baseUrl, key, fetchImpl);
}

// Whether a run sends packets off this machine, and to whom.
export function whereItRuns(spec: ModelSpec): { local: boolean; to: string } {
  if (spec.kind === 'hosted') return { local: false, to: providerById(spec.provider)?.name ?? spec.provider };
  const url = spec.kind === 'ollama' ? (spec.baseUrl ?? OLLAMA_URL) : spec.baseUrl;
  const host = (() => {
    try {
      return new URL(url).hostname;
    } catch {
      return url;
    }
  })();
  const local = ['localhost', '127.0.0.1', '::1', '[::1]'].includes(host);
  return { local, to: local ? 'this machine' : host };
}
