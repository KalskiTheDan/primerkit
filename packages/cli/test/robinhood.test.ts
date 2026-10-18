import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { Journal, readConfig, readLiveIntent, recordLiveIntent } from '@primerkit/core';
import { ROBINHOOD_URL, type Runner } from '@primerkit/mcp-server';
import { ROOT } from '@primerkit/session';
import { TAGLINE, lockup, maker, renderLine } from '@primerkit/ui';
import type { Io } from '../src/broker';
import { approveCommand, connectRobinhood } from '../src/robinhood';

type TestIo = Io & { out: string[]; errors: string[]; asked: string[] };

// A person at a terminal unless a test says otherwise, typing the answers given.
function io(answers: string[] = [], terminal = true): TestIo {
  const out: string[] = [];
  const errors: string[] = [];
  const asked: string[] = [];
  return {
    out,
    errors,
    asked,
    terminal,
    print: (lines) => void out.push(...lines),
    fail: (m) => (errors.push(m), 1),
    ask: async (q) => {
      asked.push(q);
      return answers.shift() ?? '';
    },
  };
}

// A scratch home for the person, and one for primerkit, as HOME and PRIMERKIT_HOME would be.
function homes() {
  const home = mkdtempSync(join(tmpdir(), 'pk-rh-home-'));
  const pk = join(home, '.primerkit');
  mkdirSync(pk);
  return { home, pk, install: { node: process.execPath, bin: 'primerkit.js', home, skillsFrom: join(ROOT, 'hosts', 'claude-code-plugin', 'skills') } };
}

// Claude Code's own command, recorded and never run: the list it keeps, as `claude mcp` would.
function fakeClaude(): { runner: Runner; calls: string[][]; listed: Set<string> } {
  const calls: string[][] = [];
  const listed = new Set<string>();
  const runner: Runner = async (command, args) => {
    calls.push([command, ...args]);
    if (args[1] === 'get') return { code: listed.has(args[2]!) ? 0 : 1, stdout: '', stderr: '' };
    if (args[1] === 'add') listed.add(args.at(-2)!);
    if (args[1] === 'remove') listed.delete(args.at(-1)!);
    return { code: 0, stdout: '', stderr: '' };
  };
  return { runner, calls, listed };
}

describe('primerkit connect robinhood', () => {
  it('shows what it adds, says real money and both yeses, and changes nothing without a terminal', async () => {
    const h = homes();
    const t = io([], false);
    const claude = fakeClaude();
    expect(await connectRobinhood(t, { host: 'claude-code', remove: false, yes: true, install: h.install, runner: claude.runner, home: h.pk })).toBe(1);
    const shown = t.out.join('\n');
    expect(shown).toContain('This is real money: an order placed through it is a real order, and its losses are real.');
    expect(shown).toContain('Nothing here is investment advice, and the model never proposes a strategy.');
    expect(shown).toContain(`The server is Robinhood's own, at ${ROBINHOOD_URL}.`);
    expect(shown).toContain('Signing in opens a separate agent account at Robinhood.');
    expect(shown).toContain('No key or password is typed into primerkit, and primerkit keeps none.');
    expect(shown).toContain('you approve its intent in primerkit (primerkit intent approve <id>, typed at a terminal)');
    expect(shown).toContain(`runs   claude mcp add --scope user --transport http robinhood-trading ${ROBINHOOD_URL}`);
    expect(shown).toContain(`writes ${join(h.home, '.claude', 'skills', 'primerkit-trade', 'SKILL.md')}`);
    // --yes does not stand in for the yes: with no terminal nothing is asked and nothing runs.
    expect(t.errors[0]).toMatch(/at a terminal, and this run has none.*Nothing was changed\./);
    expect(t.asked).toEqual([]);
    expect(claude.calls).toEqual([]);
    expect(readdirSync(h.home)).toEqual(['.primerkit']);
    expect(readConfig(h.pk).brokers?.robinhood).toBeUndefined();
    // A no at the terminal changes nothing either.
    const no = io(['no']);
    expect(await connectRobinhood(no, { host: 'claude-code', remove: false, yes: false, install: h.install, runner: claude.runner, home: h.pk })).toBe(0);
    expect(no.out.at(-1)).toBe('Nothing was changed.');
    expect(claude.calls).toEqual([]);
  });

  it("adds Robinhood's server and the trade skill to Claude Code on a yes, keeps the approvals answer, and takes out what it added", async () => {
    const h = homes();
    const claude = fakeClaude();
    const t = io(['yes', 'yes']);
    expect(await connectRobinhood(t, { host: 'claude-code', remove: false, yes: false, install: h.install, runner: claude.runner, home: h.pk, now: () => new Date('2026-10-16T09:30:00Z') })).toBe(0);
    expect(claude.calls).toEqual([
      ['claude', 'mcp', 'get', 'robinhood-trading'],
      ['claude', 'mcp', 'add', '--scope', 'user', '--transport', 'http', 'robinhood-trading', ROBINHOOD_URL],
    ]);
    const skill = readFileSync(join(h.home, '.claude', 'skills', 'primerkit-trade', 'SKILL.md'), 'utf8');
    expect(skill).toMatch(/^---\nname: primerkit-trade\n/);
    expect(skill).toContain('primerkit intent approve <id>');
    expect(skill).toContain('Never tell the app to always allow an order tool');
    expect(t.out).toContain("added Robinhood's server to Claude Code.");
    expect(t.out.join('\n')).toContain('under Safety Controls, turn Trade approvals on');
    expect(t.asked).toEqual(['Make them? Type yes to make them: ', 'Are Trade approvals on? Type yes once you have turned them on: ']);
    expect(readConfig(h.pk).brokers?.robinhood).toEqual({ hosts: ['claude-code'], added: ['claude-code'], approvals_confirmed_at: '2026-10-16T09:30:00.000Z' });

    const out = io(['yes']);
    expect(await connectRobinhood(out, { host: 'claude-code', remove: true, yes: false, install: h.install, runner: claude.runner, home: h.pk })).toBe(0);
    expect(claude.calls.at(-1)).toEqual(['claude', 'mcp', 'remove', '--scope', 'user', 'robinhood-trading']);
    expect(existsSync(join(h.home, '.claude'))).toBe(false);
    expect(readConfig(h.pk).brokers?.robinhood).toBeUndefined();
  });

  it("leaves a Robinhood server primerkit did not add, and takes out only the skill", async () => {
    const h = homes();
    const claude = fakeClaude();
    claude.listed.add('robinhood-trading');
    expect(await connectRobinhood(io(['yes', 'no']), { host: 'claude-code', remove: false, yes: false, install: h.install, runner: claude.runner, home: h.pk })).toBe(0);
    expect(claude.calls).toEqual([['claude', 'mcp', 'get', 'robinhood-trading']]);
    expect(readConfig(h.pk).brokers?.robinhood).toEqual({ hosts: ['claude-code'], added: [] });
    const out = io([]);
    expect(await connectRobinhood(out, { host: 'claude-code', remove: true, yes: true, install: h.install, runner: claude.runner, home: h.pk })).toBe(0);
    expect(out.out.join('\n')).toContain("primerkit did not add Robinhood's server to Claude Code, so it stays.");
    expect(claude.calls.some((c) => c.includes('remove'))).toBe(false);
    expect(claude.listed.has('robinhood-trading')).toBe(true);
  });

  it("writes Robinhood's table into Codex's config.toml beside the person's own, and takes out exactly that", async () => {
    const h = homes();
    const file = join(h.home, '.codex', 'config.toml');
    mkdirSync(join(h.home, '.codex'));
    const theirs = 'model = "gpt-5"\n\n[mcp_servers.other]\ncommand = "other"\n';
    writeFileSync(file, theirs);
    expect(await connectRobinhood(io(['yes', 'yes']), { host: 'codex', remove: false, yes: false, install: h.install, home: h.pk })).toBe(0);
    expect(readFileSync(file, 'utf8')).toBe(`${theirs}\n[mcp_servers.robinhood-trading]\nurl = "${ROBINHOOD_URL}"\n`);
    expect(existsSync(join(h.home, '.agents', 'skills', 'primerkit-trade', 'SKILL.md'))).toBe(true);
    expect(await connectRobinhood(io([]), { host: 'codex', remove: true, yes: true, install: h.install, home: h.pk })).toBe(0);
    expect(readFileSync(file, 'utf8')).toBe(theirs);
    expect(existsSync(join(h.home, '.agents'))).toBe(false);
  });

  it('names the apps it adds Robinhood to, and no other', async () => {
    const h = homes();
    const t = io();
    expect(await connectRobinhood(t, { host: 'gemini', remove: false, yes: false, install: h.install, home: h.pk })).toBe(1);
    expect(t.errors[0]).toBe("Say which app: --host claude-code or --host codex. For any other app, follow Robinhood's own page.");
  });
});

describe('primerkit intent approve', () => {
  it('approves a live intent on a yes typed at a terminal, and never without one', async () => {
    const h = homes();
    const at = new Date('2026-10-16T09:00:00Z');
    const kept = recordLiveIntent(new Journal(join(h.pk, 'journal')), { symbol: 'AAPL', side: 'buy', quantity: 2, source: 'typed' }, at);
    const id = kept.intent.intent_id;
    const list = io();
    expect(await approveCommand(list, undefined, () => at, h.pk)).toBe(0);
    expect(list.out.join('\n')).toContain(`${id}  buy 2 AAPL`);

    const piped = io(['yes'], false);
    expect(await approveCommand(piped, id, () => at, h.pk)).toBe(1);
    expect(piped.errors[0]).toMatch(/The yes for a live intent is typed at a terminal/);
    expect(piped.asked).toEqual([]);
    expect(readLiveIntent(kept.dir, at).state).toBe('pending');

    const no = io(['no']);
    expect(await approveCommand(no, id, () => at, h.pk)).toBe(0);
    expect(readLiveIntent(kept.dir, at).state).toBe('pending');

    const yes = io(['yes']);
    expect(await approveCommand(yes, id, () => at, h.pk)).toBe(0);
    expect(yes.out.join('\n')).toContain("Robinhood's trade approvals, if you turned them on, ask again in its app. It is real money.");
    expect(yes.out.at(-1)).toBe("Approved. Your AI app reads this with primerkit's status tool. It expires 10:00 UTC.");
    expect(readLiveIntent(kept.dir, at).state).toBe('approved');
    const again = io(['yes']);
    expect(await approveCommand(again, id, () => at, h.pk)).toBe(1);
    expect(again.errors[0]).toBe('It is approved already.');
    expect(await approveCommand(io(), '20261016T090000Z-ffffff', () => at, h.pk)).toBe(1);
  });
});

const BIN = fileURLToPath(new URL('../bin/primerkit.js', import.meta.url));

// The command as a script runs it, with its own homes, its input a pipe.
function run(args: string[], home: string): Promise<{ code: number; out: string; err: string }> {
  return new Promise((resolve) => {
    execFile(process.execPath, [BIN, ...args], { env: { ...process.env, HOME: home, USERPROFILE: home, PRIMERKIT_HOME: join(home, '.primerkit'), PREREASON_API_KEY: '' }, timeout: 90_000 }, (error, out, err) =>
      resolve({ code: error ? Number((error as NodeJS.ErrnoException).code ?? 1) : 0, out, err }),
    );
  });
}

describe('--json from the command line', { timeout: 300_000 }, () => {
  it('prints the demo ask, catalog and brief as JSON, a journal as JSON, and a refusal with its code', async () => {
    const home = mkdtempSync(join(tmpdir(), 'pk-cli-json-'));
    const asked = await run(['ask', '--demo', '--json', 'Where does Bitcoin stand?'], home);
    expect(asked.code).toBe(0);
    const answer = JSON.parse(asked.out);
    expect(answer).toMatchObject({ ok: true, kind: 'answer', operation: 'ask', checks: [], demo: { stand_in: true, checked: false } });
    expect(answer.claims.length).toBeGreaterThan(0);
    expect(answer.claims[0].citations[0]).toEqual({ block: expect.any(String), line: expect.any(Number), quote: expect.any(String) });

    const cat = JSON.parse((await run(['catalog', '--demo', '--json'], home)).out);
    expect(cat).toMatchObject({ ok: true, tier: 'free', key: false, demo: { saved_on: expect.any(String) } });
    expect(cat.briefings.map((b: { id: string }) => b.id)).toContain('btc.context');

    const brief = JSON.parse((await run(['brief', 'btc.context', '--demo', '--json'], home)).out);
    expect(brief).toMatchObject({ ok: true, id: 'btc.context', source: expect.any(String) });
    expect(brief.lines[0]).toEqual({ n: 1, text: expect.any(String) });

    const nokey = await run(['ask', '--json', 'Where does Bitcoin stand?', '--ollama', 'qwen3:8b'], home);
    expect(nokey.code).toBe(1);
    expect(JSON.parse(nokey.out)).toMatchObject({ ok: false, error: { code: 'no_key' } });

    expect(JSON.parse((await run(['journal', '--json'], home)).out)).toEqual({ ok: true, runs: [] });
    expect(JSON.parse((await run(['journal', '--json', '--summary'], home)).out)).toEqual({ ok: true, days: [] });

    // Adding Robinhood from a script shows the change and asks nothing.
    const rh = await run(['connect', 'robinhood', '--host', 'codex'], home);
    expect(rh.code).toBe(1);
    expect(rh.out).toContain('adds a [mcp_servers.robinhood-trading] table');
    expect(rh.err).toContain('Nothing was changed.');
    expect(existsSync(join(home, '.codex'))).toBe(false);
  });
});

describe("the connect screens open with primerkit's mark, and name the broker in plain words", { timeout: 200_000 }, () => {
  // The small lockup as a colour terminal draws it, and the screen's first lines that show it.
  const MARK = lockup(maker(false), false, 'small').map((l) => renderLine(l, 'truecolor'));
  const opensWithMark = (out: string[]) => MARK.every((line, i) => out[i] === line) && out[MARK.length] === '';
  const withMark = (answers: string[] = [], terminal = true): TestIo => ({ ...io(answers, terminal), mark: MARK });

  it('draws the mark above the words before the yes, and keeps every word as it was', async () => {
    const h = homes();
    const claude = fakeClaude();
    const marked = withMark([], false);
    const bare = io([], false);
    expect(await connectRobinhood(marked, { host: 'claude-code', remove: false, yes: false, install: h.install, runner: claude.runner, home: h.pk })).toBe(1);
    expect(await connectRobinhood(bare, { host: 'claude-code', remove: false, yes: false, install: h.install, runner: claude.runner, home: h.pk })).toBe(1);
    expect(opensWithMark(marked.out)).toBe(true);
    // Below the mark and its blank line, the screen is the same, word for word.
    expect(marked.out.slice(MARK.length + 1)).toEqual(bare.out);
    expect(marked.out[MARK.length + 1]).toBe("Robinhood live trading, through Robinhood's own hosted server.");
    // CONTROL: the screen without the mark fails the same check.
    expect(opensWithMark(bare.out)).toBe(false);
    // The colour is primerkit's mark alone: the broker's lines carry none, and the mark names no broker.
    expect(MARK.some((l) => l.includes('\x1b['))).toBe(true);
    expect(marked.out.slice(MARK.length).some((l) => l.includes('\x1b'))).toBe(false);
    expect(MARK.join('\n')).not.toMatch(/robinhood|alpaca/i);
  });

  it('draws the mark above the screen that takes Robinhood out', async () => {
    const h = homes();
    const claude = fakeClaude();
    expect(await connectRobinhood(io(['yes', 'no']), { host: 'claude-code', remove: false, yes: false, install: h.install, runner: claude.runner, home: h.pk })).toBe(0);
    const out = withMark();
    expect(await connectRobinhood(out, { host: 'claude-code', remove: true, yes: true, install: h.install, runner: claude.runner, home: h.pk })).toBe(0);
    expect(opensWithMark(out.out)).toBe(true);
    expect(out.out[MARK.length + 1]).toBe("Taking Robinhood out of Claude Code makes these changes, each where primerkit's part is found:");
  });

  it('draws the name and tagline as plain text where the output is a pipe, as --version does', async () => {
    const home = mkdtempSync(join(tmpdir(), 'pk-cli-mark-'));
    mkdirSync(join(home, '.primerkit'));
    const shown = await run(['connect', 'robinhood', '--host', 'claude-code'], home);
    expect(shown.code).toBe(1);
    expect(shown.out.startsWith(` primerkit\n ${TAGLINE}\n\nRobinhood live trading, through Robinhood's own hosted server.\n`)).toBe(true);
    expect(shown.out).not.toContain('\x1b');
    expect(shown.err).toMatch(/at a terminal, and this run has none/);
    // Nothing was changed: no app's settings were written.
    expect(readdirSync(home)).toEqual(['.primerkit']);
  });
});
