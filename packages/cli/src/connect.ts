import { join } from 'node:path';
import { Snapshots, readConfig, writeConfig, type Config } from '@primerkit/core';
import { ADDRESS_REFUSED, ENV_ADDRESS_REFUSED, ENV_KEY_REFUSED, PreReasonClient, connectPreReason, fetchCatalog, keepKeyWord, keptRefusal, resolveKey, smallestFree, type ClaimOptions, type KeyWord, type ResolvedKey } from '@primerkit/connector-prereason';
import { messageOf, readBriefing } from '@primerkit/session';

// primerkit connect prereason, and the doctor's PreReason key line. PreReason, the bridge and
// the environment are given, so tests run them as fakes.
export interface ConnectIo {
  print(lines: string[]): void;
  fail(message: string): number;
  home: string;
  version: string;
  env?: Record<string, string | undefined>;
  fetch?: typeof fetch; // PreReason, faked in tests
  spawn?: ClaimOptions['spawn']; // the bridge, faked in tests
}

const store = (home: string) => ({ read: () => readConfig(home), write: (c: Config) => writeConfig(home, c) });
const where = (key: ResolvedKey) => (key.source === 'env' ? 'PREREASON_API_KEY' : 'the bridge credentials file');

// PreReason on a key, for any command: a refusal it answers is kept in the config, so the
// doctor can say it with no call of its own.
export function prereasonOn(home: string, key: string | null, version: string, fetchImpl?: typeof fetch): PreReasonClient {
  return new PreReasonClient({ key, version, ...(key ? { onKey: keepKeyWord(store(home), key) } : {}), ...(fetchImpl ? { fetch: fetchImpl } : {}) });
}

// One call on the smallest free briefing learns the key's tier, which PreReason names on
// its answer, as the session does once it connects. The briefing is kept as a snapshot.
// refused: PreReason refused the key (a 401 for a dead key, or one limited to other
// addresses), so the key is no connection here; null where it said nothing of the key, or
// could not check it, which the next call tries again.
export async function keyTier(io: ConnectIo, key: string): Promise<{ line: string; refused: KeyWord | null }> {
  const data = prereasonOn(io.home, key, io.version, io.fetch);
  try {
    const smallest = smallestFree(await fetchCatalog(io.version, io.fetch ? { fetch: io.fetch } : {}));
    if (smallest) await readBriefing({ data, snapshots: new Snapshots(join(io.home, 'snapshots')) }, smallest.id, 'json');
  } catch (error) {
    return { line: `The tier could not be read: ${messageOf(error)}`, refused: data.refusal?.kind === 'unchecked' ? null : data.refusal };
  }
  const calls = data.budget ? `${data.budget.remaining.toLocaleString('en-US')} of ${data.budget.limit.toLocaleString('en-US')} calls left today` : null;
  if (!data.tier) return { line: `PreReason did not name the key's tier, so it is not known${calls ? `; ${calls}` : ''}.`, refused: null };
  writeConfig(io.home, { ...readConfig(io.home), prereason: { tier: data.tier, checked_at: new Date().toISOString() } });
  return { line: `Tier: ${data.tier}${calls ? `, ${calls}` : ''}.`, refused: null };
}

// A key already set is checked with that one call. A key PreReason no longer accepts (revoked
// in its settings, say) is no connection: the bridge's login runs as for a first connect, and
// saves its new key over the refused one in its credentials file (it asks for a new key while
// one is saved there, and writes the file whole). A key limited to other addresses is alive,
// but the person ran this command for a key that works here, so the login runs too: the old
// key stays until the person approves the link. A refused key in PREREASON_API_KEY is
// primerkit's to name, not to replace.
export async function connectPrereason(io: ConnectIo): Promise<number> {
  const env = io.env ?? process.env;
  const existing = resolveKey(env);
  let refused: string | null = null;
  if (existing) {
    const tier = await keyTier(io, existing.key);
    if (!tier.refused) {
      io.print([`PreReason is already connected, through ${where(existing)}.`, tier.line]);
      return 0;
    }
    const address = tier.refused.kind === 'address';
    if (existing.source === 'env') return io.fail(address ? ENV_ADDRESS_REFUSED : ENV_KEY_REFUSED);
    io.print(address ? [ADDRESS_REFUSED, 'Connecting again:'] : [`The saved key is no longer accepted by PreReason${tier.refused.said ? ` (${tier.refused.said})` : ''}. Connecting again:`]);
    refused = existing.key;
  }
  return new Promise((resolve) => {
    connectPreReason(
      (event) => {
        if (event.kind === 'link') io.print([`Open this link to approve primerkit:`, `  ${event.url}`, 'Waiting for your approval. The link works for 15 minutes.']);
        if (event.kind === 'ended') {
          // Connected means a key primerkit can read, not only the bridge's word: and not the
          // refused key, still in the file where the bridge could not save its new one.
          const saved = event.approved ? resolveKey(env) : null;
          const fresh = saved && saved.key !== refused ? saved : null;
          const why = !event.approved
            ? event.message.replace(/^PreReason:\s*/, '').replace(/\.+$/, '')
            : saved
              ? 'the bridge approved access, but the credentials file still holds the key PreReason refused'
              : 'the bridge approved access, but no key was found where it saves one';
          if (!fresh) {
            io.print([`Not connected: ${why}.`]);
            return resolve(1);
          }
          void keyTier(io, fresh.key).then((tier) => {
            io.print([`Connected. The key is in ${where(fresh)}.`, tier.line]);
            resolve(0);
          });
        }
      },
      { env, ...(io.spawn ? { spawn: io.spawn } : {}) },
    );
  });
}

// The doctor's PreReason key line, from the config alone: a key PreReason refused on its last
// call is an x, with why and how to connect again. A key PreReason could not check is not
// kept as refused, so it stays ok.
export function keyLine(key: ResolvedKey | null, config: Config): [boolean, string] {
  if (!key) return [false, 'PreReason is not connected: primerkit connect prereason'];
  const refused = keptRefusal(config, key.key);
  if (refused?.kind === 'address') return [false, key.source === 'env' ? `PreReason key: ${ENV_ADDRESS_REFUSED.replace(/\.$/, '')}` : "PreReason key: PreReason refuses it from this machine's address; add this address in PreReason's settings, or run primerkit connect prereason for a new key"];
  if (refused) return [false, key.source === 'env' ? `PreReason key: ${ENV_KEY_REFUSED.replace(/\.$/, '')}` : `PreReason key: PreReason does not accept it${refused.said ? ` (${refused.said})` : ''}; primerkit connect prereason makes a new one`];
  return [true, `PreReason key: found in ${where(key)}${config.prereason?.tier ? `, ${config.prereason.tier} tier` : ''}`];
}
