import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { parse, stringify } from 'yaml';

// A program Windows ships in System32, by its full path. Windows looks for a bare program
// name in the current folder first, so a file of that name in a folder someone else filled
// would run in its place. SystemRoot counts only as a full path with its drive: a value
// such as "." would make the path one under the current folder again.
export function windowsProgram(name: string, env: Record<string, string | undefined> = process.env): string {
  const root = [env.SystemRoot, env.windir].find((v) => v !== undefined && /^[A-Za-z]:[\\/]/.test(v));
  return join(root ?? 'C:\\Windows', 'System32', name);
}

// One argument as cmd.exe reads it. Inside double quotes cmd.exe reads a caret and a space
// as themselves, so an argument holding anything but plain characters is quoted: unquoted,
// the caret of a version range such as ^0.5.0 is dropped. A quote, a percent sign and the
// characters that join or redirect commands are refused rather than escaped.
function cmdArg(arg: string): string {
  if (/["%&|<>!\r\n]/.test(arg)) throw new Error(`primerkit will not pass ${arg} through cmd.exe`);
  return /^[\w./:\\=@-]+$/.test(arg) ? arg : `"${arg}"`;
}

// How a command npm installed (npx, claude) is started on Windows, where it is a .cmd file
// that only cmd.exe runs: cmd.exe by its full path, with the whole line as one argument to
// pass as it is written (windowsVerbatimArguments). Node's own shell option is not used:
// it starts ComSpec, or the bare name cmd.exe where that is unset.
export function throughCmd(command: string, args: string[], env: Record<string, string | undefined> = process.env): { command: string; args: string[] } {
  return { command: windowsProgram('cmd.exe', env), args: ['/d', '/s', '/c', `"${[command, ...args].map(cmdArg).join(' ')}"`] };
}

// Where primerkit keeps its files on this machine: ~/.primerkit, or PRIMERKIT_HOME.
export function primerkitHome(env: Record<string, string | undefined> = process.env, home = homedir()): string {
  return env.PRIMERKIT_HOME || join(home, '.primerkit');
}

// config.yaml. Nothing in it leaves the machine, and no key is
// ever written to it: a hosted model's key stays in its provider's environment variable.
export interface Config {
  disclaimer_accepted_at?: string; // the first run's welcome, accepted once
  model?: ConfigModel;
  packet_format?: 'json' | 'markdown';
  rise_colour?: 'green' | 'red';
  first_run_done_at?: string;
  // The key's tier, as its limits last said; and the key PreReason last refused, as a mark
  // (twelve characters of its SHA-256, never the key itself), with when, and why: PreReason's
  // own word for a dead key, or 'address' for a key limited to other addresses.
  prereason?: { tier?: string; checked_at?: string; refused?: string; refused_at?: string; refused_said?: string; refused_why?: 'address' };
  watchlist?: string[]; // the briefings the digest reads
  cutoffs?: Record<string, string>; // a model's training cutoff, YYYY-MM, where the person gave it
  digest?: { time?: string; since?: 'last' | 'yesterday' };
  // A broker connection: off until turned on, and a dry run first. Caps are the person's
  // own; until they are set, no order is placed.
  brokers?: {
    alpaca?: {
      mode?: 'off' | 'read' | 'dry_run' | 'paper';
      // max_exposure_share and groups are optional: all positions together, and symbols that
      // move together, each as a share of equity.
      caps?: { max_notional: number; max_position_share: number; symbols: string[]; max_orders_per_day: number; max_exposure_share?: number; groups?: Array<{ name: string; symbols: string[]; max_share: number }> };
    };
    // Robinhood's own hosted server, added to these AI apps by primerkit connect robinhood,
    // with the time the person said its trade approvals were on. primerkit keeps no Robinhood
    // key, sign in or account data.
    // hosts: the apps it is set up in; added: those where primerkit itself added the server,
    // so taking it out takes out only what primerkit put in.
    robinhood?: { hosts?: string[]; added?: string[]; approvals_confirmed_at?: string };
  };
}

export interface ConfigModel {
  kind: 'ollama' | 'openai-compatible' | 'hosted';
  name: string;
  base_url?: string;
  provider?: string; // a hosted model's provider, such as anthropic
  context_tokens?: number; // what a local server was started with
  max_context?: number; // Ollama: the most context primerkit may ask for
  format?: 'json' | 'markdown'; // the packet format the fitness check proposed
  fitness?: { verdict: string; reason: string; checked_at: string };
}

export function configPath(home: string): string {
  return join(home, 'config.yaml');
}

export function readConfig(home: string): Config {
  const path = configPath(home);
  if (!existsSync(path)) return {};
  const parsed = parse(readFileSync(path, 'utf8')) as unknown;
  return parsed && typeof parsed === 'object' ? (parsed as Config) : {};
}

// Written whole through a temporary file, so a crash never leaves half a config.
export function writeConfig(home: string, config: Config): void {
  const path = configPath(home);
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, stringify(config));
  renameSync(tmp, path);
}
