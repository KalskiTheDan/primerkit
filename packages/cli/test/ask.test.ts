import { execFile } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { writeConfig } from '@primerkit/core';

const BIN = fileURLToPath(new URL('../bin/primerkit.js', import.meta.url));

// The command as a person runs it, in a home whose model is a server nothing answers at,
// so a model asked at all shows as a failure.
function run(args: string[]): Promise<{ code: number; out: string; err: string }> {
  const home = mkdtempSync(join(tmpdir(), 'pk-cli-ask-'));
  writeConfig(home, { model: { kind: 'ollama', base_url: 'http://127.0.0.1:9', name: 'qwen2.5:7b' } });
  return new Promise((resolve) => {
    execFile(process.execPath, [BIN, ...args], { env: { ...process.env, PRIMERKIT_HOME: home }, timeout: 90_000 }, (error, out, err) =>
      resolve({ code: error ? Number((error as NodeJS.ErrnoException).code ?? 1) : 0, out, err }),
    );
  });
}

// Each test starts the command, node and tsx, once or more: on a busy machine that takes
// longer than vitest's default 5 seconds a test.
describe('the flags, as given', { timeout: 200_000 }, () => {
  it('never take the next flag as a value, and say a model flag that names no model', async () => {
    // --demo stays the demo, and --briefing is said to have no value.
    const swallowed = await run(['ask', '--briefing', '--demo', 'Where does Bitcoin stand?']);
    expect(swallowed.code).toBe(1);
    expect(swallowed.err).toContain('--briefing takes a value after it.');
    const none = await run(['routine', 'wf', 'track', '--at']);
    expect(none.code).toBe(1);
    expect(none.err).toContain('--at takes a value after it.');
    // --model with no --provider or --server named no model, and model set wrote the old one as "Set."
    const alone = await run(['model', 'set', '--model', 'gpt-5']);
    expect(alone.code).toBe(1);
    expect(alone.err).toContain('The model flags go together: --ollama <model>, --server <url> --model <id>, or --provider <id> --model <id>.');
    expect(alone.out).not.toContain('Set.');
  });
});

describe('primerkit ask with no model', { timeout: 200_000 }, () => {
  it('names the ways to an answer that need no model of your own: an AI app you use, and the demo', async () => {
    const home = mkdtempSync(join(tmpdir(), 'pk-cli-ask-'));
    const { code, err } = await new Promise<{ code: number; err: string }>((resolve) =>
      execFile(process.execPath, [BIN, 'ask', 'Where does Bitcoin stand?'], { env: { ...process.env, PRIMERKIT_HOME: home, PREREASON_API_KEY: '' }, timeout: 90_000 }, (error, _out, err) =>
        resolve({ code: error ? Number((error as NodeJS.ErrnoException).code ?? 1) : 0, err }),
      ),
    );
    expect(code).toBe(1);
    expect(err).toContain('No model is set. Choose one with primerkit model set, or in the session.');
    expect(err).toContain('primerkit install --host <app> (claude-code, codex, gemini, lm-studio)');
    expect(err).toContain('primerkit ask --demo "<question>" answers from saved briefings with no model.');
  });
});

describe('primerkit ask --demo', { timeout: 200_000 }, () => {
  it('names its own refusal of a company briefing, and never says PreReason could not be reached', async () => {
    const home = mkdtempSync(join(tmpdir(), 'pk-cli-ask-'));
    const { code, err } = await new Promise<{ code: number; err: string }>((resolve) =>
      execFile(process.execPath, [BIN, 'ask', '--demo', '--briefing', 'equities.company', 'What did Apple report?'], { env: { ...process.env, PRIMERKIT_HOME: home }, timeout: 90_000 }, (error, _out, err) =>
        resolve({ code: error ? Number((error as NodeJS.ErrnoException).code ?? 1) : 0, err }),
      ),
    );
    expect(code).toBe(1);
    expect(err).toContain('equities.company names no company: name it in the id, such as equities.company/nvda, equities.company/7203 or equities.company/005930.');
    expect(err).not.toMatch(/could not be reached|not released/);
  });

  it('counts the demo briefings one way: the catalog and the note for a question nothing matches', async () => {
    const listed = await run(['catalog', '--demo']);
    expect(listed.code).toBe(0);
    expect(listed.out).toContain('Briefings saved for the demo (3)');
    expect(listed.out).toContain('Name one in a question, such as macro.snapshot.');
    expect(listed.out).not.toContain('treasury-10y');
    expect(listed.out).not.toContain('this key reads');
    // The demo's one saved day is the only day it holds.
    expect(listed.out).toContain('Briefings saved for the demo (3), as they stood on Oct 16, 2026:');
    expect(listed.out).not.toContain('past day');
    const note = await run(['ask', '--demo', 'What did Apple report last quarter?']);
    expect(note.out + note.err).toContain('lists the 3 saved briefings.');
    expect(note.out + note.err).not.toContain('this key reads');
  });

  it('says plainly that the demo holds no news, for a question about what was filed or published', async () => {
    const news = await run(['ask', '--demo', 'What did the Federal Register publish on trade this week?']);
    expect(news.code).toBe(1);
    expect(news.err).toContain("The demo's saved briefings hold no news, so nothing was read. With a key, primerkit reads PreReason's news");
    expect(news.err).not.toMatch(/could not be reached|not released/);
  });

  it("lifts the lines that hold the question's words, shows the answer as a sample with no checks, and answers no company question", async () => {
    const flat = (s: string) => s.replace(/\s+/g, ' ');
    // The word match picks macro.snapshot, and the stand in lifts its yield lines.
    const yieldCurve = await run(['ask', '--demo', 'Is the yield curve steepening?']);
    expect(yieldCurve.code).toBe(0);
    expect(flat(yieldCurve.out)).toContain("Yield curve spread (10Y-2Y) at 0.33% (PreReason's calculation: Treasury's 10 year par yield less its 2 year par yield); 7d -0.14 pp (falling), 30d 0.00 pp, 90d -0.04 pp.");
    expect(yieldCurve.out).not.toMatch(/Fed balance sheet|Treasury General Account/);
    // It names the day its briefings were saved.
    expect(flat(yieldCurve.out)).toContain('(demo: saved briefings of Oct 16, 2026, answered by the demo stand in, which lifts sentences and does not read the question)');
    // Its checks line says it is a sample, never that it passed its checks.
    expect(flat(yieldCurve.out)).toContain("Sample answer: the demo's stand in does not read your question. It lifts the sentences that hold its words.");
    expect(yieldCurve.out).not.toContain('✓');
    expect(yieldCurve.out).not.toMatch(/of \d+ checks/);
    // It ends one step from live briefings, in this checkout's own command.
    expect(flat(yieldCurve.out).trim().endsWith('For live briefings, run npm start -- connect prereason and sign in, or make a PreReason account (a free one reads the free briefings), at the link it shows. Then run npm start.')).toBe(true);
    // A company: what a key would read, and no answer.
    const apple = await run(['ask', '--demo', "What is Apple's revenue trend?"]);
    expect(apple.code).toBe(1);
    expect(flat(apple.err)).toContain("The demo's saved briefings hold no company data, so the demo's stand in gives no answer. With a key, a covered company's briefing answers this: a USA company on Basic and above; a Japanese, Korean or Indian company on Pro and above. Name the company by its code, such as equities.company/nvda.");
    expect(flat(apple.err)).toContain('The demo holds 3 saved briefings: macro.snapshot, cross.correlations and btc.context.');
    expect(apple.out).not.toMatch(/BTC at|Hash rate|checks/);
  });

  it('answers with the demo stand in on the saved briefings, and never asks the model the config keeps', async () => {
    const demo = await run(['ask', '--demo', 'Where does Bitcoin stand?']);
    expect(demo.code).toBe(0);
    expect(demo.out).not.toContain('✓');
    expect(demo.out).toContain('answered by the demo stand in');
    // No model wrote it, so its credit line does not say one did.
    expect(demo.out).toContain('lifted by the demo stand in, not investment advice');
    expect(demo.out).not.toContain('written by your model');
    // --version: the logo as plain text where the output is a pipe, then the version.
    const version = await run(['--version']);
    expect(version.out).toMatch(/^ primerkit\n financial research on your own model\n\n primerkit \d+\.\d+\.\d+/);
    const help = await run(['--help']);
    expect(help.out).toContain('primerkit doctor');
    expect(help.out).toContain('primerkit --version              the logo and the version');
    expect(help.out).not.toContain('--keys');
    // A short start, and the PR mark named.
    expect(help.out).toContain('Start here: primerkit --demo shows the session on saved briefings, with no key and no\n  model needed (it also offers a local model it finds)');
    expect(help.out).toContain('PR on a line marks data from PreReason.');
    expect(help.out).toContain('--all                        every metric, not the first few of each area');
    // Each chart a Free key cannot draw is marked with the tier that draws it, from the catalog
    // saved with primerkit where none is kept on this machine; the market map's tier needs
    // PreReason's list of metrics, which this home has not read, so it is left unmarked.
    expect(help.out).toContain('  primerkit chart <name> [range]   yield curve [30d|90d|1y|date] (1y: Basic),\n');
    expect(help.out).toMatch(/\n {35}bitcoin \[30d\|90d\|1y\|all\|from date\] \(90d and 1y: Basic, all: Pro\),\n {35}hashprice \[fill\] \(Basic\), treasury \(Pro\),\n/);
    expect(help.out).toMatch(/\n {35}etf flows \[fill\] \(Basic\), liquidity \(Basic\),\n {35}correlations \[briefing\], market map, markets, positioning;\n {35}a tier named is the least key that draws it\n/);
    // CONTROL: a model the flags name answers the demo instead; nothing answers at this one.
    const named = await run(['ask', '--demo', '--server', 'http://127.0.0.1:9/v1', '--model', 'x', 'Where does Bitcoin stand?']);
    expect(named.code).toBe(1);
    expect(named.out).not.toContain('answered by the demo stand in');
  }, 200_000);
});
