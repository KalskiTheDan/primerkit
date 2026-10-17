import { readConfig, writeConfig } from '@primerkit/core';
import { learnTier, type Tier } from '@primerkit/connector-prereason';

// The tier a key reads at: the one the config keeps, else learned from one keyed read of the
// catalog and kept. Without it a key in PREREASON_API_KEY was read as free, and every paid
// briefing it reads was left out of the catalog and the picks.
export async function tierOfKey(home: string, key: string | null, version: string, options: { fetch?: typeof fetch } = {}): Promise<Tier | null> {
  const kept = (readConfig(home).prereason?.tier as Tier | undefined) ?? null;
  const tier = await learnTier(version, key, kept, options);
  if (tier && tier !== kept) keepTier(home, tier);
  return tier;
}

// A tier PreReason named, kept in the config; a new key's tier replaces the old one.
export function keepTier(home: string, tier: string): void {
  const config = readConfig(home);
  if (config.prereason?.tier === tier) return;
  writeConfig(home, { ...config, prereason: { ...config.prereason, tier, checked_at: new Date().toISOString() } });
}
