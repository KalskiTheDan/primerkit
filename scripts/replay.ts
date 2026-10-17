// The replay: a set of questions asked through primerkit as a person would ask them, in one
// session on a PreReason key and Claude Sonnet 5.5, under a spending cap: each answer's screen
// drawn, and a record of what was read, what came back and what it cost. For persona tests and
// for comparing with what other tools answered. Run with
// `npm run replay -- --set <questions.json> --out <name> --cap <dollars>`.
//
// A set is a JSON list of { id, question } (other fields are kept in the record). The session
// is cleared before each question, so each screen holds one answer. PreReason's reads are
// paced, and a question PreReason's rate limit refused is asked once more after a rest.
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeConfig } from '@primerkit/core';
import { Session, realDeps, screen, type Entry, type Key } from '@primerkit/session';
import { Purse, SONNET, refuseKeys, screenSvg } from './gallery';

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const COLUMNS = 100;
const ROWS = 40;
const PACE_MS = 45_000;
const REST_MS = 125_000;

export interface Asked {
  id: string;
  question: string;
  [field: string]: unknown;
}

export interface Replayed extends Asked {
  outcome: 'answered' | 'partial' | 'not answered' | 'failed' | 'stopped';
  read: string[];
  added: string[];
  skipped: string[];
  answer: string;
  background: string;
  dropped: string[];
  notes: string[];
  checks: string;
  tokens: number | null;
  seconds: number | null;
  usd: number;
  file: string | null;
}

const enter: Key = { name: 'enter' };
const typed = (text: string): Key[] => Array.from(text, (char): Key => ({ name: 'char', char }));
const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));
const slug = (s: string) => s.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').toLowerCase();

// What the newest entry of the feed says, as a record.
export function recordOf(asked: Asked, entry: Entry | undefined, usd: number, file: string | null): Replayed {
  const base: Replayed = { ...asked, outcome: 'failed', read: [], added: [], skipped: [], answer: '', background: '', dropped: [], notes: [], checks: '', tokens: null, seconds: null, usd, file };
  if (!entry) return base;
  if (entry.kind === 'answer') {
    const v = entry.view;
    return {
      ...base,
      outcome: v.partial ? 'partial' : 'answered',
      read: v.briefings,
      added: entry.added,
      skipped: entry.skipped,
      answer: v.sentences.map((s) => s.text).join(' '),
      background: (v.background ?? []).join(' '),
      dropped: v.dropped.map((d) => d.text),
      notes: entry.notes,
      checks: `${v.checks.passed} of ${v.checks.total}`,
      tokens: v.tokens,
      seconds: v.seconds,
    };
  }
  if (entry.kind === 'note') return { ...base, outcome: 'not answered', notes: [entry.text] };
  if (entry.kind === 'failed') return { ...base, outcome: 'failed', notes: [entry.message, ...(entry.detail ? [entry.detail] : [])] };
  return { ...base, notes: [`an entry of kind ${entry.kind}`] };
}

const cell = (s: string) => s.replace(/\|/g, '\\|').replace(/\n/g, ' ');

export function replayReadme(title: string, intro: string, rows: Replayed[]): string {
  const spent = rows.reduce((n, r) => n + r.usd, 0);
  const by = (o: Replayed['outcome']) => rows.filter((r) => r.outcome === o).length;
  return [
    `# ${title}`,
    '',
    intro,
    '',
    `${rows.length} questions: ${by('answered')} answered with every check passed, ${by('partial')} partly answered, ${by('not answered')} not answered (no briefing matched, or none could be read), ${by('failed')} failed, ${by('stopped')} not asked (the cap). Spent $${spent.toFixed(4)} at list.`,
    '',
    '| id | outcome | read | checks | tokens | seconds | cost |',
    '|---|---|---|---|---|---|---|',
    ...rows.map((r) => `| ${r.id} | ${r.outcome} | ${cell(r.read.join(', ') || '-')} | ${r.checks || '-'} | ${r.tokens ?? '-'} | ${r.seconds === null ? '-' : r.seconds.toFixed(1)} | $${r.usd.toFixed(4)} |`),
    '',
    ...rows.flatMap((r) => [
      `## ${r.id}`,
      '',
      `> ${r.question}`,
      '',
      `**${r.outcome}**${r.read.length ? `, from ${r.read.join(', ')}` : ''}${r.checks ? `, ${r.checks} checks passed` : ''}.`,
      '',
      ...(r.answer ? [r.answer, ''] : []),
      ...(r.background ? [`Background, not from the data: ${r.background}`, ''] : []),
      ...r.dropped.map((d) => `- Taken out: "${d}"`),
      ...r.notes.map((n) => `- ${n}`),
      ...(r.dropped.length || r.notes.length ? [''] : []),
      ...(r.file ? [`![${r.id}](${r.file})`, ''] : []),
    ]),
  ].join('\n');
}

async function main(): Promise<void> {
  const flag = (name: string) => {
    const i = process.argv.indexOf(name);
    return i < 0 ? undefined : process.argv[i + 1];
  };
  const setFile = flag('--set');
  const name = flag('--out');
  const cap = Number(flag('--cap') ?? 0);
  if (!setFile || !name) throw new Error('usage: npm run replay -- --set <questions.json> --out <name> --cap <dollars>');
  if (!(cap > 0)) throw new Error('a replay asks a paid model: it needs a spending cap, --cap <dollars>');
  const env = process.env;
  if (!env.PREREASON_API_KEY) throw new Error('the replay reads PreReason with the key in PREREASON_API_KEY, and none is set');
  if (!env.ANTHROPIC_API_KEY) throw new Error('the replay asks Claude Sonnet 5.5 with the key in ANTHROPIC_API_KEY, and none is set');
  const set = JSON.parse(readFileSync(setFile, 'utf8')) as Asked[];
  const out = join(ROOT, 'docs', 'gallery', 'replay', slug(name));
  mkdirSync(out, { recursive: true });
  for (const f of readdirSync(out)) if (f.endsWith('.svg')) rmSync(join(out, f));
  const home = mkdtempSync(join(tmpdir(), 'pk-replay-'));
  const purse = new Purse(cap);
  const realFetch = globalThis.fetch;
  const rows: Replayed[] = [];
  const svgs: string[] = [];
  try {
    writeConfig(home, { first_run_done_at: new Date().toISOString(), disclaimer_accepted_at: new Date().toISOString(), model: { kind: 'hosted', provider: 'anthropic', name: SONNET.model } });
    globalThis.fetch = purse.wrap(realFetch);
    const session = new Session(realDeps({ version: 'replay', env: { ...env, PRIMERKIT_HOME: home } }));
    session.resize(COLUMNS, ROWS);
    session.start();
    for (const [i, asked] of set.entries()) {
      if (!purse.canAsk()) {
        rows.push({ ...recordOf(asked, undefined, 0, null), outcome: 'stopped', notes: [`not asked: $${purse.spent.toFixed(4)} spent, and the dearest question so far would pass the cap of $${cap.toFixed(2)}`] });
        continue;
      }
      if (i) await sleep(PACE_MS);
      const before = purse.spent;
      for (let attempt = 0; attempt < 2; attempt++) {
        for (const k of [...typed('/clear'), enter, ...typed(asked.question), enter]) session.key(k);
        await session.idle();
        const last = session.state.feed.at(-1);
        const limited = last?.kind === 'failed' && /rate limit/i.test(`${last.message} ${last.detail ?? ''}`);
        if (!limited || attempt) break;
        console.log(`${asked.id}: PreReason's rate limit; asked again after a rest`);
        await sleep(REST_MS);
      }
      purse.asked(before);
      const lines = screen(session.state, false);
      const svg = screenSvg(lines, COLUMNS, ROWS, `${asked.id}: ${asked.question}`, true);
      const file = `${String(i + 1).padStart(2, '0')}-${slug(asked.id)}.svg`;
      writeFileSync(join(out, file), svg);
      svgs.push(svg);
      const row = recordOf(asked, session.state.feed.at(-1), purse.spent - before, file);
      rows.push(row);
      console.log(`${asked.id}: ${row.outcome}${row.read.length ? ` from ${row.read.join(', ')}` : ''}; $${row.usd.toFixed(4)}, $${purse.spent.toFixed(4)} in all`);
    }
    await session.idle();
    refuseKeys(svgs, [env.PREREASON_API_KEY, env.ANTHROPIC_API_KEY]);
    const at = new Date().toISOString().slice(0, 16).replace('T', ' ') + ' UTC';
    writeFileSync(join(out, 'results.json'), JSON.stringify(rows, null, 1));
    writeFileSync(join(out, 'README.md'), replayReadme(`Replay: ${name}`, `Asked through primerkit on ${at}, in one session on a PreReason key and Claude Sonnet 5.5 (${SONNET.model}), cleared before each question, under a cap of $${cap.toFixed(2)}. Drawn by \`npm run replay\`; each screen is the session's own at ${COLUMNS} by ${ROWS}.`, rows));
    console.log(`${rows.length} questions in ${out}; spent $${purse.spent.toFixed(4)} at list on ${purse.calls} calls`);
  } finally {
    globalThis.fetch = realFetch;
    rmSync(home, { recursive: true, force: true });
  }
}

// Run as a script (npm run replay), not when a test imports what it records with.
if (/replay\.ts$/.test(process.argv[1] ?? '')) await main();
