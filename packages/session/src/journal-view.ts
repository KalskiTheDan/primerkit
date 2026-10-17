import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { intentTitle, journalRun, journalRunLines, readIntent, readLiveIntent, runMatches, type JournalQuery } from '@primerkit/core';
import { DAY_FOLDER, dayText, tickTitle } from './journal-find';
import type { FitnessResult } from '@primerkit/models';
import { fitnessLines } from '@primerkit/models';
import type { DigestView } from './digest';
import type { JournalRow } from './state';

// Reading the journal back: every run on this machine, newest first, and one run's
// rendered view. The journal is read, never changed.

export const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const dirs = (path: string): string[] => (existsSync(path) ? readdirSync(path).filter((d) => statSync(join(path, d)).isDirectory()) : []);

function readJson<T>(path: string): T | null {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T;
  } catch {
    return null;
  }
}

// "20260926T143112Z-1a2b3c" as a day and a UTC time.
function stampOf(runId: string, day: string): { day: string; time: string } {
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})/.exec(runId);
  const [y, mo, d] = day.split('-').map(Number) as [number, number, number];
  return { day: `${String(d).padStart(2, ' ')} ${MONTHS[(m ? Number(m[2]) : mo) - 1] ?? ''}`.trim() || `${y}`, time: m ? `${m[4]}:${m[5]}` : '' };
}

// now: the time an intent's state is read at, as an intent expires by the clock.
// query: only the runs that match it (journalRows(root, 200, now, { outcome: 'failed' })).
export function journalRows(root: string, limit = 200, now = new Date(), query?: JournalQuery): JournalRow[] {
  const rows: Array<JournalRow & { sort: string }> = [];
  for (const day of dirs(root).sort().reverse()) {
    for (const op of dirs(join(root, day))) {
      for (const run of dirs(join(root, day, op))) {
        const dir = join(root, day, op, run);
        const when = stampOf(run, day);
        let title = run;
        let outcome = '';
        if (op === 'digest') {
          if (!run.endsWith('-summary')) continue; // one row per digest, not per packet
          const view = readJson<DigestView>(join(dir, 'digest.json'));
          const n = view?.changes.length ?? 0;
          title = view?.since ? `${n === 1 ? '1 change' : `${n} changes`} since ${view.since}` : 'first digest';
        } else if (op === 'model-check') {
          const result = readJson<FitnessResult>(join(dir, 'result.json'));
          title = result?.model ?? run;
          outcome = result?.verdict ?? '';
        } else if (op === 'intent') {
          // An order intent: what it does, and the state its folder's files record.
          try {
            const record = readIntent(dir, now);
            title = intentTitle(record.intent);
            outcome = record.state;
          } catch {
            // an intent folder still being written
          }
        } else if (op === 'live-intent') {
          // A Robinhood intent the trade skill recorded: its order, and whether it is approved.
          try {
            const record = readLiveIntent(dir, now);
            title = `${record.intent.side} ${record.intent.quantity} ${record.intent.symbol}, Robinhood live`;
            outcome = record.state;
          } catch {
            // an intent folder still being written
          }
        } else if (op === 'compare') {
          const record = readJson<{ question?: string }>(join(dir, 'compare.json'));
          const meta = readJson<{ outcome?: string }>(join(dir, 'meta.json'));
          title = record?.question ?? run;
          outcome = meta?.outcome ?? '';
        } else if (op === 'bench') {
          const result = readJson<{ model?: string; answers?: number }>(join(dir, 'result.json'));
          title = result?.model ? `${result.model}, ${result.answers ?? 0} answers` : run;
        } else {
          const packet = readJson<{ question?: string }>(join(dir, 'packet.json'));
          const meta = readJson<{ outcome?: string }>(join(dir, 'meta.json'));
          title = packet?.question ?? run;
          // Prepared inside an AI app and not answered yet.
          outcome = meta?.outcome ?? (existsSync(join(dir, 'pending.json')) ? 'pending' : '');
          // A routine's tick reads as the label that fired and the reading it cites first.
          if (op.startsWith('routine.') && meta) title = tickTitle(dir) ?? title;
        }
        if (query && !runMatches({ day, operation: op, outcome, dir }, query)) continue;
        rows.push({ ...when, operation: op, title, outcome, dir, sort: `${day}${run}` });
      }
    }
  }
  return rows
    .sort((a, b) => b.sort.localeCompare(a.sort))
    .slice(0, limit)
    .map(({ sort: _sort, ...row }) => row);
}

// One run's folder by its id, in any day and under any operation, or null. The id must be
// checked before it comes here: it is joined into a path.
export function journalFind(root: string, runId: string): string | null {
  for (const day of dirs(root).sort().reverse()) {
    for (const op of dirs(join(root, day))) {
      const dir = join(root, day, op, runId);
      if (existsSync(dir) && statSync(dir).isDirectory()) return dir;
    }
  }
  return null;
}

export function journalOpen(dir: string): { title: string; text: string } {
  const op = basename(join(dir, '..'));
  const title = `${op}, ${basename(dir)}`;
  // A day's summary row opens to that day's sums.
  if (DAY_FOLDER.test(basename(dir))) return { title: `the journal, ${basename(dir)}`, text: dayText(dirname(dir), basename(dir)).join('\n') };
  // A run opens to the view as it was read, then everything the journal keeps of it: its
  // question, its answer or label, each line it cites in full, each check and what it spent.
  const run = existsSync(join(dir, 'packet.json')) ? journalRun(dir) : null;
  if (run) return { title, text: [...(run.view ? [run.view.trimEnd(), '', 'The run, as the journal keeps it:', ''] : []), ...journalRunLines(run)].join('\n') };
  if (existsSync(join(dir, 'render.md'))) return { title, text: readFileSync(join(dir, 'render.md'), 'utf8') };
  const result = readJson<FitnessResult>(join(dir, 'result.json'));
  if (result) return { title, text: [...fitnessLines(result).map((l) => l.text), '', `${result.verdict}: ${result.reason}.`].join('\n') };
  const meta = readJson<Record<string, unknown>>(join(dir, 'meta.json'));
  return { title, text: meta ? JSON.stringify(meta, null, 2) : 'This run kept no view.' };
}
