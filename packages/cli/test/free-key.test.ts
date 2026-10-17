import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { readConfig, writeConfig, type Config } from '@primerkit/core';

const BIN = fileURLToPath(new URL('../bin/primerkit.js', import.meta.url));
// PreReason as a fake inside the command's own process: nothing reaches PreReason.
const FAKE = pathToFileURL(fileURLToPath(new URL('./fake-prereason.mjs', import.meta.url))).href;

// Keys are built here, never written out, and are not real keys.
const fakeKey = () => `pr_test_${'f'.repeat(20)}`;

// A home with a model on this machine that is never asked (its context is given, so it is
// not even looked up), and the config given.
function home(config: Partial<Config> = {}): string {
  const dir = mkdtempSync(join(tmpdir(), 'pk-cli-free-'));
  writeConfig(dir, { model: { kind: 'openai-compatible', name: 'x', base_url: 'http://127.0.0.1:9/v1', context_tokens: 32_000 }, ...config });
  return dir;
}

// The command as a person runs it, on a key, with PreReason's answers faked: each call it
// makes is written to the log.
function run(dir: string, args: string[], answer: { status?: number; body?: string; headers?: Record<string, string> } = {}): Promise<{ code: number; out: string; err: string; calls: string[] }> {
  const log = join(dir, 'prereason-calls.log');
  const env = {
    ...process.env,
    PRIMERKIT_HOME: dir,
    PREREASON_API_KEY: fakeKey(),
    PREREASON_CREDENTIALS_FILE: join(dir, 'no-credentials.json'),
    FAKE_PREREASON_LOG: log,
    FAKE_PREREASON_STATUS: String(answer.status ?? 429),
    FAKE_PREREASON_BODY: answer.body ?? '{}',
    FAKE_PREREASON_HEADERS: JSON.stringify(answer.headers ?? {}),
  };
  return new Promise((resolve) => {
    execFile(process.execPath, ['--import', FAKE, BIN, ...args], { env, timeout: 90_000 }, (error, out, err) =>
      resolve({ code: error ? Number((error as NodeJS.ErrnoException).code ?? 1) : 0, out, err, calls: existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(Boolean) : [] }),
    );
  });
}

// Each test starts the command, node and tsx, once or more: on a busy machine that takes
// longer than vitest's default 5 seconds a test.
describe('a rate limit, from the command line', { timeout: 200_000 }, () => {
  it('the digest says how long to wait', async () => {
    const dir = home({ watchlist: ['macro.snapshot'] });
    const r = await run(dir, ['run', 'digest'], { body: JSON.stringify({ code: 'RATE_LIMIT_EXCEEDED', message: 'Daily limit reached' }), headers: { 'retry-after': '120' } });
    expect(r.code).toBe(1);
    expect(r.err).toContain("The digest did not run: none of the watchlist could be read (macro.snapshot could not be read: PreReason's daily rate limit for this account is reached. Try again in about 2 minutes).");
    expect(r.calls).toEqual(['/api/context']);
  });

  it('the forward record says how long to wait, where PreReason sends no wait', async () => {
    const dir = home();
    expect((await run(dir, ['routine', 'new', 'wf'])).code).toBe(0);
    const r = await run(dir, ['routine', 'wf', 'track'], { body: JSON.stringify({ code: 'RATE_LIMIT_EXCEEDED', message: 'Too many requests per minute' }) });
    expect(r.code).toBe(1);
    expect(r.err).toContain("PreReason's per-minute rate limit for this account is reached. Try again in a few minutes.\n");
    expect(r.calls).toEqual(['/api/metrics/bitcoin-price/history']);
  });
});

describe('a routine on a free key, from the command line', { timeout: 200_000 }, () => {
  it('routine new writes the days a free key reads', async () => {
    const dir = home({ prereason: { tier: 'free' } });
    expect((await run(dir, ['routine', 'new', 'wf'])).code).toBe(0);
    expect(readFileSync(join(dir, 'routines', 'wf', 'routine.yaml'), 'utf8')).toContain('  price_days: 28\n');
    // CONTROL: a basic key keeps the 200.
    const basic = home({ prereason: { tier: 'basic' } });
    expect((await run(basic, ['routine', 'new', 'wf'])).code).toBe(0);
    expect(readFileSync(join(basic, 'routines', 'wf', 'routine.yaml'), 'utf8')).toContain('  price_days: 200\n');
  });

  it('a run of 200 days on a free key stops before any call, with the number to write', async () => {
    const dir = home();
    expect((await run(dir, ['routine', 'new', 'wf'])).code).toBe(0);
    writeConfig(dir, { ...readConfig(dir), prereason: { tier: 'free' } });
    const r = await run(dir, ['routine', 'wf', 'track']);
    expect(r.code).toBe(1);
    expect(r.err).toContain("routine.yaml needs a fix:\n  price_days 200 reaches past what a Free key reads (the last 30 days, and a run counts back from yesterday's close). Write 28 in routine.yaml, or use a Basic key.\n");
    expect(r.calls).toEqual([]);
  });
});
