import { existsSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { PROVIDERS } from './providers';

// The first run's machine check: which AI apps are installed,
// which provider keys are set (presence only: a value is never read or sent), and which
// local model runtimes are running. Only what it finds is offered.

export interface LocalModel {
  runtime: 'ollama' | 'openai-compatible';
  baseUrl: string;
  name: string;
}

export interface MachineCheck {
  apps: string[]; // "Claude Code", "Codex", "Gemini CLI", "LM Studio"
  keys: string[]; // environment variable names that are set
  local: LocalModel[];
  ollama?: 'running' | 'installed' | 'absent';
}

const APPS: Array<[string, string]> = [
  ['claude', 'Claude Code'],
  ['codex', 'Codex'],
  ['gemini', 'Gemini CLI'],
];
export const KEY_NAMES = [...new Set(PROVIDERS.flatMap((p) => p.keyEnv))];

function onPath(command: string, env: Record<string, string | undefined>): boolean {
  const exts = process.platform === 'win32' ? (env.PATHEXT ?? '.EXE;.CMD;.BAT').split(';') : [''];
  return (env.PATH ?? env.Path ?? '').split(delimiter).some((dir) => dir && exts.some((ext) => existsSync(join(dir, command + ext.toLowerCase())) || existsSync(join(dir, command + ext))));
}

async function getJson(fetchImpl: typeof fetch, url: string, timeoutMs: number): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, { signal: controller.signal });
    return res.ok ? await res.json() : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export interface DetectOptions {
  env?: Record<string, string | undefined>;
  fetch?: typeof fetch;
  timeoutMs?: number;
  ollamaUrl?: string;
  lmStudioUrl?: string;
  home?: string; // the person's home folder, where LM Studio keeps its own; not looked at when absent
}

export async function checkMachine(options: DetectOptions = {}): Promise<MachineCheck> {
  const env = options.env ?? process.env;
  const fetchImpl = options.fetch ?? fetch;
  const timeoutMs = options.timeoutMs ?? 800;
  const ollamaUrl = options.ollamaUrl ?? 'http://127.0.0.1:11434';
  const lmStudioUrl = options.lmStudioUrl ?? 'http://127.0.0.1:1234/v1';

  const apps = APPS.filter(([cmd]) => onPath(cmd, env)).map(([, name]) => name);
  // LM Studio is an app people install by its window, so its own folder, or its lms
  // command, says it is here.
  if (onPath('lms', env) || (options.home && (existsSync(join(options.home, '.lmstudio')) || existsSync(join(options.home, '.cache', 'lm-studio'))))) apps.push('LM Studio');
  const keys = KEY_NAMES.filter((k) => Boolean(env[k]?.trim()));

  const [tags, served] = await Promise.all([getJson(fetchImpl, `${ollamaUrl}/api/tags`, timeoutMs), getJson(fetchImpl, `${lmStudioUrl}/models`, timeoutMs)]);
  const local: LocalModel[] = [];
  for (const m of (tags as { models?: Array<{ name?: string }> } | null)?.models ?? []) {
    if (m.name) local.push({ runtime: 'ollama', baseUrl: ollamaUrl, name: m.name });
  }
  for (const m of (served as { data?: Array<{ id?: string }> } | null)?.data ?? []) {
    if (m.id) local.push({ runtime: 'openai-compatible', baseUrl: lmStudioUrl, name: m.id });
  }
  const ollama = tags ? 'running' : onPath('ollama', env) ? 'installed' : 'absent';
  return { apps, keys, local, ollama };
}
