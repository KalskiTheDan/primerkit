import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// What npm and Claude Code are given: the package built from this checkout, and the
// plugin the repository lists as its own marketplace.

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const json = (path: string) => JSON.parse(readFileSync(join(ROOT, path), 'utf8')) as Record<string, any>;
const VERSION = json('packages/cli/package.json').version as string;

describe('the release', () => {
  it('names one version everywhere a release carries it', () => {
    expect(json('hosts/claude-code-plugin/.claude-plugin/plugin.json').version).toBe(VERSION);
    expect(readFileSync(join(ROOT, 'hosts', 'claude-code-plugin', 'server.mjs'), 'utf8')).toContain(`const VERSION = '${VERSION}';`);
  });

  it("lists the plugin in the repository's marketplace by the name its manifest gives, starting its server from npm", () => {
    const market = json('.claude-plugin/marketplace.json');
    expect(market.plugins).toHaveLength(1);
    const entry = market.plugins[0] as { name: string; source: string };
    expect(entry.source).toMatch(/^\.\/[a-z]/);
    expect(json(join(entry.source, '.claude-plugin', 'plugin.json')).name).toBe(entry.name);
    expect(json(join(entry.source, '.mcp.json')).mcpServers.primerkit).toEqual({ command: 'node', args: ['${CLAUDE_PLUGIN_ROOT}/server.mjs'] });
  });

  it('bundles into one file that runs from its package folder, reading the files beside it', () => {
    execFileSync(process.execPath, [join(ROOT, 'scripts', 'build.mjs')], { encoding: 'utf8' });
    const pkg = join(ROOT, 'dist', 'package');
    const manifest = JSON.parse(readFileSync(join(pkg, 'package.json'), 'utf8')) as Record<string, any>;
    expect(manifest).toMatchObject({ name: 'primerkit', version: VERSION, license: 'Apache-2.0', bin: { primerkit: 'bin/primerkit.js' } });
    expect(Object.keys(manifest.dependencies).sort()).toEqual(['@resvg/resvg-js', 'ajv', 'gpt-tokenizer', 'yaml']);
    for (const path of ['lib/primerkit.mjs', 'operations/ask/operation.yaml', 'hosts/claude-code-plugin/skills/ask/SKILL.md', 'LICENSE', 'NOTICE']) expect(existsSync(join(pkg, path)), path).toBe(true);
    expect(existsSync(join(pkg, 'notes'))).toBe(false);
    // The saved briefings ship, and the test file beside them does not.
    expect(existsSync(join(pkg, 'operations', 'bench-comprehension', 'briefings-2026-09-25', 'btc.pulse.md'))).toBe(true);
    expect(existsSync(join(pkg, 'operations', 'ask', 'tests', 'ask.test.ts'))).toBe(false);
    const env = { ...process.env, NO_COLOR: '1', PRIMERKIT_HOME: join(pkg, '.no-home'), PREREASON_API_KEY: '' };
    const bin = join(pkg, 'bin', 'primerkit.js');
    expect(execFileSync(process.execPath, [bin, '--version'], { encoding: 'utf8', env })).toContain(VERSION);
    const answer = execFileSync(process.execPath, [bin, 'ask', '--demo', 'Where does Bitcoin stand?'], { encoding: 'utf8', env });
    expect(answer.length).toBeGreaterThan(200);
  }, 180_000);
});
