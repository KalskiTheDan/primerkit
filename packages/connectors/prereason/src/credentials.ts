import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Config } from '@primerkit/core';
import { DEAD_SAID, type KeyWord } from './client';

// PreReason's key pattern, as the bridge checks it.
export const KEY_PATTERN = /^pr_(?:live|test)_[A-Za-z0-9_-]{16,}$/;

export interface ResolvedKey {
  key: string;
  source: 'env' | 'file';
}

// The bridge's credentials file: PREREASON_CREDENTIALS_FILE, or ~/.prereason/credentials.json.
export function credentialsPath(env: Record<string, string | undefined> = process.env, home = homedir()): string {
  return env.PREREASON_CREDENTIALS_FILE || join(home, '.prereason', 'credentials.json');
}

// PREREASON_API_KEY first, then the bridge's credentials file.
// Anything that is not a well formed key reads as no key. The key is never printed.
export function resolveKey(env: Record<string, string | undefined> = process.env, home = homedir()): ResolvedKey | null {
  const fromEnv = env.PREREASON_API_KEY?.trim();
  if (fromEnv && KEY_PATTERN.test(fromEnv)) return { key: fromEnv, source: 'env' };
  const path = credentialsPath(env, home);
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as { api_key?: unknown };
    return typeof parsed.api_key === 'string' && KEY_PATTERN.test(parsed.api_key) ? { key: parsed.api_key, source: 'file' } : null;
  } catch {
    return null;
  }
}

// A key PreReason refused in PREREASON_API_KEY: primerkit cannot replace it, and the bridge's
// login leaves a key set there alone ("--login is for the credentials file. Nothing to do.").
export const ENV_KEY_REFUSED = 'PREREASON_API_KEY holds a key PreReason no longer accepts: set a new one, or unset it and run primerkit connect prereason.';
// A key in PREREASON_API_KEY that PreReason refuses from this machine's address: alive, and the
// person's to move or change.
export const ENV_ADDRESS_REFUSED = "PREREASON_API_KEY holds a key PreReason refuses from this machine's address: in PreReason's settings it is limited to other addresses. Add this address there, or set a new key.";

// A short mark of a key, which tells one key from another without holding it: the config
// keeps PreReason's refusal against the mark, never the key.
export function keyMark(key: string): string {
  return createHash('sha256').update(key).digest('hex').slice(0, 12);
}

// What PreReason said of this key on the last call made with it, as the config keeps it: a
// dead key, with PreReason's own word where it is a known one, or a key limited to other
// addresses. null for a key it served, or one it has said nothing of.
export function keptRefusal(config: Config, key: string): KeyWord | null {
  const p = config.prereason;
  if (!p?.refused || p.refused !== keyMark(key)) return null;
  if (p.refused_why === 'address') return { kind: 'address', said: null };
  return { kind: 'dead', said: p.refused_said && DEAD_SAID.includes(p.refused_said) ? p.refused_said : null };
}

// Keeps PreReason's word on a key in the config (the client's onKey), so doctor says a refused
// key is refused with no call of its own: a 401 for a dead key, or one limited to other
// addresses, keeps the key's mark with what it was, and an answer served to a key clears it.
// The config is written only when that word changes.
export function keepKeyWord(config: { read(): Config; write(config: Config): void }, key: string): (accepted: boolean, refusal: KeyWord | null) => void {
  return (accepted, refusal) => {
    const kept = config.read();
    const was = keptRefusal(kept, key);
    if (accepted ? !kept.prereason?.refused : was && was.kind === refusal?.kind && was.said === (refusal?.said ?? null)) return;
    const { refused: _mark, refused_at: _at, refused_why: _why, refused_said: _said, ...rest } = kept.prereason ?? {};
    const word = refusal?.kind === 'address' ? { refused_why: 'address' as const } : refusal?.said ? { refused_said: refusal.said } : {};
    config.write({ ...kept, prereason: accepted ? rest : { ...rest, refused: keyMark(key), refused_at: new Date().toISOString(), ...word } });
  };
}
