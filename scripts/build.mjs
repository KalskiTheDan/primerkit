// Builds the npm package in dist/package: primerkit's TypeScript bundled into one file,
// lib/primerkit.mjs, with the files it reads at run time beside it, the way they sit in a
// checkout. The packages outside the workspace stay dependencies, at the ranges the
// workspace asks for. `npm pack dist/package` makes the tarball npm publishes.
import { build } from 'esbuild';
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'dist', 'package');
const read = (path) => JSON.parse(readFileSync(join(ROOT, path), 'utf8'));

async function buildPackage() {
  const workspace = read('package.json');
  const cli = read('packages/cli/package.json');
  const dependencies = {};
  for (const ws of workspace.workspaces) {
    for (const [name, range] of Object.entries(read(`${ws}/package.json`).dependencies ?? {})) {
      if (!name.startsWith('@primerkit/') && name !== 'tsx') dependencies[name] = range;
    }
  }

  rmSync(OUT, { recursive: true, force: true });
  await build({
    entryPoints: [join(ROOT, 'packages', 'cli', 'src', 'main.ts')],
    outfile: join(OUT, 'lib', 'primerkit.mjs'),
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    external: Object.keys(dependencies),
    legalComments: 'none',
    logLevel: 'warning',
  });

  // What the code reads at run time, where a checkout keeps it: the operations hold the
  // demo's saved briefings and catalog too. A test file is not among it.
  for (const path of ['operations', join('hosts', 'claude-code-plugin', 'skills'), 'README.md', 'LICENSE', 'NOTICE']) {
    cpSync(join(ROOT, path), join(OUT, path), { recursive: true, filter: (source) => !source.endsWith('.test.ts') });
  }
  mkdirSync(join(OUT, 'bin'), { recursive: true });
  writeFileSync(join(OUT, 'bin', 'primerkit.js'), "#!/usr/bin/env node\n// primerkit's command, from the bundle built for npm.\nimport '../lib/primerkit.mjs';\n");

  const pkg = {
    name: 'primerkit',
    version: cli.version,
    description: 'Market work at agent speed: from idea to action. Open source.',
    // The MCP Registry lists an npm server only when its package names the registry entry.
    mcpName: 'io.github.KalskiTheDan/primerkit',
    license: 'Apache-2.0',
    type: 'module',
    bin: { primerkit: 'bin/primerkit.js' },
    engines: workspace.engines,
    repository: { type: 'git', url: 'git+https://github.com/KalskiTheDan/primerkit.git' },
    homepage: 'https://github.com/KalskiTheDan/primerkit#readme',
    bugs: { url: 'https://github.com/KalskiTheDan/primerkit/issues' },
    keywords: ['mcp', 'mcp-server', 'llm', 'local-llm', 'ollama', 'claude-code', 'codex', 'gemini-cli', 'macro', 'market-research', 'bitcoin'],
    dependencies,
    files: ['bin', 'lib', 'operations', 'hosts', 'README.md', 'LICENSE', 'NOTICE'],
  };
  writeFileSync(join(OUT, 'package.json'), `${JSON.stringify(pkg, null, 2)}\n`);
  return { out: OUT, version: pkg.version, dependencies };
}

const { out, version } = await buildPackage();
console.log(`primerkit ${version} built in ${out}`);
