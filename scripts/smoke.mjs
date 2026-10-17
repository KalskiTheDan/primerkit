// The npm package as a person gets it: built, packed, installed into an empty folder, and
// run there, then run once more through npx from the tarball. A home folder and an npm
// cache of its own keep every run off this machine's own: nothing here changes an AI app,
// a scheduler or a key. It needs the network once, for the dependencies from npm.
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const WIN = process.platform === 'win32';
const work = mkdtempSync(join(tmpdir(), 'primerkit-smoke-'));
const home = join(work, 'home');
const app = join(work, 'app');
for (const dir of [home, app]) mkdirSync(dir, { recursive: true });
const env = {
  ...process.env,
  HOME: home,
  USERPROFILE: home,
  PRIMERKIT_HOME: join(home, '.primerkit'),
  PREREASON_API_KEY: '',
  PREREASON_CREDENTIALS_FILE: join(home, 'no-credentials.json'),
  npm_config_cache: join(work, 'npm-cache'),
  npm_config_audit: 'false',
  npm_config_fund: 'false',
  npm_config_update_notifier: 'false',
};
// npm and npx are .cmd files on Windows, which only a shell runs; there each argument is
// quoted, since a path here can hold a space.
const quote = (a) => (WIN && /[\s"]/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a);
const npm = (args, cwd) => execFileSync(WIN ? 'npm.cmd' : 'npm', args.map(quote), { cwd, env, encoding: 'utf8', shell: WIN });
const failures = [];
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok || !detail ? '' : `\n     ${detail.split('\n').slice(0, 6).join('\n     ')}`}`);
  if (!ok) failures.push(name);
};
const run = (command, args, options = {}) =>
  new Promise((resolve) => {
    const child = spawn(command, args, { env, cwd: options.cwd ?? app, shell: options.shell ?? false });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    if (options.input) child.stdin.end(options.input);
    else child.stdin.end();
    const timer = setTimeout(() => child.kill(), options.timeout ?? 120_000);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, out, err });
    });
  });

console.log(`working in ${work}`);
// With --tarball <path> nothing is built here: the tarball given is the one checked, as it
// was made, so a release candidate cut on one system can be checked on another.
const given = process.argv.includes('--tarball') ? process.argv[process.argv.indexOf('--tarball') + 1] : null;
let tarball;
if (given) {
  tarball = resolve(given);
  check('the tarball given is there', existsSync(tarball), tarball);
  if (!existsSync(tarball)) process.exit(1);
} else {
  execFileSync(process.execPath, [join(ROOT, 'scripts', 'build.mjs')], { stdio: 'inherit' });
  npm(['pack', join(ROOT, 'dist', 'package'), '--pack-destination', work], work);
  tarball = join(work, readdirSync(work).find((f) => f.endsWith('.tgz')));
  check('npm pack made the tarball', existsSync(tarball), tarball);
}

npm(['init', '-y'], app);
npm(['install', '--no-save', tarball], app);
const bin = join(app, 'node_modules', 'primerkit', 'bin', 'primerkit.js');
check('the package installs, with its bin', existsSync(bin), bin);
// The version this checkout would publish: the tarball, built here or given, must be it.
const version = JSON.parse(readFileSync(join(ROOT, 'packages', 'cli', 'package.json'), 'utf8')).version;

const v = await run(process.execPath, [bin, '--version']);
check(`--version says ${version}`, v.code === 0 && v.out.includes(version), v.out + v.err);

const asked = await run(process.execPath, [bin, 'ask', '--demo', 'Where does Bitcoin stand?']);
check('ask --demo answers from the saved briefings', asked.code === 0 && asked.out.trim().length > 200, asked.out + asked.err);

const handshake = [
  { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'smoke', version: '1' } } },
  { jsonrpc: '2.0', method: 'notifications/initialized' },
  { jsonrpc: '2.0', id: 2, method: 'tools/list' },
]
  .map((m) => JSON.stringify(m))
  .join('\n');
const served = await run(process.execPath, [bin, 'mcp', '--demo'], { input: `${handshake}\n`, timeout: 30_000 });
const replies = served.out.split('\n').filter(Boolean).map((l) => JSON.parse(l));
const tools = replies.find((r) => r.id === 2)?.result?.tools?.map((t) => t.name) ?? [];
check('the MCP server answers initialize and lists its tools', replies.find((r) => r.id === 1)?.result?.serverInfo?.version === version && tools.includes('prepare_operation') && tools.includes('submit_response'), served.out + served.err);

const installed = await run(process.execPath, [bin, 'install', '--host', 'lm-studio']);
check('install, from an installed package, starts the server with its own bin', installed.code === 0 && installed.out.includes(`${join('primerkit', 'bin', 'primerkit.js')} mcp`) && installed.out.includes('Nothing was changed'), installed.out + installed.err);

// npx is given the package and the command apart, and run from a folder with nothing
// installed in it. Given the tarball's own path as the command, npm takes it for a program
// to run, runs nothing, and still exits 0.
const away = join(work, 'away');
mkdirSync(away);
const npx = (args) => run(WIN ? 'npx.cmd' : 'npx', ['-y', `--package=${tarball}`, 'primerkit', ...args].map(quote), { shell: WIN, cwd: away, timeout: 300_000 });
const said = (r) => `exit ${r.code}\n${r.out}${r.err}`;
const fromNpx = await npx(['install', '--host', 'claude-code']);
const line = WIN ? `cmd.exe /c npx -y primerkit@${version} mcp` : `npx -y primerkit@${version} mcp`;
check('install, through npx, starts the server through npx at this version', fromNpx.code === 0 && fromNpx.out.includes(line), said(fromNpx));
const scheduled = await npx(['schedule', '08:00']);
check("schedule, through npx, refuses an entry npm's cache would break", scheduled.code !== 0 && scheduled.err.includes("npx's cache"), said(scheduled));

check('nothing was written outside the scratch home', !existsSync(join(home, '.claude')) && !existsSync(join(home, '.lmstudio')));
console.log(failures.length ? `\n${failures.length} failed.` : '\nAll passed.');
process.exitCode = failures.length ? 1 : 0;
