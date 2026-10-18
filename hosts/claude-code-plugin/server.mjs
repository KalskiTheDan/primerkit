#!/usr/bin/env node
// Starts primerkit's local MCP server for Claude Code. A plugin installed from a
// marketplace is copied on its own, without primerkit beside it, so the server comes from
// npm at the version this plugin was released with. On Windows npx is a .cmd file, which
// only cmd.exe runs: cmd.exe is started by its full path, never through Node's shell
// option, which starts ComSpec or the bare name cmd.exe. SystemRoot counts only as a full
// path with its drive.
import { spawn } from 'node:child_process';
import { join } from 'node:path';

const VERSION = '0.1.1';

const npx = ['npx', '-y', `primerkit@${VERSION}`, 'mcp'];
const root = [process.env.SystemRoot, process.env.windir].find((v) => v !== undefined && /^[A-Za-z]:[\\/]/.test(v)) ?? 'C:\\Windows';
const child =
  process.platform === 'win32'
    ? spawn(join(root, 'System32', 'cmd.exe'), ['/d', '/s', '/c', `"${npx.join(' ')}"`], { stdio: 'inherit', windowsVerbatimArguments: true })
    : spawn(npx[0], npx.slice(1), { stdio: 'inherit' });
child.on('error', (error) => {
  process.stderr.write(`primerkit could not start: ${error.message}\n`);
  process.exit(1);
});
child.on('exit', (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
