import { spawn as nodeSpawn, spawnSync } from 'node:child_process';
import { throughCmd, windowsProgram } from '@primerkit/core';

// Connecting PreReason goes through PreReason's own bridge, which prints one approval
// link, polls, and saves the key to its credentials file; primerkit never holds the
// claim token. PREREASON_CLIENT names primerkit, so the approval page says which app
// asked.

export const CLAIM_LINK = /https:\/\/\S+\/claim\/PR-[A-Z0-9]{4}-[A-Z0-9]{4}/;

export type ClaimEvent =
  | { kind: 'link'; url: string }
  | { kind: 'approved' }
  | { kind: 'ended'; approved: boolean; message: string };

export interface ClaimOptions {
  env?: Record<string, string | undefined>;
  // Injected in tests; defaults to running `npx -y @prereason/mcp --login`.
  spawn?: (command: string, args: string[], env: Record<string, string | undefined>) => ClaimProcess;
}

export interface ClaimProcess {
  onLine(listener: (line: string) => void): void;
  onExit(listener: (code: number | null) => void): void;
  kill(): void;
}

// How the bridge is started: by its name, and on Windows through cmd.exe, since npx is a
// .cmd file there. verbatim: the arguments go to the program as they are written.
export function claimLaunch(command: string, args: string[], platform: NodeJS.Platform = process.platform, env: Record<string, string | undefined> = process.env): { command: string; args: string[]; verbatim: boolean } {
  return platform === 'win32' ? { ...throughCmd(command, args, env), verbatim: true } : { command, args, verbatim: false };
}

// On Windows the bridge runs under cmd.exe, with npx's node under that and the bridge under
// npx: ending cmd.exe alone leaves the bridge polling, free to save a key after the person
// has quit. So the whole tree is ended there, by taskkill, while cmd.exe still stands to
// find it by, and before the call returns. Elsewhere npx passes the signal on to the bridge.
type Run = (command: string, args: string[]) => { status: number | null; error?: Error };
const runAndWait: Run = (command, args) => spawnSync(command, args, { stdio: 'ignore', windowsHide: true });

export function endTree(child: { pid?: number | undefined; exitCode: number | null; signalCode: NodeJS.Signals | null; kill(): boolean }, platform: NodeJS.Platform = process.platform, env: Record<string, string | undefined> = process.env, run: Run = runAndWait): void {
  // Ended already: its number may belong to another process by now.
  if (child.exitCode !== null || child.signalCode !== null) return;
  if (platform === 'win32' && child.pid) {
    const ended = run(windowsProgram('taskkill.exe', env), ['/pid', String(child.pid), '/T', '/F']);
    if (!ended.error && ended.status === 0) return;
  }
  child.kill();
}

// Starts the bridge, or for a test any program in its place, and reads its lines.
export function spawnBridge(command: string, args: string[], env: Record<string, string | undefined>): ClaimProcess {
  const launch = claimLaunch(command, args, process.platform, env);
  const child = nodeSpawn(launch.command, launch.args, { env, windowsVerbatimArguments: launch.verbatim, stdio: ['ignore', 'ignore', 'pipe'] });
  let buffer = '';
  const lineListeners: Array<(line: string) => void> = [];
  child.stderr?.on('data', (chunk: Buffer) => {
    buffer += chunk.toString('utf8');
    let at: number;
    while ((at = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, at).trim();
      buffer = buffer.slice(at + 1);
      for (const l of lineListeners) l(line);
    }
  });
  return {
    onLine: (l) => lineListeners.push(l),
    onExit: (l) => child.on('exit', (code) => l(code)),
    kill: () => endTree(child, process.platform, env),
  };
}

// The bridge's current version. Without a version, npx can run an older copy from its cache,
// which may have no --login and exit at once; and a caret range below 1.0 stays within its
// minor version (^0.5.0 never fetches 0.9.0), so the range names the current minor.
export const BRIDGE = '@prereason/mcp@^0.9.0';

// Runs the bridge's login and reports what it says: the link to open, then how it ended.
// Only the bridge's own words count as approval, never its exit code alone.
export function connectPreReason(onEvent: (event: ClaimEvent) => void, options: ClaimOptions = {}): { cancel: () => void } {
  const env = { ...(options.env ?? process.env), PREREASON_CLIENT: 'primerkit' };
  const run = options.spawn ?? spawnBridge;
  const proc = run('npx', ['-y', BRIDGE, '--login'], env);
  let approved = false;
  let linked = false;
  let last = '';
  proc.onLine((line) => {
    if (!line) return;
    last = line;
    const link = CLAIM_LINK.exec(line);
    if (link) {
      linked = true;
      onEvent({ kind: 'link', url: link[0] });
    }
    if (/access approved/i.test(line) || /already configured/i.test(line)) {
      approved = true;
      onEvent({ kind: 'approved' });
    }
  });
  proc.onExit((code) => {
    const message = approved || linked || last ? last : `the bridge ended without starting a claim (exit ${code ?? 'unknown'})`;
    onEvent({ kind: 'ended', approved, message });
  });
  return { cancel: () => proc.kill() };
}
