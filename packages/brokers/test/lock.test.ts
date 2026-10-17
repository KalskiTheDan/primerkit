// The lock where a dead run's lock is on disk: another run's steps put between this run's
// own, file calls made to fail, and real processes racing for it. node:fs is wrapped for
// this file only; the child processes of the race use the real one.
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';

// onLook: what happens right after each look at a file's age, one entry a look, in order
// (another run's steps go here). failOpen and failRemove: the paths for which making or
// removing a file fails, as it does without access.
const fs = vi.hoisted(() => ({ onLook: [] as Array<() => void>, looks: 0, failOpen: null as null | ((path: string) => boolean), failRemove: null as null | ((path: string) => boolean) }));
vi.mock('node:fs', async (original) => {
  const real = await original<typeof import('node:fs')>();
  const noAccess = (what: string, path: string) => Object.assign(new Error(`EACCES: made up for the test, ${what} '${path}'`), { code: 'EACCES' });
  const statSync = ((...args: Parameters<typeof real.statSync>) => {
    const answer = real.statSync(...args);
    fs.looks += 1;
    fs.onLook.shift()?.();
    return answer;
  }) as typeof real.statSync;
  const openSync = ((...args: Parameters<typeof real.openSync>) => {
    if (fs.failOpen?.(String(args[0]))) throw noAccess('open', String(args[0]));
    return real.openSync(...args);
  }) as typeof real.openSync;
  const rmSync = ((...args: Parameters<typeof real.rmSync>) => {
    if (fs.failRemove?.(String(args[0]))) throw noAccess('rm', String(args[0]));
    return real.rmSync(...args);
  }) as typeof real.rmSync;
  return { ...real, default: { ...real, statSync, openSync, rmSync }, statSync, openSync, rmSync };
});

import { BrokerLog, LOCK_STALE_MS } from '../src/guard';

const newLog = () => new BrokerLog(join(mkdtempSync(join(tmpdir(), 'pk-lock-')), 'alpaca.jsonl'));
const dated = (path: string, msFromNow: number, text = 'a dead run\n') => {
  writeFileSync(path, text);
  const at = new Date(Date.now() + msFromNow);
  utimesSync(path, at, at);
};
const DEAD = -LOCK_STALE_MS - 60_000;
const beside = (log: BrokerLog) => readdirSync(dirname(log.path)).sort();

describe("taking over a dead run's lock", () => {
  it('CONTROL: the steps put in between are in the path the lock takes', () => {
    const log = newLog();
    const first = log.lock();
    const before = fs.looks;
    let stepped = 0;
    fs.onLook = [() => (stepped += 1)];
    expect(log.lock()).toBeNull();
    expect(fs.looks).toBe(before + 1);
    expect(stepped).toBe(1);
    first!();
  });

  it('gives it to one run where a second had already seen the dead lock: the second looks again, and leaves the lock the first made', () => {
    const log = newLog();
    dated(log.lockPath, DEAD);
    let a = null as (() => void) | null;
    // Run B has read the dead lock's age. Before B does anything more, run A does its whole
    // takeover: takes the dead lock away and makes its own.
    fs.onLook = [() => (a = new BrokerLog(log.path).lock())];
    const b = new BrokerLog(log.path).lock();
    expect(a).not.toBeNull();
    expect(b).toBeNull();
    expect(readFileSync(log.lockPath, 'utf8')).toMatch(new RegExp(`^${process.pid} [0-9a-f-]{36} `));
    expect(beside(log)).toEqual(['alpaca.jsonl.lock']);
    a!();
    expect(beside(log)).toEqual([]);
  });

  it('refuses a second run while the first is taking the dead lock away, and the first then holds it', () => {
    const log = newLog();
    dated(log.lockPath, DEAD);
    let a = undefined as (() => void) | null | undefined;
    // B has seen the dead lock and made the takeover file; A comes as B looks again.
    fs.onLook = [() => undefined, () => (a = new BrokerLog(log.path).lock())];
    const b = new BrokerLog(log.path).lock();
    expect(a).toBeNull();
    expect(b).not.toBeNull();
    expect(beside(log)).toEqual(['alpaca.jsonl.lock']);
    b!();
    expect(beside(log)).toEqual([]);
  });

  it('with nothing in between: the first run takes it over and the second is refused', () => {
    const log = newLog();
    dated(log.lockPath, DEAD);
    const a = new BrokerLog(log.path).lock();
    expect(a).not.toBeNull();
    expect(new BrokerLog(log.path).lock()).toBeNull();
    a!();
  });

  it('leaves a takeover file another run holds, and removes one a run left by dying in that instant, so nothing blocks for good', () => {
    const log = newLog();
    dated(log.lockPath, DEAD);
    writeFileSync(log.takeoverPath, 'another run, this instant\n');
    expect(log.lock()).toBeNull();
    expect(beside(log)).toEqual(['alpaca.jsonl.lock', 'alpaca.jsonl.lock.takeover']);
    // As old as a dead lock, the takeover file is a dead run's too: this run removes it and
    // is refused, and the next run takes the lock over.
    dated(log.takeoverPath, DEAD);
    expect(log.lock()).toBeNull();
    expect(beside(log)).toEqual(['alpaca.jsonl.lock']);
    const next = log.lock();
    expect(next).not.toBeNull();
    next!();
    expect(beside(log)).toEqual([]);
  });

  it('removes a folder of the lock name with what it holds once it is as old as a dead lock, and refuses while it is fresh', () => {
    const log = newLog();
    mkdirSync(log.lockPath);
    writeFileSync(join(log.lockPath, 'kept'), 'x');
    expect(log.lock()).toBeNull();
    const old = new Date(Date.now() + DEAD);
    utimesSync(log.lockPath, old, old);
    const taken = log.lock();
    expect(taken).not.toBeNull();
    expect(readFileSync(log.lockPath, 'utf8')).toMatch(/^\d+ [0-9a-f-]{36} /);
    taken!();
  });

  it('refuses, and never throws, where a file cannot be made or removed', () => {
    try {
      // The lock itself cannot be made.
      const log = newLog();
      fs.failOpen = (path) => path === log.lockPath;
      expect(log.lock()).toBeNull();
      expect(existsSync(log.lockPath)).toBe(false);
      // A dead lock is there, and the takeover file cannot be made.
      fs.failOpen = (path) => path === log.takeoverPath;
      dated(log.lockPath, DEAD);
      expect(log.lock()).toBeNull();
      expect(readFileSync(log.lockPath, 'utf8')).toBe('a dead run\n');
      // The dead lock cannot be removed: it stays, and the takeover file does not.
      fs.failOpen = null;
      fs.failRemove = (path) => path === log.lockPath;
      expect(log.lock()).toBeNull();
      expect(beside(log)).toEqual(['alpaca.jsonl.lock']);
      // A dead run's takeover file cannot be removed.
      dated(log.takeoverPath, DEAD);
      fs.failRemove = (path) => path === log.takeoverPath;
      expect(log.lock()).toBeNull();
      // CONTROL: with the calls working again the same log gives the lock.
      fs.failRemove = null;
      expect(log.lock()).toBeNull(); // this run removes the dead takeover file
      const taken = log.lock();
      expect(taken).not.toBeNull();
      taken!();
    } finally {
      fs.failOpen = null;
      fs.failRemove = null;
    }
  });
});

// Real processes, started together and asking within the same millisecond, round after
// round. Each run that gets the lock makes a marker file of its own while it holds it and
// looks for the others', so two runs holding the lock at once are seen by the file system
// itself, not by comparing clocks.
const ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const CHILD = fileURLToPath(new URL('./lock-race-child.ts', import.meta.url));
const PROCESSES = 6;

async function race(rounds: number, dead: boolean, how: 'now' | 'as-it-was'): Promise<{ wins: number[]; both: number }> {
  const path = join(mkdtempSync(join(tmpdir(), 'pk-lock-race-')), 'alpaca.jsonl');
  const children = Array.from({ length: PROCESSES }, (_, i) => spawn(process.execPath, ['--import', 'tsx', CHILD, path, String(i), String(rounds), dead ? '1' : '0', how], { cwd: ROOT, stdio: ['pipe', 'pipe', 'inherit'], windowsHide: true }));
  const lines = children.map((child) => {
    let out = '';
    child.stdout.on('data', (d: Buffer) => (out += d.toString()));
    return {
      ready: new Promise<void>((resolve) => child.stdout.on('data', () => out.includes('ready\n') && resolve())),
      done: new Promise<string>((resolve) => child.on('close', () => resolve(out.replace('ready\n', '').trim()))),
    };
  });
  await Promise.all(lines.map((l) => l.ready));
  const start = Date.now() + 300;
  for (const child of children) child.stdin.end(`${start}\n`);
  const results = (await Promise.all(lines.map((l) => l.done))).map((line) => JSON.parse(line) as { got: string; both: number });
  return {
    wins: Array.from({ length: rounds }, (_, r) => results.reduce((n, result) => n + (result.got[r] === '1' ? 1 : 0), 0)),
    both: results.reduce((n, result) => n + result.both, 0),
  };
}

describe('real processes racing for the lock', () => {
  it("never gives it to two at once, with a dead run's lock on disk every round or with none", async () => {
    const rounds = 40;
    for (const dead of [true, false]) {
      const { wins, both } = await race(rounds, dead, 'now');
      expect(both).toBe(0);
      // The race was one: in most rounds a run got the lock and the others were refused.
      expect(wins.filter((w) => w >= 1).length).toBeGreaterThan(rounds / 2);
      expect(wins.filter((w) => w < PROCESSES).length).toBeGreaterThan(rounds / 2);
    }
  }, 120_000);

  // The child holds the old takeover's two steps apart by a time of its own for each
  // process, so this does not hang on how a machine happens to run them: every process
  // after the first moves away the lock of a run that still holds it, in every round.
  it('CONTROL: the same race sees two at once with the takeover as it was, a look and then a move', async () => {
    const rounds = 10;
    const { both } = await race(rounds, true, 'as-it-was');
    expect(both).toBeGreaterThanOrEqual(rounds);
  }, 120_000);
});
