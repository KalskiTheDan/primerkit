import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { throughCmd, windowsProgram } from '@primerkit/core';
import { systemScheduler } from '../src/schedule';
import { BIN, DEMO_DATE, INSTALL, NPX_SCHEDULE, ROOT, clipboardPrograms, demoNextStep, installOf, linkOpener, mcpLaunch, rootOf, schedulerFor } from '../src/index';

// The outside-in scan of 2026-10-15: the demo ends one step from a free PreReason account.
describe('the step from the demo to live briefings', () => {
  it('names the command this copy answers to, and the free account it takes', () => {
    expect(demoNextStep('npx')).toEqual({
      done: `That was the demo: briefings PreReason saved on ${DEMO_DATE}, answered by the demo stand in.`,
      live: 'For live briefings, run npx primerkit connect prereason and sign in, or make a PreReason account (a free one reads the free briefings), at the link it shows. Then run npx primerkit.',
    });
    expect(demoNextStep('installed').live).toBe('For live briefings, run primerkit connect prereason and sign in, or make a PreReason account (a free one reads the free briefings), at the link it shows. Then run primerkit.');
    expect(demoNextStep('checkout').live).toBe('For live briefings, run npm start -- connect prereason and sign in, or make a PreReason account (a free one reads the free briefings), at the link it shows. Then run npm start.');
    // This checkout answers to npm start.
    expect(demoNextStep()).toEqual(demoNextStep('checkout'));
  });
});

describe('where primerkit runs from', () => {
  it('finds its own files from a checkout, and from a package npm installed', () => {
    expect(INSTALL).toBe('checkout');
    expect(BIN).toBe(join(ROOT, 'packages', 'cli', 'bin', 'primerkit.js'));
    // A package: the bundle in lib, the operations beside it.
    const pkg = mkdtempSync(join(tmpdir(), 'pk-package-'));
    mkdirSync(join(pkg, 'operations', 'ask'), { recursive: true });
    writeFileSync(join(pkg, 'operations', 'ask', 'operation.yaml'), 'id: ask\n');
    mkdirSync(join(pkg, 'lib'));
    expect(rootOf(join(pkg, 'lib'))).toBe(pkg);
    expect(installOf(pkg)).toBe('installed');
    expect(installOf('C:\\Users\\x\\AppData\\Local\\npm-cache\\_npx\\ab12cd\\node_modules\\primerkit')).toBe('npx');
    expect(installOf('/home/x/.npm/_npx/ab12cd/node_modules/primerkit')).toBe('npx');
  });

  it("tells an AI app to start the server through npx at this version only from npx's cache", () => {
    expect(mcpLaunch('0.1.0', 'checkout')).toEqual({ command: process.execPath, args: [BIN, 'mcp'] });
    expect(mcpLaunch('0.1.0', 'installed')).toEqual({ command: process.execPath, args: [BIN, 'mcp'] });
    expect(mcpLaunch('0.1.0', 'npx', 'linux')).toEqual({ command: 'npx', args: ['-y', 'primerkit@0.1.0', 'mcp'] });
    // cmd.exe by its full path, so the app does not look for it in the folder it starts in.
    expect(mcpLaunch('0.1.0', 'npx', 'win32')).toEqual({ command: windowsProgram('cmd.exe'), args: ['/c', 'npx', '-y', 'primerkit@0.1.0', 'mcp'] });
    expect(mcpLaunch('0.1.0', 'npx', 'win32').command).toMatch(/[\\/]System32[\\/]cmd\.exe$/);
  });

  it('starts each Windows helper by its full System32 path, never by a bare name the current folder could answer to', async () => {
    expect(windowsProgram('schtasks.exe', { SystemRoot: 'C:\\Windows' })).toBe(join('C:\\Windows', 'System32', 'schtasks.exe'));
    expect(windowsProgram('clip.exe', {})).toBe(join('C:\\Windows', 'System32', 'clip.exe'));
    // A SystemRoot that is no full path with its drive would point under the current folder.
    for (const root of ['.', 'Windows', '\\Windows', '']) expect(windowsProgram('schtasks.exe', { SystemRoot: root, windir: root })).toBe(join('C:\\Windows', 'System32', 'schtasks.exe'));
    expect(windowsProgram('schtasks.exe', { SystemRoot: '.', windir: 'D:\\Win' })).toBe(join('D:\\Win', 'System32', 'schtasks.exe'));
    expect(clipboardPrograms('win32')).toEqual([[windowsProgram('clip.exe'), []]]);
    expect(linkOpener('win32', 'https://example.com/')).toEqual([windowsProgram('rundll32.exe'), ['url.dll,FileProtocolHandler', 'https://example.com/']]);
    for (const [command] of [...clipboardPrograms('win32'), linkOpener('win32', 'https://example.com/')]) expect(command).toMatch(/[\\/]System32[\\/](clip|rundll32)\.exe$/);
    const started: string[] = [];
    const scheduler = systemScheduler('win32', async (command) => (started.push(command), { code: 1, stdout: '', stderr: '' }));
    expect(await scheduler.exists()).toBe(false);
    expect(await scheduler.remove()).toBe(false);
    expect(started.length).toBeGreaterThan(0);
    for (const command of started) expect(command).toMatch(/[\\/]System32[\\/]schtasks\.exe$/);
  });

  it('starts a command npm installed through cmd.exe by its full path, each argument reaching it as it was written', () => {
    const cmd = join('C:\\Windows', 'System32', 'cmd.exe');
    expect(throughCmd('npx', ['-y', '@prereason/mcp@^0.9.0', '--login'], { SystemRoot: 'C:\\Windows', ComSpec: 'C:\\elsewhere\\cmd.exe' })).toEqual({ command: cmd, args: ['/d', '/s', '/c', '"npx -y "@prereason/mcp@^0.9.0" --login"'] });
    expect(throughCmd('claude', ['mcp', 'add', 'primerkit', '--', 'C:\\Program Files\\nodejs\\node.exe', 'C:\\x\\primerkit.js'], {}).args[3]).toBe('"claude mcp add primerkit -- "C:\\Program Files\\nodejs\\node.exe" C:\\x\\primerkit.js"');
    for (const arg of ['a"b', '100%', 'a&b', 'a|b', 'a<b', 'a>b', 'a!b', 'a\nb']) expect(() => throughCmd('npx', [arg], {})).toThrow('through cmd.exe');
  });

  it.runIf(process.platform === 'win32')('Windows, live: a .cmd file started that way is handed the caret of a version range, which the shell option drops', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pk-cmd-'));
    writeFileSync(join(dir, 'show.cjs'), 'console.log(JSON.stringify(process.argv.slice(2)))\n');
    writeFileSync(join(dir, 'fake.cmd'), '@echo off\r\n"' + process.execPath + '" "%~dp0show.cjs" %*\r\n');
    const args = ['-y', '@prereason/mcp@^0.9.0', '--login'];
    const launch = throughCmd(join(dir, 'fake.cmd'), args);
    const handed = spawnSync(launch.command, launch.args, { encoding: 'utf8', windowsVerbatimArguments: true });
    expect(JSON.parse(handed.stdout)).toEqual(args);
    // CONTROL: through Node's shell option the same file is handed the range without its caret.
    const dropped = spawnSync('"' + join(dir, 'fake.cmd') + '"', args, { encoding: 'utf8', shell: true });
    expect(JSON.parse(dropped.stdout)).toEqual(['-y', '@prereason/mcp@0.9.0', '--login']);
  });

  it("adds no daily entry from npx's cache, where npm may clear the program it would run", async () => {
    await expect(schedulerFor('linux', 'npx').add({} as never)).rejects.toThrow(NPX_SCHEDULE);
  });
});
