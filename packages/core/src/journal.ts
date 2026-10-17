import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

// The journal is local and append only. Each run gets one
// folder, and a file once written is never written again: every write fails if the
// file exists. Nothing in the journal leaves the machine.
export class Journal {
  constructor(readonly root: string) {}

  runDir(operationId: string, runId: string, now = new Date()): string {
    const day = now.toISOString().slice(0, 10);
    return join(this.root, day, operationId, runId);
  }

  open(operationId: string, runId: string, now = new Date()): JournalRun {
    const dir = this.runDir(operationId, runId, now);
    mkdirSync(dir, { recursive: true });
    return new JournalRun(dir);
  }
}

export class JournalRun {
  constructor(readonly dir: string) {}

  write(name: string, content: string | object): void {
    const body = typeof content === 'string' ? content : JSON.stringify(content, null, 2) + '\n';
    writeFileSync(join(this.dir, name), body, { flag: 'wx' });
  }
}

// One finished run as its meta.json keeps it, in the keys a script reads. tokens.packet is
// the tokenizer's count of the packet; the rest are the model's own reported counts, null
// where the runtime reported none (a run answered inside an AI app reports none to primerkit).
export interface JournalEntry {
  run_id: string;
  day: string;
  operation: string;
  outcome: string | null;
  model: string | null;
  host: boolean; // answered by the model of an AI app, through primerkit's server
  tokens: { packet: number | null; input: number | null; output: number | null; cache_read: number | null; cache_write: number | null };
  cost: { usd: number; basis: 'list price' | 'local' } | null;
  question: string | null; // the question the packet carried, where it carried one
  briefings: string[]; // the briefings and metrics it read, by id
  dir: string;
}

// What to find in the journal. Every field given must match: the operation (routine matches
// every routine's runs), a briefing or metric id the run read, the outcome, the day, and words
// in its question or its answer as kept.
export interface JournalQuery {
  operation?: string;
  briefing?: string;
  outcome?: string;
  day?: string; // YYYY-MM-DD
  text?: string;
}

export const JOURNAL_OPERATIONS = ['ask', 'digest', 'bench', 'backtest', 'routine', 'compare', 'model-check', 'intent'] as const;
export const JOURNAL_OUTCOMES = ['passed', 'partial', 'failed', 'refused', 'pending'] as const;

// "/journal failed macro.snapshot 2026-10-16 yields" as a query: an operation's name, an
// outcome, a day and an id are read as such; the other words are the text to look for.
export function parseJournalQuery(words: string): JournalQuery {
  const q: JournalQuery = {};
  const text: string[] = [];
  for (const word of words.trim().split(/\s+/).filter(Boolean)) {
    const w = word.toLowerCase();
    if (!q.operation && (JOURNAL_OPERATIONS as readonly string[]).includes(w)) q.operation = w;
    else if (!q.outcome && (JOURNAL_OUTCOMES as readonly string[]).includes(w)) q.outcome = w;
    else if (!q.day && /^\d{4}-\d{2}-\d{2}$/.test(w)) q.day = w;
    else if (!q.briefing && /^[a-z0-9]+([.-][a-z0-9]+)+(\/[a-z0-9.-]+)?$/.test(w) && /[.-]/.test(w)) q.briefing = w;
    else text.push(word);
  }
  if (text.length) q.text = text.join(' ');
  return q;
}

export const queryWords = (q: JournalQuery): string => [q.operation, q.outcome, q.day, q.briefing, q.text ? `"${q.text}"` : undefined].filter(Boolean).join(' ');

export function operationMatches(operation: string, wanted: string): boolean {
  return wanted === 'routine' ? operation.startsWith('routine.') || operation === 'routine' : operation === wanted;
}

// The run's question and the briefings it read, from its packet.json.
export function packetFacts(dir: string): { question: string | null; briefings: string[] } {
  try {
    const p = JSON.parse(readFileSync(join(dir, 'packet.json'), 'utf8')) as { question?: unknown; blocks?: Array<{ id?: unknown }> };
    return { question: typeof p.question === 'string' ? p.question : null, briefings: (p.blocks ?? []).map((b) => b.id).filter((id): id is string => typeof id === 'string') };
  } catch {
    return { question: null, briefings: [] };
  }
}

// Whether one run matches a query. Only the files a field needs are read.
export function runMatches(run: { day: string; operation: string; outcome: string | null; dir: string; question?: string | null; briefings?: string[] }, q: JournalQuery): boolean {
  if (q.day && run.day !== q.day) return false;
  if (q.operation && !operationMatches(run.operation, q.operation)) return false;
  if (q.outcome && run.outcome !== q.outcome) return false;
  const facts = q.briefing || q.text ? (run.briefings && run.question !== undefined ? { question: run.question, briefings: run.briefings } : packetFacts(run.dir)) : null;
  if (q.briefing && !facts?.briefings.some((b) => b === q.briefing || b.startsWith(`${q.briefing}/`))) return false;
  if (q.text) {
    const words = q.text.toLowerCase().split(/\s+/).filter(Boolean);
    let kept = facts?.question ?? '';
    try {
      kept += `\n${readFileSync(join(run.dir, 'render.md'), 'utf8')}`;
    } catch {
      // A run that kept no view is read by its question alone.
    }
    const hay = kept.toLowerCase();
    if (!words.every((w) => hay.includes(w))) return false;
  }
  return true;
}

// The days the journal holds, newest first.
const DAY = /^\d{4}-\d{2}-\d{2}$/;
function days(root: string): string[] {
  try {
    return readdirSync(root).filter((d) => DAY.test(d)).sort().reverse();
  } catch {
    return [];
  }
}

function subdirs(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
  } catch {
    return [];
  }
}

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

function entryOf(day: string, operation: string, dir: string, meta: Record<string, unknown>): JournalEntry {
  const usage = meta.usage && typeof meta.usage === 'object' ? (meta.usage as Record<string, unknown>) : null;
  const reported = usage?.reported === true;
  const count = (key: string) => (reported ? num(usage?.[key]) : null);
  const cost = meta.cost && typeof meta.cost === 'object' ? (meta.cost as { usd?: unknown; basis?: unknown }) : null;
  return {
    run_id: typeof meta.runId === 'string' ? meta.runId : (dir.split(/[\\/]/).pop() ?? ''),
    day,
    operation,
    outcome: typeof meta.outcome === 'string' ? meta.outcome : null,
    model: typeof meta.model === 'string' ? meta.model : null,
    host: meta.host === true,
    tokens: { packet: num((meta.tokens as { count?: unknown } | undefined)?.count), input: count('inputTokens'), output: count('outputTokens'), cache_read: count('cacheReadTokens'), cache_write: count('cacheWriteTokens') },
    cost: cost && num(cost.usd) !== null && (cost.basis === 'list price' || cost.basis === 'local') ? { usd: cost.usd as number, basis: cost.basis } : null,
    ...packetFacts(dir),
    dir,
  };
}

// Every finished run in the journal, newest day first: the folders with a meta.json. An
// order intent's folder, which keeps no meta.json, is not a run and is left out. A query keeps
// the runs that match it.
export function journalEntries(root: string, opts: { limit?: number; day?: string; query?: JournalQuery } = {}): JournalEntry[] {
  const out: JournalEntry[] = [];
  const day1 = opts.day ?? opts.query?.day;
  for (const day of days(root)) {
    if (day1 && day !== day1) continue;
    const found: JournalEntry[] = [];
    for (const operation of subdirs(join(root, day))) {
      for (const run of subdirs(join(root, day, operation))) {
        const dir = join(root, day, operation, run);
        const file = join(dir, 'meta.json');
        if (!existsSync(file)) continue;
        let entry: JournalEntry;
        try {
          entry = entryOf(day, operation, dir, JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>);
        } catch {
          continue; // A meta.json that cannot be read is not counted.
        }
        if (!opts.query || runMatches(entry, opts.query)) found.push(entry);
      }
    }
    // Run ids begin with their time, so they sort newest first within the day.
    out.push(...found.sort((a, b) => b.run_id.localeCompare(a.run_id)));
    if (opts.limit && out.length >= opts.limit) return out.slice(0, opts.limit);
  }
  return out;
}

// One day of the journal in sums: its runs by outcome, their tokens and what they cost where
// that is known. priced counts the runs a cost is known for; a run with none adds nothing to
// usd and is counted in unpriced, so the sum never stands for more than it is.
export interface JournalDay {
  day: string;
  runs: number;
  outcomes: Record<string, number>;
  tokens: { packet: number; input: number; output: number; cache_read: number; cache_write: number; reported_runs: number };
  cost: { usd: number; priced_runs: number; unpriced_runs: number };
}

export function journalSummary(root: string, opts: { days?: number; query?: JournalQuery } = {}): JournalDay[] {
  const byDay = new Map<string, JournalDay>();
  for (const e of journalEntries(root, opts.query ? { query: opts.query } : {})) {
    let d = byDay.get(e.day);
    if (!d) {
      if (opts.days && byDay.size >= opts.days) break;
      d = { day: e.day, runs: 0, outcomes: {}, tokens: { packet: 0, input: 0, output: 0, cache_read: 0, cache_write: 0, reported_runs: 0 }, cost: { usd: 0, priced_runs: 0, unpriced_runs: 0 } };
      byDay.set(e.day, d);
    }
    d.runs += 1;
    const outcome = e.outcome ?? 'unknown';
    d.outcomes[outcome] = (d.outcomes[outcome] ?? 0) + 1;
    d.tokens.packet += e.tokens.packet ?? 0;
    if (e.tokens.input !== null || e.tokens.output !== null) {
      d.tokens.reported_runs += 1;
      d.tokens.input += e.tokens.input ?? 0;
      d.tokens.output += e.tokens.output ?? 0;
      d.tokens.cache_read += e.tokens.cache_read ?? 0;
      d.tokens.cache_write += e.tokens.cache_write ?? 0;
    }
    if (e.cost) {
      d.cost.priced_runs += 1;
      d.cost.usd = Math.round((d.cost.usd + e.cost.usd) * 1e6) / 1e6;
    } else d.cost.unpriced_runs += 1;
  }
  return [...byDay.values()];
}

// One run read back whole, for the screen, the command line and an AI app: its question, the
// answer it kept (or a routine's label and reason), each claim with the text of every line it
// cites, each check passed or failed, and its tokens and cost. Read only.
export interface JournalRunView {
  run_id: string;
  day: string;
  operation: string;
  outcome: string | null;
  model: string | null;
  question: string | null;
  answer: string | null;
  label: string | null; // a routine's label: the rule that fired, by its own word
  reason: string | null;
  claims: Array<{ text: string; citations: Array<{ block: string; line: number; quote: string; line_text: string | null }> }>;
  not_in_data: string[];
  checks: Array<{ id: string; passed: boolean; failures: string[] }>;
  attempts: number | null;
  dropped: number | null;
  tokens: JournalEntry['tokens'];
  cost: JournalEntry['cost'];
  view: string | null; // render.md, as the person read it
}

function readJsonFile<T>(path: string): T | null {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T;
  } catch {
    return null;
  }
}

export function journalRun(dir: string): JournalRunView | null {
  const meta = readJsonFile<Record<string, unknown>>(join(dir, 'meta.json'));
  if (!meta) return null;
  const entry = entryOf(basename(dirname(dirname(dir))), basename(dirname(dir)), dir, meta);
  const packet = readJsonFile<{ blocks?: Array<{ id: string; lines: string[]; numbers?: number[] }> }>(join(dir, 'packet.json'));
  const lineOf = (block: string, line: number): string | null => {
    const b = packet?.blocks?.find((x) => x.id === block);
    if (!b) return null;
    const at = b.numbers ? b.numbers.indexOf(line) : line - 1;
    return at >= 0 ? (b.lines[at] ?? null) : null;
  };
  // The last reply the model gave: the repair where there was one.
  const reply = readJsonFile<{ text?: string }>(join(dir, 'response.repair.json')) ?? readJsonFile<{ text?: string }>(join(dir, 'response.json'));
  let said: Record<string, unknown> | null = null;
  try {
    const text = (reply?.text ?? '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
    said = text ? (JSON.parse(text) as Record<string, unknown>) : null;
  } catch {
    said = null;
  }
  const str = (v: unknown) => (typeof v === 'string' ? v : null);
  const rawClaims = Array.isArray(said?.claims) ? (said.claims as Array<Record<string, unknown>>) : [];
  const claims = rawClaims.map((c) => ({
    text: String(c.text ?? ''),
    citations: (Array.isArray(c.citations) ? (c.citations as Array<Record<string, unknown>>) : []).map((x) => {
      const block = String(x.block ?? '');
      const line = Number(x.line);
      return { block, line, quote: String(x.quote ?? ''), line_text: Number.isInteger(line) ? lineOf(block, line) : null };
    }),
  }));
  const checks = (readJsonFile<Array<{ id: string; failures?: Array<{ message?: string }> }>>(join(dir, 'checks.json')) ?? []).map((c) => ({ id: c.id, passed: !(c.failures ?? []).length, failures: (c.failures ?? []).map((f) => String(f.message ?? '')) }));
  let view: string | null = null;
  try {
    view = readFileSync(join(dir, 'render.md'), 'utf8');
  } catch {
    view = null;
  }
  return {
    run_id: entry.run_id,
    day: entry.day,
    operation: entry.operation,
    outcome: entry.outcome,
    model: entry.model,
    question: entry.question,
    answer: str(said?.answer),
    label: str(said?.label),
    reason: str(said?.reason),
    claims,
    not_in_data: Array.isArray(said?.not_in_data) ? (said.not_in_data as unknown[]).map(String) : [],
    checks,
    attempts: num(meta.attempts),
    dropped: num(meta.dropped),
    tokens: entry.tokens,
    cost: entry.cost,
    view,
  };
}

const thousands = (n: number) => n.toLocaleString('en-US');

// What a run's tokens and cost come to, in words.
export function spentWords(tokens: JournalEntry['tokens'], cost: JournalEntry['cost']): string {
  const reported = tokens.input !== null || tokens.output !== null ? `${thousands(tokens.input ?? 0)} in, ${thousands(tokens.output ?? 0)} out, as the model reported` : 'no tokens reported';
  const packet = tokens.packet !== null ? `the packet ${thousands(tokens.packet)} tokens; ` : '';
  const usd = cost ? (cost.basis === 'local' ? 'nothing, on this machine' : `$${cost.usd.toFixed(4)} at list price`) : 'no cost known';
  return `${packet}${reported}; ${usd}`;
}

// A run as the screen and the command line show it.
export function journalRunLines(run: JournalRunView): string[] {
  const lines = [`${run.operation}, ${run.run_id}, ${run.outcome ?? 'no outcome'}${run.attempts && run.attempts > 1 ? ', after a repair turn' : ''}`];
  if (run.question) lines.push('', `Question: ${run.question}`);
  if (run.label) lines.push('', `Label: ${run.label}`, ...(run.reason ? [`Reason: ${run.reason}`] : []));
  else if (run.answer) lines.push('', `Answer: ${run.answer}`);
  const cited = run.claims.flatMap((c) => c.citations);
  if (cited.length) {
    lines.push('', 'The lines it cites:');
    for (const c of cited) lines.push(`  [${c.block} L${c.line}] ${c.line_text ?? c.quote}`);
  }
  if (run.not_in_data.length) lines.push('', `Not in the data: ${run.not_in_data.join('; ')}`);
  if (run.dropped) lines.push('', `${run.dropped} ${run.dropped === 1 ? 'claim was' : 'claims were'} taken out after the checks.`);
  if (run.checks.length) {
    lines.push('', 'Checks:');
    for (const c of run.checks) lines.push(`  ${c.passed ? 'ok' : 'x '} ${c.id}${c.failures.length ? `: ${c.failures.join('; ')}` : ''}`);
  }
  lines.push('', `Spent: ${spentWords(run.tokens, run.cost)}.`, `Model: ${run.model ?? 'not recorded'}.`);
  return lines;
}

// What one run spent, from its meta.json alone; null where it kept none.
export function runSpend(dir: string): { tokens: JournalEntry['tokens']; cost: JournalEntry['cost'] } | null {
  const meta = readJsonFile<Record<string, unknown>>(join(dir, 'meta.json'));
  if (!meta) return null;
  const e = entryOf(basename(dirname(dirname(dir))), basename(dirname(dir)), dir, meta);
  return { tokens: e.tokens, cost: e.cost };
}
