import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { BacktestRun, addDays, briefingsOn, loadRoutine, planBacktest, readConfig, writeConfig, type Close, type RoutineSource } from '@primerkit/core';

const BIN = fileURLToPath(new URL('../bin/primerkit.js', import.meta.url));

// A printed board's words as one line: the rail off each line, and wrapped lines joined.
const words = (text: string): string => text.split('\n').map((l) => l.replace(/^\s*[│└|+]\s?/, '')).join(' ').replace(/\s+/g, ' ');
const SAVED = fileURLToPath(new URL('../../../operations/bench-comprehension/briefings-2026-09-25', import.meta.url));

// The command as a person runs it, in a home of its own, with no PreReason key, so any
// read the run did not prepare fails where it would be made.
function run(home: string, args: string[], extra: Record<string, string> = {}): Promise<{ code: number; out: string; err: string }> {
  const env = { ...process.env, PRIMERKIT_HOME: home, PREREASON_API_KEY: '', PREREASON_CREDENTIALS_FILE: join(home, 'no-credentials.json'), ...extra };
  return new Promise((resolve) => {
    execFile(process.execPath, [BIN, ...args], { env, timeout: 180_000 }, (error, out, err) => resolve({ code: error ? Number((error as NodeJS.ErrnoException).code ?? 1) : 0, out, err }));
  });
}

// A model server on this machine that speaks the OpenAI API and gives enter, citing the
// price table's first line and the rule. Asked a price with no data, it gives the one
// `recall` gives, and none by default.
function modelServer(recall: (date: string) => number | null = () => null): Promise<{ url: string; packets: string[]; requests: string[]; close(): Promise<void> }> {
  const packets: string[] = [];
  const requests: string[] = [];
  const server = createServer((req, res) => {
    requests.push(`${req.method} ${req.url}`);
    let body = '';
    req.on('data', (chunk: Buffer) => (body += chunk.toString('utf8')));
    req.on('end', () => {
      if (req.method !== 'POST' || req.url !== '/v1/chat/completions') {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end('{}');
        return;
      }
      const packet = (JSON.parse(body) as { messages: Array<{ content: string }> }).messages[1]?.content ?? '';
      packets.push(packet);
      const asked = /What was Bitcoin's closing price in US dollars on (\d{4}-\d{2}-\d{2})\?/.exec(packet);
      if (asked) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ model: 'x', choices: [{ message: { content: JSON.stringify({ price: recall(asked[1] as string) }) } }] }));
        return;
      }
      const find = (block: string, has: string) => {
        const m = packet
          .split('\n')
          .map((l) => /^\[([a-z.]+) L(\d+)\] (.*)$/.exec(l))
          .find((x) => x?.[1] === block && x[3]?.includes(has));
        return { line: Number(m?.[2]), text: m?.[3] ?? '' };
      };
      const table = find('price', "Bitcoin's daily price");
      const rule = find('rules', 'rise');
      const answer = {
        label: 'enter',
        reason: 'The rule on a rise gave enter.',
        claims: [
          { text: 'The price table covers the days read.', citations: [{ block: 'price', line: table.line, quote: "Bitcoin's daily price in US dollars" }] },
          { text: 'The rule enters on a rise.', citations: [{ block: 'rules', line: rule.line, quote: rule.text }] },
        ],
        not_in_data: [],
      };
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ model: 'x', choices: [{ message: { content: JSON.stringify(answer) } }] }));
    });
  });
  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      resolve({ url: `http://127.0.0.1:${port}/v1`, packets, requests, close: () => new Promise<void>((done) => server.close(() => done())) });
    }),
  );
}

const YAML = 'rules: rules.md\nevery: day\ndata:\n  briefings: [btc.context]\n  format: markdown\nlabels:\n  watch: { hold: true }\n  enter: { target: 0.5 }\nfees: { per_trade: 0.001 }\n';
// Daily closes from Jul 1 to Sep 4, rising $100 a day from $100,000.
const CLOSES: Close[] = Array.from({ length: 66 }, (_, i) => ({ date: addDays('2026-07-01', i), price: 100_000 + 100 * i }));
const SOURCE: RoutineSource = {
  briefing: async () => ({ raw: readFileSync(join(SAVED, 'btc.context.md'), 'utf8') }),
  closes: async (from, to) => CLOSES.filter((c) => c.date >= from && c.date <= to),
};

const OUT = { cutoff: '2024-01', source: 'given for these tests', basis: 'person' as const };

// A run of the three days from Sep 1, started on the model server and stopped before its
// first tick, with every day it reads kept, so it needs nothing from PreReason.
async function startedRun(dir: string, url: string) {
  const routine = loadRoutine(dir);
  const plan = planBacktest(routine, { from: '2026-09-01', to: '2026-09-03' }, { tier: 'enterprise', today: '2026-09-28', format: 'markdown', model: 'x', cutoff: OUT });
  const started = await BacktestRun.start({ routine, plan, model: `local:${url}:x`, source: SOURCE });
  if (!started) throw new Error('no rules');
  for (const tick of plan.ticks) for (const day of [tick, addDays(tick, -150)]) await briefingsOn(routine, day, 'markdown', SOURCE);
  return { routine, plan, started };
}

async function routineHome(): Promise<{ home: string; dir: string }> {
  const home = mkdtempSync(join(tmpdir(), 'pk-cli-backtest-'));
  await run(home, ['routine', 'new', 'btc-rules']);
  const dir = join(home, 'routines', 'btc-rules');
  writeFileSync(join(dir, 'routine.yaml'), YAML);
  writeFileSync(join(dir, 'rules.md'), 'Enter on a rise.\n');
  return { home, dir };
}

describe('primerkit backtest', () => {
  it('says what it needs: a routine, and a window or a run to carry on', async () => {
    const { home } = await routineHome();
    expect((await run(home, ['backtest'])).err).toContain('Name the routine: primerkit backtest btc-rules --from 2026-06-01 --to 2026-08-31');
    // With no window, nothing is asked of the model: not even what it is.
    const server = await modelServer();
    try {
      const noWindow = await run(home, ['backtest', 'btc-rules', '--server', server.url, '--model', 'x']);
      expect(noWindow.code).toBe(1);
      expect(noWindow.err).toContain('Give the window: --from 2026-06-01 --to 2026-08-31, ending yesterday at the latest.');
      expect(server.requests).toEqual([]);
    } finally {
      await server.close();
    }
    expect((await run(home, ['backtest', 'nope'])).err).toContain('There is no routine named nope.');
  }, 300_000);

  it('shows the plan first, and starts nothing it cannot run', async () => {
    const { home } = await routineHome();
    const server = await modelServer();
    try {
      const today = new Date().toISOString().slice(0, 10);
      const out = await run(home, ['backtest', 'btc-rules', '--from', addDays(today, -3), '--to', today, '--server', server.url, '--model', 'x']);
      expect(out.code).toBe(1);
      expect(words(out.out)).toContain(`btc-rules backtest plan ${addDays(today, -3)} to ${today} | every day | x, local`);
      expect(words(out.out)).toContain(`cannot run the window ends on ${today}; a backtest runs on whole past days, so it ends yesterday at the latest`);
      expect(words(out.out)).toContain('It cannot start until each of these is fixed.');
      expect(out.out).not.toContain('training cutoff is not known: give it');
      const past = ['backtest', 'btc-rules', '--from', addDays(today, -10), '--to', addDays(today, -8), '--server', server.url, '--model', 'x'];
      // A model primerkit does not know is no reason to stop: the memory check decides, and
      // the plan names the closes it will ask.
      const unknown = await run(home, past);
      expect(words(unknown.out)).toContain(`sample x's training cutoff is not known, so the memory check decides, on Bitcoin's close on ${addDays(today, -10)}, ${addDays(today, -9)} and ${addDays(today, -8)}`);
      // With no key here, the key's reach is what stops this plan, and it alone: the cutoff no longer does.
      expect(words(unknown.out).match(/cannot run /g)).toHaveLength(1);
      expect(words(unknown.out)).toContain('cannot run a key whose tier is not known yet reads from');
      expect(unknown.out).not.toContain('training cutoff is not known: give it');
      const bad = await run(home, [...past, '--cutoff', '2024-1']);
      expect(bad.code).toBe(1);
      expect(bad.err).toContain('--cutoff is a month, such as 2025-07, as the model card gives it.');
      const given = await run(home, [...past, '--cutoff', '2024-01']);
      expect(given.out).toContain("Kept: x's training reaches 2024-01, in config.yaml, for every backtest after.");
      expect(readConfig(home).cutoffs).toEqual({ x: '2024-01' });
      // Kept, it holds for the next run without the flag.
      const next = await run(home, past);
      expect(words(next.out)).toContain("sample out of sample: x's training reaches 2024-01, before the window");
      expect(next.out).not.toContain('training cutoff is not known');
      expect(server.packets).toEqual([]);
    } finally {
      await server.close();
    }
  }, 300_000);

  it('carries a stopped run on with the model the flags name, to its report', async () => {
    const { home, dir } = await routineHome();
    const server = await modelServer();
    try {
      const { routine, plan, started } = await startedRun(dir, server.url);
      const out = await run(home, ['backtest', 'btc-rules', '--resume', '--server', server.url, '--model', 'x']);
      expect(out.out).toContain(`Carrying on ${started.runId}, 2026-09-01 to 2026-09-03: 0 of 9 ticks done.`);
      expect(out.err).toContain('memory check, 2026-09-01: no price given');
      expect(out.err).toContain('2026-09-01 treatment: enter, filled on 2026-09-02 (1 of 9');
      const report = words(out.out);
      expect(report).toContain("Out of sample: x's training reaches 2024-01, as you gave it, before the window.");
      expect(report).toContain('btc-rules backtest Sep 1 to Sep 3, 2026 | every day | 3 ticks');
      // The chart names each arm at its end, and the table gives their figures.
      expect(report).toMatch(/treatment [+-]?\d+\.\d%/);
      expect(report).toMatch(/buy and hold [+-]?\d+\.\d%/);
      expect(report).toContain('return fell trades in market fees');
      expect(report).toContain('The data changed the label on 0 of 3 ticks.');
      expect(report).toContain('A simulation on past data: not a forecast, and not advice.');
      expect(out.code).toBe(0);
      // Drawn again from its folder, with no model and nothing asked.
      const asked = server.packets.length;
      const replayed = await run(home, ['backtest', 'btc-rules', '--replay']);
      expect(replayed.code).toBe(0);
      expect(words(replayed.out)).toContain('btc-rules backtest Sep 1 to Sep 3, 2026 | every day | 3 ticks');
      expect(words(replayed.out)).toContain('The data changed the label on 0 of 3 ticks.');
      expect(server.packets).toHaveLength(asked);
      // The memory check's three questions, then a packet a tick in each arm.
      expect(server.packets).toHaveLength(12);
      expect(readdirSync(started.dir).sort()).toEqual(['memory.jsonl', 'plan.json', 'prices.json', 'report.json', 'ticks.jsonl']);
      // Nothing is left to carry on.
      const again = await run(home, ['backtest', 'btc-rules', '--resume', '--server', server.url, '--model', 'x']);
      expect(again.err).toContain('btc-rules has no stopped backtest to carry on.');
      // A run started on one model is not carried on by another.
      const other = await BacktestRun.start({ routine, plan, model: `local:${server.url}:x`, source: SOURCE });
      expect(other).not.toBeNull();
      const refused = await run(home, ['backtest', 'btc-rules', '--resume', '--server', server.url, '--model', 'y']);
      expect(refused.code).toBe(1);
      expect(refused.err).toContain(`this run started on local:${server.url}:x, not local:${server.url}:y`);
    } finally {
      await server.close();
    }
  }, 300_000);

  it('stops before the first tick when the model remembers the window, and carries on labelled on your yes', async () => {
    const { home, dir } = await routineHome();
    // A model that gives each close to within 1%, asked with no data.
    const server = await modelServer((date) => (CLOSES.find((c) => c.date === date)?.price ?? 0) * 1.01);
    try {
      const { started } = await startedRun(dir, server.url);
      const out = await run(home, ['backtest', 'btc-rules', '--resume', '--server', server.url, '--model', 'x']);
      expect(out.code).toBe(1);
      expect(out.err).toContain('memory check, 2026-09-01: $107,262 against the close of $106,200, within 5%');
      expect(words(out.out)).toContain("Stopped before the first tick: x gave 3 of 3 Bitcoin closes in the window within 5%, asked with no data, so it remembers the window; it runs only on your yes, and every result then says it is inside the model's training window.");
      expect(words(out.out)).toContain("primerkit backtest btc-rules --resume --inside-training runs it, labelled inside the model's training window.");
      // The memory check's answers, each against its close.
      expect(words(out.out)).toContain('Sep 1 $107,262 $106,200 within 5%');
      expect(server.packets).toHaveLength(3);
      const yes = await run(home, ['backtest', 'btc-rules', '--resume', '--inside-training', '--server', server.url, '--model', 'x']);
      expect(yes.code).toBe(0);
      expect(words(yes.out)).toContain("Inside the model's training window: x gave 3 of 3 closes in it within 5% with no data, and you said yes to running it.");
      // The memory is asked once; the yes is kept with the run.
      expect(server.packets).toHaveLength(12);
      expect(readdirSync(started.dir).sort()).toEqual(['accepted.json', 'memory.jsonl', 'plan.json', 'prices.json', 'report.json', 'ticks.jsonl']);
    } finally {
      await server.close();
    }
  }, 300_000);

  it("counts the memory check's questions in what a hosted model is sent, and sends nothing without --yes", async () => {
    const { home, dir } = await routineHome();
    // The tier as the config keeps it, and the first tick's briefings kept, so the plan
    // and the count need nothing from PreReason.
    writeConfig(home, { ...readConfig(home), prereason: { tier: 'enterprise' } });
    await briefingsOn(loadRoutine(dir), '2026-09-01', 'markdown', SOURCE);
    // A key that is not one: without --yes nothing is sent, so it is never used.
    const out = await run(home, ['backtest', 'btc-rules', '--from', '2026-09-01', '--to', '2026-09-03', '--provider', 'anthropic', '--model', 'claude-haiku-4-5'], { ANTHROPIC_API_KEY: 'not-a-key' });
    expect(out.code).toBe(0);
    expect(words(out.out)).toContain("sample out of sample: claude-haiku-4-5's training reaches 2025-07, before the window");
    expect(words(out.out)).toContain('memory 3 closes asked with no data before the first tick; two within 5% stop the run for your yes');
    expect(words(out.out)).toContain("calls 12: one a tick in each arm, the memory check's 3, and a repair turn for any answer that fails its checks");
    expect(out.out).toMatch(/The run sends 12 packets, the memory check's 3 among them, about \d+k tokens in all/);
    expect(out.out).toContain('to Anthropic on your key, which charges for them. Nothing was sent. Run the same command with --yes to start it.');
    expect(existsSync(join(dir, 'backtests'))).toBe(false);
  }, 300_000);

  it("keeps a forward record: shows it, says what the scheduler would run, and adds nothing without --yes", async () => {
    const { home } = await routineHome();
    const shown = await run(home, ['routine', 'btc-rules', 'track', '--show']);
    expect(shown.code).toBe(0);
    expect(words(shown.out)).toContain('btc-rules forward record not started');
    expect(words(shown.out)).toContain('No run yet. primerkit routine btc-rules track runs it once now');
    const server = await modelServer();
    try {
      const model = ['--server', server.url, '--model', 'x'];
      expect((await run(home, ['routine', 'btc-rules', 'track', '--at', '25:00', ...model])).err).toContain('--at is a time of day, such as 07:30.');
      const at = await run(home, ['routine', 'btc-rules', 'track', '--at', '7:30', ...model]);
      expect(at.code).toBe(0);
      expect(at.out).toContain('The entry primerkit adds to');
      // launchd gives each word of the command its own string; Task Scheduler and cron write the
      // command line as one. CONTROL: each platform's entry is never the other form.
      const entry = { launchd: '<string>routine</string><string>btc-rules</string><string>track</string>', line: 'routine btc-rules track' };
      const [own, other] = process.platform === 'darwin' ? [entry.launchd, entry.line] : [entry.line, entry.launchd];
      expect(at.out).toContain(own);
      expect(at.out).not.toContain(other);
      expect(at.out).toContain('Nothing was added. Run the same command with --yes to add it.');
      // With no PreReason key there is nothing to run on, and the model is asked nothing.
      const now = await run(home, ['routine', 'btc-rules', 'track', ...model]);
      expect(now.code).toBe(1);
      expect(now.err).toContain('PreReason is not connected.');
      expect(server.packets).toEqual([]);
    } finally {
      await server.close();
    }
  }, 300_000);
});
