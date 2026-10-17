import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { readConfig, writeConfig } from '@primerkit/core';
import { keyMark, type ClaimProcess } from '@primerkit/connector-prereason';
import { connectPrereason, keyLine, prereasonOn, type ConnectIo } from '../src/connect';
import { doctorLine } from '../src/terminal';

const BIN = fileURLToPath(new URL('../bin/primerkit.js', import.meta.url));
// PreReason as a fake inside the command's own process: nothing reaches PreReason.
const FAKE = pathToFileURL(fileURLToPath(new URL('./fake-prereason.mjs', import.meta.url))).href;

// Keys are built here, never written out but to a scratch folder, and are not real keys.
const fakeKey = (tag: string) => `pr_test_${tag.repeat(20)}`;
const REFUSED = fakeKey('r');
const FRESH = fakeKey('n');
const GOOD = fakeKey('g');

// PreReason's answer to a key it no longer accepts, as a revoked key was answered on 10-14.
const REVOKED = JSON.stringify({ error: 'INVALID_API_KEY', message: 'Invalid or expired API key' });
const CATALOG = JSON.stringify({ briefings: [{ id: 'btc.quick-check', name: 'BTC Quick Check', description: 'free', tier: 'free', metrics_count: 3 }] });
const BRIEFING = JSON.stringify({ briefing_used: 'btc.quick-check', generated_at: '2026-10-14T00:00:00Z', metrics: { 'bitcoin-price': { value: 1 } } });

// PreReason's other 401s (its auth middleware, Front main d053477b): a live key limited in its
// settings to other addresses, and its own fault checking a key. Neither is a dead key.
const ADDRESS = JSON.stringify({ error: 'INVALID_API_KEY', message: 'IP address 203.0.113.9 is not in the whitelist for this API key' });
const UNCHECKED = JSON.stringify({ error: 'INVALID_API_KEY', message: 'API key validation failed' });
const ADDRESS_LINE = "PreReason refused the saved key from this machine's address: in PreReason's settings it is limited to other addresses. primerkit keeps it; add this address there, or run primerkit connect prereason for a new key.";
const UNCHECKED_LINE = 'PreReason could not check the saved key just now. primerkit keeps it and tries again on the next call.';

// PreReason as a fake: the keyless catalog, a 401 for the refused keys (as a dead key is
// answered, unless another answer is given), and a served briefing that names the tier for
// any other key.
function prereason(refused: string[], answer = REVOKED) {
  const seen: string[] = [];
  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const auth = ((init?.headers ?? {}) as Record<string, string>).Authorization ?? '';
    seen.push(url.pathname);
    if (url.pathname === '/api/context/briefings') return new Response(CATALOG, { status: 200 });
    if (refused.some((k) => auth === `Bearer ${k}`)) return new Response(answer, { status: 401 });
    return new Response(BRIEFING, { status: 200, headers: { 'x-prereason-tier': 'free', 'x-ratelimit-limit-day': '100', 'x-ratelimit-remaining-day': '99' } });
  }) as typeof fetch;
  return { seen, impl };
}

// PreReason's bridge as a fake: its link, then how it ends. On approval it saves the new key
// over its credentials file, as @prereason/mcp's --login does (writeCredentials, a whole file).
function bridge(end: 'approve' | 'expire' | 'approve-unsaved', file: string) {
  const runs: Array<{ args: string[]; client: string | undefined }> = [];
  const spawn = (_command: string, args: string[], env: Record<string, string | undefined>): ClaimProcess => {
    runs.push({ args, client: env.PREREASON_CLIENT });
    let onLine: (line: string) => void = () => {};
    return {
      onLine: (l) => void (onLine = l),
      onExit: (l) =>
        queueMicrotask(() => {
          onLine('PreReason: no API key found. Open https://www.prereason.com/claim/PR-ABCD-2345 to approve access (link expires in 15 min).');
          if (end === 'expire') {
            onLine('PreReason: access was not granted (the link expired before it was approved). Restart the bridge to ask again, or set PREREASON_API_KEY. Free tools still work.');
            return l(1);
          }
          if (end === 'approve') writeFileSync(file, JSON.stringify({ version: 1, api_key: FRESH }));
          onLine(`PreReason: access approved. Key "Agent key" saved to ${file}; get_context and get_metric work from the next call.`);
          l(0);
        }),
      kill: () => {},
    };
  };
  return { runs, spawn };
}

type TestIo = ConnectIo & { out: string[]; errors: string[] };

// A home and a credentials file holding the key given; the environment holds no key unless given.
function setup(fileKey: string | null, envKey?: string) {
  const dir = mkdtempSync(join(tmpdir(), 'pk-revoked-'));
  const file = join(dir, 'credentials.json');
  if (fileKey) writeFileSync(file, JSON.stringify({ version: 1, api_key: fileKey }));
  const env = { PREREASON_CREDENTIALS_FILE: file, ...(envKey ? { PREREASON_API_KEY: envKey } : {}) };
  return { dir, file, env };
}

function io(dir: string, env: Record<string, string>, net: ReturnType<typeof prereason>, b: ReturnType<typeof bridge>): TestIo {
  const out: string[] = [];
  const errors: string[] = [];
  return { out, errors, print: (lines) => void out.push(...lines), fail: (m) => (errors.push(m), 1), home: join(dir, 'home'), version: '0.0.0', env, fetch: net.impl, spawn: b.spawn };
}

const savedKey = (file: string) => (JSON.parse(readFileSync(file, 'utf8')) as { api_key: string }).api_key;
const LINK = ['Open this link to approve primerkit:', '  https://www.prereason.com/claim/PR-ABCD-2345', 'Waiting for your approval. The link works for 15 minutes.'];

describe('primerkit connect prereason, with a key PreReason no longer accepts', () => {
  it('says so of a refused key in the credentials file, runs the claim, and the bridge saves the new key over it', async () => {
    const { dir, file, env } = setup(REFUSED);
    const b = bridge('approve', file);
    const t = io(dir, env, prereason([REFUSED]), b);
    expect(await connectPrereason(t)).toBe(0);
    expect(t.out).toEqual(['The saved key is no longer accepted by PreReason (Invalid or expired API key). Connecting again:', ...LINK, 'Connected. The key is in the bridge credentials file.', 'Tier: free, 99 of 100 calls left today.']);
    expect(t.errors).toEqual([]);
    expect(b.runs).toEqual([{ args: ['-y', '@prereason/mcp@^0.9.0', '--login'], client: 'primerkit' }]);
    expect(savedKey(file)).toBe(FRESH);
    // The new key read its tier; the refusal of the old one is no longer kept.
    expect(readConfig(t.home).prereason).toMatchObject({ tier: 'free' });
    expect(readConfig(t.home).prereason?.refused).toBeUndefined();
    // No key is ever printed, the refused one or the new one.
    for (const key of [REFUSED, FRESH]) expect([...t.out, ...t.errors].join('\n')).not.toContain(key);
  });

  it('exits 1 when the claim is not granted, and the doctor still says the saved key is refused', async () => {
    const { dir, file, env } = setup(REFUSED);
    const t = io(dir, env, prereason([REFUSED]), bridge('expire', file));
    expect(await connectPrereason(t)).toBe(1);
    expect(t.out).toEqual(['The saved key is no longer accepted by PreReason (Invalid or expired API key). Connecting again:', ...LINK, 'Not connected: access was not granted (the link expired before it was approved). Restart the bridge to ask again, or set PREREASON_API_KEY. Free tools still work.']);
    expect(savedKey(file)).toBe(REFUSED);
    expect(keyLine({ key: REFUSED, source: 'file' }, readConfig(t.home))).toEqual([false, 'PreReason key: PreReason does not accept it (Invalid or expired API key); primerkit connect prereason makes a new one']);
  });

  it('is not connected where the bridge approved but the refused key is still in its file', async () => {
    const { dir, file, env } = setup(REFUSED);
    const t = io(dir, env, prereason([REFUSED]), bridge('approve-unsaved', file));
    expect(await connectPrereason(t)).toBe(1);
    expect(t.out.at(-1)).toBe('Not connected: the bridge approved access, but the credentials file still holds the key PreReason refused.');
  });

  it('names a refused key in PREREASON_API_KEY, which it cannot replace, exits 1, and starts no claim', async () => {
    const { dir, file, env } = setup(GOOD, REFUSED);
    const b = bridge('approve', file);
    const t = io(dir, env, prereason([REFUSED]), b);
    expect(await connectPrereason(t)).toBe(1);
    expect(t.errors).toEqual(['PREREASON_API_KEY holds a key PreReason no longer accepts: set a new one, or unset it and run primerkit connect prereason.']);
    expect(t.out).toEqual([]);
    expect(b.runs).toEqual([]);
    expect(savedKey(file)).toBe(GOOD);
  });

  it('CONTROL: a key PreReason accepts is connected as before, with its tier, and no claim', async () => {
    const { dir, file, env } = setup(GOOD);
    const b = bridge('approve', file);
    const t = io(dir, env, prereason([REFUSED]), b);
    expect(await connectPrereason(t)).toBe(0);
    expect(t.out).toEqual(['PreReason is already connected, through the bridge credentials file.', 'Tier: free, 99 of 100 calls left today.']);
    expect(b.runs).toEqual([]);
    // A read that cannot reach PreReason is no refusal: it is connected, with the reason.
    const down = io(dir, env, { seen: [], impl: (async () => { throw new Error('ECONNREFUSED'); }) as typeof fetch }, b);
    expect(await connectPrereason(down)).toBe(0);
    expect(down.out).toEqual(['PreReason is already connected, through the bridge credentials file.', 'The tier could not be read: ECONNREFUSED']);
    expect(b.runs).toEqual([]);
  });
});

// The wording review, 10-15: a 401 from PreReason is not always a dead key.
describe('what a 401 says of the key', () => {
  const read = (answer: string) => {
    const dir = mkdtempSync(join(tmpdir(), 'pk-401-'));
    const client = prereasonOn(dir, REFUSED, '0.0.0', prereason([REFUSED], answer).impl);
    return { dir, client, fetched: client.fetch({ briefing: 'macro.snapshot', format: 'json' }) };
  };

  it('refuses a dead key, and keeps PreReason\'s own word for it', async () => {
    const { dir, client, fetched } = read(REVOKED);
    await expect(fetched).rejects.toThrow('PreReason did not accept the key');
    expect(client.keyAccepted).toBe(false);
    expect(readConfig(dir).prereason).toMatchObject({ refused: keyMark(REFUSED), refused_said: 'Invalid or expired API key' });
    // Words PreReason does not send for a dead key are not kept, nor said.
    const odd = read(JSON.stringify({ error: 'INVALID_API_KEY', message: 'something else' }));
    await expect(odd.fetched).rejects.toThrow('PreReason did not accept the key');
    expect(odd.client.keyAccepted).toBe(false);
    expect(readConfig(odd.dir).prereason?.refused_said).toBeUndefined();
    expect(keyLine({ key: REFUSED, source: 'file' }, readConfig(odd.dir))).toEqual([false, 'PreReason key: PreReason does not accept it; primerkit connect prereason makes a new one']);
  });

  it('keeps a key limited to other addresses, says so, and the doctor shows it until an answer is served', async () => {
    const { dir, client, fetched } = read(ADDRESS);
    await expect(fetched).rejects.toThrow(ADDRESS_LINE);
    expect(client.keyAccepted).toBeNull();
    expect(readConfig(dir).prereason).toMatchObject({ refused: keyMark(REFUSED), refused_why: 'address' });
    const [ok, text] = keyLine({ key: REFUSED, source: 'file' }, readConfig(dir));
    expect(doctorLine(ok, text)).toBe("x  PreReason key: PreReason refuses it from this machine's address; add this address in PreReason's settings, or run primerkit connect prereason for a new key");
    expect(keyLine({ key: REFUSED, source: 'env' }, readConfig(dir))).toEqual([false, "PreReason key: PREREASON_API_KEY holds a key PreReason refuses from this machine's address: in PreReason's settings it is limited to other addresses. Add this address there, or set a new key"]);
    await prereasonOn(dir, REFUSED, '0.0.0', prereason([]).impl).fetch({ briefing: 'btc.quick-check', format: 'json' });
    expect(readConfig(dir).prereason?.refused).toBeUndefined();
    expect(keyLine({ key: REFUSED, source: 'file' }, readConfig(dir))[0]).toBe(true);
  });

  it('keeps no word when PreReason could not check the key, and the doctor stays ok', async () => {
    const { dir, client, fetched } = read(UNCHECKED);
    await expect(fetched).rejects.toThrow(UNCHECKED_LINE);
    expect(client.keyAccepted).toBeNull();
    expect(readConfig(dir).prereason?.refused).toBeUndefined();
    expect(keyLine({ key: REFUSED, source: 'file' }, readConfig(dir))).toEqual([true, 'PreReason key: found in the bridge credentials file']);
    // A 401 that names no key error is no word on the key either.
    const other = read(JSON.stringify({ error: 'UNAUTHORIZED', message: 'Authentication required.' }));
    await expect(other.fetched).rejects.toThrow('PreReason did not accept the key');
    expect(other.client.keyAccepted).toBeNull();
    expect(readConfig(other.dir).prereason?.refused).toBeUndefined();
  });

  it('connect prereason: a key limited to other addresses is said, the claim runs, and the old key stays until it is approved', async () => {
    const approved = setup(REFUSED);
    const b = bridge('approve', approved.file);
    const t = io(approved.dir, approved.env, prereason([REFUSED], ADDRESS), b);
    expect(await connectPrereason(t)).toBe(0);
    expect(t.out).toEqual([ADDRESS_LINE, 'Connecting again:', ...LINK, 'Connected. The key is in the bridge credentials file.', 'Tier: free, 99 of 100 calls left today.']);
    expect(b.runs).toHaveLength(1);
    expect(savedKey(approved.file)).toBe(FRESH);

    // Not approved: the old key is still in the credentials file.
    const kept = setup(REFUSED);
    const k = io(kept.dir, kept.env, prereason([REFUSED], ADDRESS), bridge('expire', kept.file));
    expect(await connectPrereason(k)).toBe(1);
    expect(k.out.slice(0, 2)).toEqual([ADDRESS_LINE, 'Connecting again:']);
    expect(savedKey(kept.file)).toBe(REFUSED);
  });

  it('connect prereason: a key in PREREASON_API_KEY limited to other addresses is named, exits 1, and starts no claim', async () => {
    const { dir, file, env } = setup(GOOD, REFUSED);
    const b = bridge('approve', file);
    const t = io(dir, env, prereason([REFUSED], ADDRESS), b);
    expect(await connectPrereason(t)).toBe(1);
    expect(t.errors).toEqual(["PREREASON_API_KEY holds a key PreReason refuses from this machine's address: in PreReason's settings it is limited to other addresses. Add this address there, or set a new key."]);
    expect(b.runs).toEqual([]);
  });

  it('connect prereason: a key PreReason could not check stays connected, with why, and no claim', async () => {
    const { dir, file, env } = setup(REFUSED);
    const b = bridge('approve', file);
    const t = io(dir, env, prereason([REFUSED], UNCHECKED), b);
    expect(await connectPrereason(t)).toBe(0);
    expect(t.out).toEqual(['PreReason is already connected, through the bridge credentials file.', `The tier could not be read: ${UNCHECKED_LINE}`]);
    expect(b.runs).toEqual([]);
    expect(savedKey(file)).toBe(REFUSED);
  });
});

describe("the doctor's PreReason key line", () => {
  it('is an x for a key PreReason refused on a read, kept as a mark and never as the key, and ok for any other key', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pk-revoked-doctor-'));
    writeConfig(dir, { prereason: { tier: 'free' } });
    await expect(prereasonOn(dir, REFUSED, '0.0.0', prereason([REFUSED]).impl).fetch({ briefing: 'macro.snapshot', format: 'json' })).rejects.toThrow('PreReason did not accept the key');
    const config = readConfig(dir);
    expect(config.prereason).toMatchObject({ tier: 'free', refused: keyMark(REFUSED) });
    expect(readFileSync(join(dir, 'config.yaml'), 'utf8')).not.toContain(REFUSED);
    const [ok, text] = keyLine({ key: REFUSED, source: 'file' }, config);
    expect(doctorLine(ok, text)).toBe('x  PreReason key: PreReason does not accept it (Invalid or expired API key); primerkit connect prereason makes a new one');
    expect(keyLine({ key: REFUSED, source: 'env' }, config)).toEqual([false, 'PreReason key: PREREASON_API_KEY holds a key PreReason no longer accepts: set a new one, or unset it and run primerkit connect prereason']);
    // CONTROL: another key is not the refused one.
    expect(keyLine({ key: GOOD, source: 'file' }, config)).toEqual([true, 'PreReason key: found in the bridge credentials file, free tier']);
    expect(keyLine(null, config)).toEqual([false, 'PreReason is not connected: primerkit connect prereason']);
    // An answer served to the key clears its refusal.
    await prereasonOn(dir, REFUSED, '0.0.0', prereason([]).impl).fetch({ briefing: 'btc.quick-check', format: 'json' });
    expect(keyLine({ key: REFUSED, source: 'file' }, readConfig(dir))[0]).toBe(true);
  });
});

// The command as a person runs it, on the key in the credentials file, with PreReason faked.
function run(dir: string, args: string[], answer: { status: number; body: string }): Promise<{ code: number; out: string; err: string }> {
  const env = {
    ...process.env,
    PRIMERKIT_HOME: dir,
    PREREASON_API_KEY: '',
    PREREASON_CREDENTIALS_FILE: join(dir, 'credentials.json'),
    FAKE_PREREASON_STATUS: String(answer.status),
    FAKE_PREREASON_BODY: answer.body,
    FAKE_PREREASON_HEADERS: '{}',
    NO_COLOR: '1',
  };
  return new Promise((resolve) => {
    execFile(process.execPath, ['--import', FAKE, BIN, ...args], { env, timeout: 90_000 }, (error, out, err) => resolve({ code: error ? Number((error as NodeJS.ErrnoException).code ?? 1) : 0, out, err }));
  });
}

describe('a revoked key, from the command line', { timeout: 200_000 }, () => {
  it('a read PreReason refuses is kept, and primerkit doctor then says the key is refused', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pk-revoked-cli-'));
    writeFileSync(join(dir, 'credentials.json'), JSON.stringify({ version: 1, api_key: REFUSED }));
    writeConfig(dir, { model: { kind: 'openai-compatible', name: 'x', base_url: 'http://127.0.0.1:9/v1', context_tokens: 32_000 }, watchlist: ['macro.snapshot'] });
    const before = await run(dir, ['doctor'], { status: 200, body: CATALOG });
    expect(before.out).toContain('ok PreReason key: found in the bridge credentials file');
    const read = await run(dir, ['run', 'digest'], { status: 401, body: REVOKED });
    expect(read.code).toBe(1);
    expect(read.err).toContain('PreReason did not accept the key');
    const after = await run(dir, ['doctor'], { status: 200, body: CATALOG });
    expect(after.code).toBe(1);
    expect(after.out).toContain('x  PreReason key: PreReason does not accept it (Invalid or expired API key); primerkit connect prereason makes a new one\n');
    expect(existsSync(join(dir, 'config.yaml')) && readFileSync(join(dir, 'config.yaml'), 'utf8')).not.toContain(REFUSED);
    for (const r of [before, read, after]) expect(r.out + r.err).not.toContain(REFUSED);
  });
});
