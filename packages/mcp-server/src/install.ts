import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, rmdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { throughCmd } from '@primerkit/core';

// Putting primerkit inside an AI app: its skills in the app's skills folder, where the app
// has one, and its local server in the app's list of MCP servers. The change is shown in full before it
// is made, and it is made only when the person says so. Nothing else in the app changes,
// and nothing that is not primerkit's is ever written over.

export type Host = 'claude-code' | 'codex' | 'gemini' | 'lm-studio';
export const HOSTS: readonly Host[] = ['claude-code', 'codex', 'gemini', 'lm-studio'];
export const HOST_NAMES: Record<Host, string> = { 'claude-code': 'Claude Code', codex: 'Codex', gemini: 'Gemini CLI', 'lm-studio': 'LM Studio' };
export const SKILLS = ['ask', 'digest', 'bench', 'backtest'];

export type Step =
  | { kind: 'command'; command: string; args: string[]; present: string[] | null; undo: string[]; what?: string } // present: a command that exits 0 when the entry is there; what: whose server, primerkit's unless said
  | { kind: 'file'; path: string; content: string }
  | { kind: 'edit'; path: string; describe: string; removal: string; apply: (before: string) => string; undo: (after: string) => string; has: (text: string) => boolean; same: (text: string) => boolean; empty: (text: string) => boolean; what?: string }; // has: lists primerkit's server, with any launch; same: with this launch; empty: sets nothing at all; removal: what undo does, in words

export interface InstallPlan {
  host: Host;
  name: string;
  steps: Step[];
}

export interface InstallOptions {
  node: string; // process.execPath
  bin: string; // primerkit's bin
  home: string; // the person's home folder
  skillsFrom: string; // hosts/claude-code-plugin/skills
  launch?: Launch; // what the app runs to start the server; node with the bin and mcp by default
}

export interface Launch {
  command: string;
  args: string[];
}

const launchOf = (o: InstallOptions): Launch => o.launch ?? { command: o.node, args: [o.bin, 'mcp'] };
const shown = (l: Launch): string => [l.command, ...l.args].join(' ');

// LM Studio keeps its mcp.json in ~/.lmstudio, by its own docs; on some Macs the file has
// been found in ~/.cache/lm-studio instead, so an existing file there is the one used.
export function lmStudioConfig(home: string): string {
  const documented = join(home, '.lmstudio', 'mcp.json');
  const cache = join(home, '.cache', 'lm-studio', 'mcp.json');
  return !existsSync(documented) && existsSync(cache) ? cache : documented;
}

// A skill as installed in a person's own folder takes primerkit's name, so it cannot
// clash with a skill of theirs called ask.
export const installedName = (skill: string) => `primerkit-${skill}`;

function skillFile(o: InstallOptions, dir: string, skill: string): Step {
  const source = readFileSync(join(o.skillsFrom, skill, 'SKILL.md'), 'utf8').replace(/\r\n/g, '\n');
  return { kind: 'file', path: join(dir, installedName(skill), 'SKILL.md'), content: source.replace(/^name: .*$/m, `name: ${installedName(skill)}`) };
}

function jsonEdit(path: string, launch: Launch): Step {
  const entry = { command: launch.command, args: launch.args };
  // A byte order mark that some editors leave at the start is not part of the JSON.
  const read = (text: string) => {
    const bare = text.replace(/^\uFEFF/, '');
    return bare.trim() ? (JSON.parse(bare) as { mcpServers?: Record<string, unknown> } & Record<string, unknown>) : {};
  };
  return {
    kind: 'edit',
    path,
    describe: `adds "primerkit" under mcpServers: ${shown(launch)}`,
    removal: 'takes "primerkit" out from under mcpServers',
    has: (text) => Boolean(read(text).mcpServers?.primerkit),
    // The launch is what primerkit writes; anything else the person put in its entry (an
    // env, a timeout, trust) is theirs, and stays.
    same: (text) => {
      const kept = read(text).mcpServers?.primerkit as { command?: unknown; args?: unknown } | undefined;
      return JSON.stringify([kept?.command, kept?.args]) === JSON.stringify([entry.command, entry.args]);
    },
    apply: (before) => {
      const json = read(before);
      const kept = json.mcpServers?.primerkit;
      const theirs = kept && typeof kept === 'object' && !Array.isArray(kept) ? (kept as Record<string, unknown>) : {};
      return `${JSON.stringify({ ...json, mcpServers: { ...(json.mcpServers ?? {}), primerkit: { ...theirs, ...entry } } }, null, 2)}\n`;
    },
    undo: (after) => {
      const json = read(after);
      if (json.mcpServers) delete json.mcpServers.primerkit;
      return `${JSON.stringify(json, null, 2)}\n`;
    },
    empty: (text) => {
      try {
        const json = read(text);
        return Object.keys(json).every((k) => k === 'mcpServers') && Object.keys(json.mcpServers ?? {}).length === 0;
      } catch {
        return false;
      }
    },
  };
}

// primerkit's table in Codex's config.toml as it stands: its header and the lines under it,
// up to a blank line, a comment or the next table's header.
const OURS = /^\[mcp_servers\.primerkit\][^\n]*\n?(?:(?![[#\r\n])[^\n]+\n?)*/m;
const COMMAND = /^command\s*=.*$/m;
const ARGS = /^args\s*=.*$/m;

function tomlEdit(path: string, launch: Launch): Step {
  const command = `command = ${JSON.stringify(launch.command)}`;
  const args = `args = [${launch.args.map((a) => JSON.stringify(a)).join(', ')}]`;
  const table = `[mcp_servers.primerkit]\n${command}\n${args}\n`;
  // The launch lines of primerkit's table as it stands, or null where there is no table.
  const launchOf = (text: string): string | null => {
    const ours = OURS.exec(text)?.[0];
    return ours === undefined ? null : `${COMMAND.exec(ours)?.[0]?.trim() ?? ''}\n${ARGS.exec(ours)?.[0]?.trim() ?? ''}`;
  };
  return {
    kind: 'edit',
    path,
    describe: `adds a [mcp_servers.primerkit] table: ${shown(launch)}`,
    removal: 'takes out the [mcp_servers.primerkit] table',
    has: (text) => OURS.test(text),
    same: (text) => launchOf(text) === `${command}\n${args}`,
    // A table with an older launch line has its launch lines written anew, never a second
    // table beside it; any other line the person put in it, and the rest of the file, stay
    // as they are.
    apply: (before) => {
      const ours = OURS.exec(before)?.[0];
      if (ours === undefined) return `${before.replace(/\s*$/, '')}${before.trim() ? '\n\n' : ''}${table}`;
      const eol = ours.includes('\r\n') ? '\r\n' : '\n';
      let next = COMMAND.test(ours) ? ours.replace(COMMAND, command) : ours.replace(/^(\[mcp_servers\.primerkit\][^\n]*\n?)/, `$1${command}${eol}`);
      next = ARGS.test(next) ? next.replace(ARGS, args) : next.replace(COMMAND, `${command}${eol}${args}`);
      return before.replace(ours, () => next);
    },
    // primerkit's table goes whatever launch line it was written with.
    undo: (after) => {
      const rest = after.replace(OURS, '').replace(/\n{3,}/g, '\n\n').replace(/^\n+/, '').replace(/\s+$/, '');
      return rest ? `${rest}\n` : '';
    },
    empty: (text) => !text.trim(),
  };
}

export function planInstall(host: Host, o: InstallOptions): InstallPlan {
  const launch = launchOf(o);
  if (host === 'claude-code') {
    return {
      host,
      name: HOST_NAMES[host],
      steps: [
        { kind: 'command', command: 'claude', args: ['mcp', 'add', '--scope', 'user', 'primerkit', '--', launch.command, ...launch.args], present: ['mcp', 'get', 'primerkit'], undo: ['mcp', 'remove', '--scope', 'user', 'primerkit'] },
        ...SKILLS.map((s) => skillFile(o, join(o.home, '.claude', 'skills'), s)),
      ],
    };
  }
  if (host === 'gemini') {
    return { host, name: HOST_NAMES[host], steps: [jsonEdit(join(o.home, '.gemini', 'settings.json'), launch), ...SKILLS.map((s) => skillFile(o, join(o.home, '.gemini', 'skills'), s))] };
  }
  // LM Studio has no skills folder; its own confirmation asks before a tool call, until the
  // person tells it to always allow that tool.
  if (host === 'lm-studio') return { host, name: HOST_NAMES[host], steps: [jsonEdit(lmStudioConfig(o.home), launch)] };
  return { host, name: HOST_NAMES[host], steps: [tomlEdit(join(o.home, '.codex', 'config.toml'), launch), ...SKILLS.map((s) => skillFile(o, join(o.home, '.agents', 'skills'), s))] };
}

// Robinhood's own hosted server for its agent accounts, by the name and address Robinhood's
// help centre gives (guides/live-trading.md, "Robinhood"). primerkit adds it to the person's AI
// app and adds the trade skill beside it; it runs nothing of Robinhood's, signs in to nothing,
// and passes Robinhood nothing. The person signs in inside the app, with /mcp.
export const ROBINHOOD_URL = 'https://agent.robinhood.com/mcp/trading';
export const ROBINHOOD_SERVER = 'robinhood-trading';
export const ROBINHOOD_HOSTS: readonly Host[] = ['claude-code', 'codex'];
export const TRADE_SKILL = 'trade';
const ROBINHOOD_WHAT = "Robinhood's server";

// Robinhood's table in Codex's config.toml: its header and the lines under it, as primerkit's
// own table is read above.
const ROBINHOOD_TABLE = new RegExp(`^\\[mcp_servers\\.${ROBINHOOD_SERVER}\\][^\\n]*\\n?(?:(?![[#\\r\\n])[^\\n]+\\n?)*`, 'm');

function robinhoodToml(path: string): Step {
  const line = `url = ${JSON.stringify(ROBINHOOD_URL)}`;
  const table = `[mcp_servers.${ROBINHOOD_SERVER}]\n${line}\n`;
  return {
    kind: 'edit',
    path,
    what: ROBINHOOD_WHAT,
    describe: `adds a [mcp_servers.${ROBINHOOD_SERVER}] table: url ${ROBINHOOD_URL}`,
    removal: `takes out the [mcp_servers.${ROBINHOOD_SERVER}] table`,
    // Only a table with Robinhood's address is taken out; one with any other is the person's.
    has: (text) => (ROBINHOOD_TABLE.exec(text)?.[0] ?? '').split(/\r?\n/).some((l) => l.trim() === line),
    same: (text) => (ROBINHOOD_TABLE.exec(text)?.[0] ?? '').split(/\r?\n/).some((l) => l.trim() === line),
    // A table already there, with another address, is the person's: it is left as it is and
    // named, never written over.
    apply: (before) => {
      if (ROBINHOOD_TABLE.test(before)) throw new Error(`${path} already has a [mcp_servers.${ROBINHOOD_SERVER}] table with another address, so nothing was changed. Check it against Robinhood's page.`);
      return `${before.replace(/\s*$/, '')}${before.trim() ? '\n\n' : ''}${table}`;
    },
    undo: (after) => {
      const rest = after.replace(ROBINHOOD_TABLE, '').replace(/\n{3,}/g, '\n\n').replace(/^\n+/, '').replace(/\s+$/, '');
      return rest ? `${rest}\n` : '';
    },
    empty: (text) => !text.trim(),
  };
}

// What primerkit connect robinhood adds to one app: Robinhood's server, and the trade skill.
export function planRobinhood(host: Host, o: InstallOptions): InstallPlan {
  if (!ROBINHOOD_HOSTS.includes(host)) throw new Error(`primerkit adds Robinhood's server to ${ROBINHOOD_HOSTS.join(' or ')}; for ${HOST_NAMES[host]}, follow Robinhood's own page.`);
  if (host === 'claude-code') {
    return {
      host,
      name: HOST_NAMES[host],
      steps: [
        { kind: 'command', command: 'claude', args: ['mcp', 'add', '--scope', 'user', '--transport', 'http', ROBINHOOD_SERVER, ROBINHOOD_URL], present: ['mcp', 'get', ROBINHOOD_SERVER], undo: ['mcp', 'remove', '--scope', 'user', ROBINHOOD_SERVER], what: ROBINHOOD_WHAT },
        skillFile(o, join(o.home, '.claude', 'skills'), TRADE_SKILL),
      ],
    };
  }
  return { host, name: HOST_NAMES[host], steps: [robinhoodToml(join(o.home, '.codex', 'config.toml')), skillFile(o, join(o.home, '.agents', 'skills'), TRADE_SKILL)] };
}

const commandLine = (words: string[]): string => words.map((a) => (/\s/.test(a) ? `"${a}"` : a)).join(' ');

// The change as the person reads it before saying yes.
export function describePlan(plan: InstallPlan): string[] {
  return plan.steps.map((step) => {
    if (step.kind === 'command') return `runs   ${commandLine([step.command, ...step.args])}`;
    if (step.kind === 'file') return `writes ${step.path}`;
    return `edits  ${step.path}: ${step.describe}`;
  });
}

// What taking primerkit out changes, as the person reads it before saying yes: the steps
// removeInstall below takes, never the install's own. Each is taken only where primerkit's
// part is found.
export function describeRemoval(plan: InstallPlan): string[] {
  const lines: string[] = [];
  const skillsIn = new Set<string>();
  for (const step of plan.steps) {
    if (step.kind === 'command') lines.push(`runs    ${commandLine([step.command, ...step.undo])}`);
    else if (step.kind === 'file') {
      lines.push(`deletes ${dirname(step.path)}`);
      skillsIn.add(dirname(dirname(step.path)));
    } else lines.push(`edits   ${step.path}: ${step.removal}`);
  }
  for (const dir of skillsIn) lines.push(`deletes ${dir}, and ${dirname(dir)}, if that leaves them empty`);
  for (const step of plan.steps) {
    if (step.kind === 'edit') lines.push(`deletes ${step.path}, and ${dirname(step.path)}, if the file is left setting nothing and alone in its folder`);
  }
  return lines;
}

export type Runner = (command: string, args: string[]) => Promise<{ code: number | null; stdout: string; stderr: string }>;

// On Windows an npm installed command such as claude is a .cmd file, which only cmd.exe
// runs: see throughCmd, which refuses an argument cmd.exe would read as more than text.
// Elsewhere the command runs without a shell.
export const systemRunner: Runner = (command, args) =>
  new Promise((resolve) => {
    let child;
    try {
      const cmd = process.platform === 'win32' ? throughCmd(command, args) : null;
      child = cmd ? spawn(cmd.command, cmd.args, { windowsVerbatimArguments: true, stdio: ['ignore', 'pipe', 'pipe'] }) : spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (error) {
      resolve({ code: null, stdout: '', stderr: (error as Error).message });
      return;
    }
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d: Buffer) => (stdout += d.toString()));
    child.stderr.on('data', (d: Buffer) => (stderr += d.toString()));
    child.on('error', (error) => resolve({ code: null, stdout, stderr: error.message }));
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });

const ours = (path: string) => {
  if (!existsSync(path)) return true;
  const name = /^name: (.*)$/m.exec(readFileSync(path, 'utf8'))?.[1]?.trim() ?? '';
  return name.startsWith('primerkit-');
};

// Every step is checked before any is made, so a refusal changes nothing.
export async function applyInstall(plan: InstallPlan, run: Runner): Promise<string[]> {
  const clash = plan.steps.find((s): s is Extract<Step, { kind: 'file' }> => s.kind === 'file' && !ours(s.path));
  if (clash) throw new Error(`${dirname(clash.path)} holds a skill that is not primerkit's, so nothing was changed.`);
  for (const step of plan.steps) {
    if (step.kind === 'edit' && existsSync(step.path)) {
      try {
        step.has(readFileSync(step.path, 'utf8'));
      } catch {
        throw new Error(`${step.path} could not be read as it stands, so nothing was changed.`);
      }
    }
  }
  const done: string[] = [];
  for (const step of plan.steps) {
    if (step.kind === 'command') {
      if (step.present && (await run(step.command, step.present)).code === 0) {
        done.push(`${plan.name} already lists ${step.what ?? "primerkit's server"}`);
        continue;
      }
      const r = await run(step.command, step.args);
      if (r.code !== 0) throw new Error(`${step.command} ${step.args.slice(0, 2).join(' ')} failed: ${(r.stderr || r.stdout).trim() || `exit ${r.code}`}`);
      done.push(`added ${step.what ?? "primerkit's server"} to ${plan.name}`);
    } else if (step.kind === 'file') {
      mkdirSync(dirname(step.path), { recursive: true });
      writeFileSync(step.path, step.content);
      done.push(`wrote ${step.path}`);
    } else {
      const before = existsSync(step.path) ? readFileSync(step.path, 'utf8') : '';
      if (step.same(before)) {
        done.push(`${step.path} already lists ${step.what ?? "primerkit's server"}`);
        continue;
      }
      mkdirSync(dirname(step.path), { recursive: true });
      writeFileSync(step.path, step.apply(before));
      done.push(`edited ${step.path}`);
    }
  }
  return done;
}

// A folder left with nothing in it goes, then its parent where that is left empty too, up to
// `levels` folders. A folder that holds anything stays.
function emptied(dir: string, levels: number, done: string[]): void {
  for (let i = 0; i < levels; i++, dir = dirname(dir)) {
    try {
      if (readdirSync(dir).length) return;
      rmdirSync(dir);
    } catch {
      return;
    }
    done.push(`removed ${dir}, left empty`);
  }
}

// Takes out what the install put in, and nothing else. Where the app has never run (its
// folder holds only the file primerkit's install made, and the file sets nothing once
// primerkit's entry is out), the file and the folders it leaves empty go too.
export async function removeInstall(plan: InstallPlan, run: Runner): Promise<string[]> {
  const done: string[] = [];
  const skillsIn = new Set<string>(); // the skills folders a skill was taken out of
  const edited: Array<Extract<Step, { kind: 'edit' }>> = [];
  for (const step of plan.steps) {
    if (step.kind === 'command') {
      if (step.present && (await run(step.command, step.present)).code !== 0) continue;
      const r = await run(step.command, step.undo);
      if (r.code === 0) done.push(`removed ${step.what ?? "primerkit's server"} from ${plan.name}`);
    } else if (step.kind === 'file') {
      if (!existsSync(step.path) || !ours(step.path)) continue;
      rmSync(dirname(step.path), { recursive: true, force: true });
      done.push(`removed ${dirname(step.path)}`);
      skillsIn.add(dirname(dirname(step.path)));
    } else if (existsSync(step.path)) {
      const text = readFileSync(step.path, 'utf8');
      if (!step.has(text)) continue;
      writeFileSync(step.path, step.undo(text));
      done.push(`edited ${step.path}`);
      edited.push(step);
    }
  }
  // The skills folders first, so an app's folder that held them and the file is seen to hold
  // the file alone.
  for (const dir of skillsIn) emptied(dir, 2, done);
  for (const step of edited) {
    if (!step.empty(readFileSync(step.path, 'utf8')) || readdirSync(dirname(step.path)).length !== 1) continue;
    rmSync(step.path, { force: true });
    done.push(`removed ${step.path}, which set nothing else`);
    emptied(dirname(step.path), 1, done);
  }
  return done;
}
