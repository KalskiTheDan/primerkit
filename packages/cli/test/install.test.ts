import { execFile } from 'node:child_process';
import { mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const BIN = fileURLToPath(new URL('../bin/primerkit.js', import.meta.url));

// The command as a person runs it, with a home of its own and no --yes, so it only shows.
function run(args: string[], home: string): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    execFile(process.execPath, [BIN, ...args], { env: { ...process.env, HOME: home, USERPROFILE: home, PRIMERKIT_HOME: join(home, '.primerkit') }, timeout: 90_000 }, (error, out) =>
      resolve({ code: error ? Number((error as NodeJS.ErrnoException).code ?? 1) : 0, out }),
    );
  });
}

// Each test starts the command, node and tsx: on a busy machine that takes longer than
// vitest's default 5 seconds a test.
describe('primerkit uninstall, shown before it is made', { timeout: 200_000 }, () => {
  it('lists the steps that take primerkit out, not the ones that put it in', async () => {
    const home = mkdtempSync(join(tmpdir(), 'pk-cli-uninstall-'));
    const { code, out } = await run(['uninstall', '--host', 'claude-code'], home);
    expect(code).toBe(0);
    expect(out).toContain("Taking primerkit out of Claude Code makes these changes, each only where primerkit's part is found:");
    expect(out).toContain('  runs    claude mcp remove --scope user primerkit');
    expect(out).toContain(`  deletes ${join(home, '.claude', 'skills', 'primerkit-ask')}`);
    expect(out).not.toMatch(/mcp add|writes|undoes/);
    expect(out).toContain('Nothing was changed. Run the same command with --yes to make them.');
    // CONTROL: the install's own preview is the one that adds and writes.
    const put = await run(['install', '--host', 'claude-code'], home);
    expect(put.out).toContain('Putting primerkit into Claude Code makes these changes:');
    expect(put.out).toMatch(/runs {3}claude mcp add --scope user primerkit/);
    // Shown only: nothing was put in the home.
    expect(readdirSync(home)).not.toContain('.claude');
  });
});
