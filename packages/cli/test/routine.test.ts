import { execFile } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const BIN = fileURLToPath(new URL('../bin/primerkit.js', import.meta.url));
const SAVED = fileURLToPath(new URL('../../../operations/bench-comprehension/briefings-2026-09-25', import.meta.url));

// The command as a person runs it, in a home of its own, with no PreReason key, so a day
// the routine has not frozen fails where it would be read.
function run(home: string, args: string[]): Promise<{ code: number; out: string; err: string }> {
  const env = { ...process.env, PRIMERKIT_HOME: home, PREREASON_API_KEY: '', PREREASON_CREDENTIALS_FILE: join(home, 'no-credentials.json') };
  return new Promise((resolve) => {
    execFile(process.execPath, [BIN, ...args], { env, timeout: 90_000 }, (error, out, err) => resolve({ code: error ? Number((error as NodeJS.ErrnoException).code ?? 1) : 0, out, err }));
  });
}

// A model server that speaks the OpenAI API on this machine, and gives enter, citing the
// week's change and the rule as its packet has them.
function modelServer(): Promise<{ url: string; packets: string[]; close(): Promise<void> }> {
  const packets: string[] = [];
  const server = createServer((req, res) => {
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
      const find = (block: string, has: string) => {
        const m = packet
          .split('\n')
          .map((l) => /^\[([a-z.]+) L(\d+)\] (.*)$/.exec(l))
          .find((x) => x?.[1] === block && x[3]?.includes(has));
        return { line: Number(m?.[2]), text: m?.[3] ?? '' };
      };
      const week = find('price', 'change over 7 days');
      const rule = find('rules', 'rise');
      const quote = week.text.split(',')[0] ?? '';
      const answer = {
        label: 'enter',
        reason: 'The rule on a rise gave enter.',
        claims: [
          { text: `Bitcoin's ${quote}.`, citations: [{ block: 'price', line: week.line, quote }] },
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
      resolve({ url: `http://127.0.0.1:${port}/v1`, packets, close: () => new Promise<void>((done) => server.close(() => done())) });
    }),
  );
}

// Each test starts the command, node and tsx, once or more: on a busy machine that takes
// longer than vitest's default 5 seconds a test.
describe('primerkit routine', { timeout: 200_000 }, () => {
  it('schedules the forward record on the model the flags name, and tells the run where its home is', async () => {
    const home = mkdtempSync(join(tmpdir(), 'pk-cli-track-'));
    expect((await run(home, ['routine', 'new', 'wf'])).code).toBe(0);
    // Nothing listens there: the entry is only shown, never added, without --yes.
    const shown = await run(home, ['routine', 'wf', 'track', '--at', '07:30', '--server', 'http://127.0.0.1:9/v1', '--model', 'test-model']);
    expect(shown.code).toBe(0);
    expect(shown.out).toContain('Nothing was added.');
    // Each scheduler writes the arguments its own way: Task Scheduler leaves the address bare,
    // launchd gives each its own string, and cron quotes it for the shell.
    const flags = {
      win32: /--server http:\/\/127\.0\.0\.1:9\/v1 --model test-model/,
      darwin: /<string>--server<\/string><string>http:\/\/127\.0\.0\.1:9\/v1<\/string><string>--model<\/string><string>test-model<\/string>/,
      linux: /--server 'http:\/\/127\.0\.0\.1:9\/v1' --model test-model/,
    };
    expect(shown.out).toMatch(process.platform === 'win32' || process.platform === 'darwin' ? flags[process.platform] : flags.linux);
    expect(shown.out).toContain('--home');
  });

  it('shows a forward record with no run yet with no time of its own', async () => {
    const home = mkdtempSync(join(tmpdir(), 'pk-cli-track-'));
    expect((await run(home, ['routine', 'new', 'wf'])).code).toBe(0);
    const shown = await run(home, ['routine', 'wf', 'track', '--show']);
    expect(shown.code).toBe(0);
    expect(shown.out).toContain('No run yet.');
    expect(shown.out).not.toContain('generated');
  });

  it('makes a routine, shows it, and tests nothing until rules are written', async () => {
    const home = mkdtempSync(join(tmpdir(), 'pk-cli-routine-'));
    expect((await run(home, ['routine'])).out).toContain('No routines yet. primerkit routine new <name> makes one');
    const made = await run(home, ['routine', 'new', 'btc-rules']);
    expect(made.code).toBe(0);
    expect(made.out).toContain('Made the routine btc-rules in');
    const dir = join(home, 'routines', 'btc-rules');
    for (const file of ['routine.yaml', 'rules.md', 'tests.yaml', 'hypothesis.md']) expect(existsSync(join(dir, file))).toBe(true);
    expect(made.out).toContain('  hypothesis.md  your hypothesis card, in your own words; primerkit ships none');
    // The card, the ladder and the registry, each closing on the line every one of them has.
    const closing = "The model never proposes a strategy: it labels your runs, and primerkit's code checks your card's form. Every result here is from a simulated account: not a forecast, not advice.";
    const card = await run(home, ['routine', 'btc-rules', 'hypothesis']);
    expect(card.code).toBe(0);
    expect(card.out).toContain('Hypothesis  btc-rules, nothing written yet');
    expect(card.out).toContain('Form check: claim missing: write what you expect to happen | mechanism missing');
    expect(card.out).toContain(closing);
    const research = await run(home, ['routine', 'btc-rules', 'research']);
    expect(research.code).toBe(1);
    expect(research.err).toContain('btc-rules has no finished backtest yet. primerkit backtest btc-rules --from <date> --to <date> runs one.');
    const registry = await run(home, ['routine', 'registry']);
    expect(registry.code).toBe(0);
    expect(registry.out).toContain('Registry  no hypotheses tested yet');
    expect(registry.out).toContain(closing);
    const shown = await run(home, ['routine', 'btc-rules']);
    expect(shown.code).toBe(0);
    expect(shown.out).toContain('btc-rules  your routine | every day | BTC/USD, long or flat');
    expect(shown.out).toMatch(/PR btc\.context +briefing, as it stood at the run/);
    expect(shown.out).toContain('holds no rules yet, so the routine returns no_rules_defined');
    expect(shown.out).toContain('labels  watch keeps what is held; enter has no target yet; exit goes flat, all cash');
    const test = await run(home, ['routine', 'btc-rules', 'test']);
    expect(test.code).toBe(1);
    expect(test.err).toContain('holds no rules yet, so btc-rules returns no_rules_defined and there is nothing to test.');
    const again = await run(home, ['routine', 'new', 'btc-rules']);
    expect(again.code).toBe(1);
    expect(again.err).toContain('is already in');
    expect((await run(home, ['routine'])).out).toContain('Your routines:\n  btc-rules');
  }, 300_000);

  it('names each problem in the file it is in', async () => {
    const home = mkdtempSync(join(tmpdir(), 'pk-cli-routine-'));
    await run(home, ['routine', 'new', 'btc-rules']);
    const dir = join(home, 'routines', 'btc-rules');
    writeFileSync(join(dir, 'rules.md'), 'Enter on a rise.\n');
    writeFileSync(join(dir, 'tests.yaml'), 'runs: 50\ntests:\n  - on: 2026-09-25\n    expect: buy\n');
    const out = await run(home, ['routine', 'btc-rules', 'test']);
    expect(out.code).toBe(1);
    expect(out.err).toContain('tests.yaml needs a fix:\n  runs is how many times each test runs, from 1 to 20, not 50');
    expect(out.err).toContain(`  test 1: "buy" is not one of the routine's labels, watch, enter or exit`);
  }, 200_000);

  it('runs the logic tests on a frozen day, on the model the flags or routine.yaml name, and keeps the report', async () => {
    const home = mkdtempSync(join(tmpdir(), 'pk-cli-routine-'));
    await run(home, ['routine', 'new', 'btc-rules']);
    const dir = join(home, 'routines', 'btc-rules');
    writeFileSync(join(dir, 'routine.yaml'), 'rules: rules.md\ndata:\n  briefings: [btc.context]\n  price_days: 30\n  format: markdown\nlabels:\n  watch: { hold: true }\n  enter: { target: 0.5 }\n');
    writeFileSync(join(dir, 'rules.md'), 'Enter on a rise.\n');
    writeFileSync(join(dir, 'tests.yaml'), 'runs: 1\ntests:\n  - on: 2026-09-25\n    expect: enter\n');
    const day = join(dir, 'fixtures', '2026-09-25');
    mkdirSync(day, { recursive: true });
    copyFileSync(join(SAVED, 'btc.context.md'), join(day, 'btc.context.md'));
    const closes = Array.from({ length: 31 }, (_, i) => ({ date: new Date(Date.parse('2026-08-26T00:00:00Z') + i * 86_400_000).toISOString().slice(0, 10), price: 100_000 + 1_000 * i }));
    writeFileSync(join(day, 'price-30d.json'), JSON.stringify({ through: '2026-09-25', days: 30, source: 'prereason', closes }));
    const server = await modelServer();
    try {
      const out = await run(home, ['routine', 'btc-rules', 'test', '--server', server.url, '--model', 'x']);
      expect(out.err).toContain('test 1 of 1 (2026-09-25), run 1 of 1: enter, passed');
      expect(out.out).toContain('Logic tests  btc-rules on x, local');
      expect(out.out).toContain('  2026-09-25  flat, expects enter: 1 of 1');
      expect(out.out).toContain('1 rule test on frozen data, 1 run each: 1 of 1 passed.');
      expect(out.code).toBe(0);
      expect(server.packets).toHaveLength(1);
      expect(server.packets[0]).toContain('[rules L1] Enter on a rise.');
      expect(server.packets[0]).toContain('[price L32] 2026-09-25 $130,000.00');
      expect(server.packets[0]).toContain('[position L1] flat: no BTC/USD held, all cash, on 2026-09-25');
      expect(readdirSync(join(dir, 'results')).filter((f) => f.startsWith('tests-'))).toHaveLength(1);
      // CONTROL: with nothing answering, the same run fails and says the server is not answering.
      const down = await run(home, ['routine', 'btc-rules', 'test', '--server', 'http://127.0.0.1:9/v1', '--model', 'x']);
      expect(down.code).toBe(1);
      expect(down.err).toContain('The model server is not answering at http://127.0.0.1:9');

      // A model named in routine.yaml runs the tests when no flags name one, and flags win over it.
      const yaml = (url: string) => `rules: rules.md\nmodel: { kind: openai-compatible, name: x, base_url: "${url}" }\ndata:\n  briefings: [btc.context]\n  price_days: 30\n  format: markdown\nlabels:\n  watch: { hold: true }\n  enter: { target: 0.5 }\n`;
      writeFileSync(join(dir, 'routine.yaml'), yaml(server.url));
      const own = await run(home, ['routine', 'btc-rules', 'test']);
      expect(own.code).toBe(0);
      expect(server.packets).toHaveLength(2);
      writeFileSync(join(dir, 'routine.yaml'), yaml('http://127.0.0.1:9/v1'));
      const flagged = await run(home, ['routine', 'btc-rules', 'test', '--server', server.url, '--model', 'x']);
      expect(flagged.code).toBe(0);
      expect(server.packets).toHaveLength(3);
      const dead = await run(home, ['routine', 'btc-rules', 'test']);
      expect(dead.code).toBe(1);
      expect(dead.err).toContain('The model server is not answering at http://127.0.0.1:9');
    } finally {
      await server.close();
    }
  }, 300_000);
});
