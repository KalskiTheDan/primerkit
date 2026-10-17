// Hosted providers a person can bring a key for. A key is read
// from the provider's usual environment variable when a request needs it, is sent only
// to that provider, and is never written to the journal or the config.

export interface Provider {
  id: string;
  name: string; // "Anthropic"
  models: string; // what the choice calls its models: "Claude"
  keyEnv: readonly string[]; // the first one set is used
  baseUrl: string;
  api: 'anthropic' | 'openai';
  contextTokens: number; // a conservative context for fitting; hosted contexts are large
}

export const PROVIDERS: readonly Provider[] = [
  { id: 'anthropic', name: 'Anthropic', models: 'Claude', keyEnv: ['ANTHROPIC_API_KEY'], baseUrl: 'https://api.anthropic.com/v1', api: 'anthropic', contextTokens: 200_000 },
  { id: 'openai', name: 'OpenAI', models: 'ChatGPT models', keyEnv: ['OPENAI_API_KEY'], baseUrl: 'https://api.openai.com/v1', api: 'openai', contextTokens: 128_000 },
  { id: 'google', name: 'Google', models: 'Gemini', keyEnv: ['GEMINI_API_KEY', 'GOOGLE_API_KEY'], baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', api: 'openai', contextTokens: 1_000_000 },
  { id: 'xai', name: 'xAI', models: 'Grok', keyEnv: ['XAI_API_KEY'], baseUrl: 'https://api.x.ai/v1', api: 'openai', contextTokens: 128_000 },
  { id: 'deepseek', name: 'DeepSeek', models: 'DeepSeek', keyEnv: ['DEEPSEEK_API_KEY'], baseUrl: 'https://api.deepseek.com/v1', api: 'openai', contextTokens: 64_000 },
  { id: 'mistral', name: 'Mistral', models: 'Mistral', keyEnv: ['MISTRAL_API_KEY'], baseUrl: 'https://api.mistral.ai/v1', api: 'openai', contextTokens: 128_000 },
  { id: 'groq', name: 'Groq', models: 'open models on Groq', keyEnv: ['GROQ_API_KEY'], baseUrl: 'https://api.groq.com/openai/v1', api: 'openai', contextTokens: 128_000 },
  { id: 'openrouter', name: 'OpenRouter', models: 'models on OpenRouter', keyEnv: ['OPENROUTER_API_KEY'], baseUrl: 'https://openrouter.ai/api/v1', api: 'openai', contextTokens: 128_000 },
];

export function providerById(id: string): Provider | undefined {
  return PROVIDERS.find((p) => p.id === id);
}

// The environment variable a provider's key is in, by name only; the value is not read.
export function keyNameFor(provider: Provider, env: Record<string, string | undefined>): string | null {
  return provider.keyEnv.find((name) => Boolean(env[name]?.trim())) ?? null;
}

export function keyFor(provider: Provider, env: Record<string, string | undefined>): string | null {
  const name = keyNameFor(provider, env);
  return name ? (env[name]?.trim() ?? null) : null;
}

export function providersWithKeys(env: Record<string, string | undefined>): Provider[] {
  return PROVIDERS.filter((p) => keyNameFor(p, env) !== null);
}

// Model ids a provider lists that do not chat: embeddings, speech, images and the like.
const NOT_CHAT = /embed|tts|whisper|dall-e|davinci|babbage|moderation|audio|realtime|transcri|image|search|guard|rerank|ocr/i;

export function chatModels(ids: string[]): string[] {
  return ids.filter((id) => !NOT_CHAT.test(id));
}
