// A child for lock.test.ts: one of several real processes that all ask for the lock at the
// same instants, round after round. A run that gets the lock makes a marker file of its
// own for as long as it holds it, and then looks for the markers of the others: any it
// finds is a run holding the lock at the same time, and it counts the round. The file
// system itself shows two holders, with no clocks compared.
// It prints one line: {"got": "0101...", "both": <count>}.
//   argv: <log path> <index> <rounds> <dead: 1 = a dead run's lock is on disk each round> <how: now | as-it-was>
//   stdin: one line, the instant the first round starts, in ms since 1970
// It reads no keychain, opens no connection and writes only beside the log path it is given.
import { closeSync, openSync, readdirSync, readFileSync, renameSync, rmSync, statSync, utimesSync, writeFileSync, writeSync } from 'node:fs';
import { basename, dirname } from 'node:path';
import { BrokerLog, LOCK_AHEAD_MS, LOCK_STALE_MS } from '../src/guard';

const [path, index, rounds, dead, how] = [process.argv[2]!, Number(process.argv[3]), Number(process.argv[4]), process.argv[5] === '1', process.argv[6]];
const log = new BrokerLog(path);
const marker = `${path}.held-${index}`;
// A round, and how long a run that got the lock holds it (an order on its way). The
// control's rounds are longer, so that each of its processes moves while the others hold.
const [STEP, HOLD] = how === 'as-it-was' ? [400, 220] : [120, 40];

// CONTROL only: the takeover as it was before it took one run at a time (look at the
// lock's age, then move the lock aside). Its two steps are held apart, 20 ms for the first
// process and 30 ms more for each next one, so every process has looked before the first
// moves, and each next one then moves the lock of a run that still holds it.
const pause = (ms: number) => void Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
function lockAsItWas(): (() => void) | null {
  const token = `${process.pid} ${index} ${Date.now()}\n`;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const fd = openSync(log.lockPath, 'wx');
      writeSync(fd, token);
      closeSync(fd);
      return () => {
        try {
          if (readFileSync(log.lockPath, 'utf8') === token) rmSync(log.lockPath, { force: true });
        } catch {
          // gone, or another run's
        }
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') return null;
      let age = 0;
      try {
        age = Date.now() - statSync(log.lockPath).mtimeMs;
      } catch {
        continue;
      }
      if (age > -LOCK_AHEAD_MS && age < LOCK_STALE_MS) return null;
      pause(20 + index * 30);
      const aside = `${log.lockPath}.stale-${process.pid}-${attempt}`;
      try {
        renameSync(log.lockPath, aside);
        rmSync(aside, { force: true });
      } catch {
        return null;
      }
    }
  }
  return null;
}

const spinUntil = (t: number) => {
  while (Date.now() < t) {
    // a busy wait, so every process asks within the same millisecond
  }
};
const sleepUntil = (t: number) => new Promise<void>((r) => setTimeout(r, Math.max(0, t - Date.now())));

process.stdout.write('ready\n');
const start = Number(await new Promise<string>((r) => process.stdin.once('data', (d: Buffer) => r(d.toString()))));
const got: number[] = [];
let both = 0;
for (let round = 0; round < rounds; round += 1) {
  const at = start + round * STEP;
  if (dead && index === 0) {
    await sleepUntil(at - 50);
    try {
      // Only where no lock is on disk: a lock a slow run still holds is left as it is.
      writeFileSync(log.lockPath, 'a dead run\n', { flag: 'wx' });
      const old = new Date(Date.now() - LOCK_STALE_MS - 60_000);
      utimesSync(log.lockPath, old, old);
    } catch {
      // a lock is there
    }
  }
  await sleepUntil(at - 15);
  spinUntil(at);
  const release = how === 'as-it-was' ? lockAsItWas() : log.lock();
  got.push(release ? 1 : 0);
  if (!release) continue;
  writeFileSync(marker, '');
  const others = readdirSync(dirname(path)).filter((f) => f.startsWith(`${basename(path)}.held-`) && f !== basename(marker));
  if (others.length) both += 1;
  await sleepUntil(at + HOLD);
  rmSync(marker, { force: true });
  release();
}
process.stdout.write(`${JSON.stringify({ got: got.join(''), both })}\n`);
process.exit(0);
