import { basename, dirname, join } from 'node:path';
import { journalRun, journalSummary, runSpend } from '@primerkit/core';
import type { JournalRow } from './state';

// Finding things in the journal: a routine's tick titled by the label that fired, one day's
// sums, and the summary row above each day's runs. Read only.

export const DAY_FOLDER = /^\d{4}-\d{2}-\d{2}$/;
const INTENTS = new Set(['intent', 'live-intent']);

// The blocks a routine packet carries beside the data: the person's rules, the price table and
// the position. A tick's title names the first reading it cites from the data instead.
const NOT_DATA = new Set(['rules', 'prices', 'position']);

// A routine tick's title: the label that fired, and the first reading it cites.
export function tickTitle(dir: string): string | null {
  const run = journalRun(dir);
  if (!run?.label) return null;
  const reading = run.claims.flatMap((c) => c.citations).find((c) => !NOT_DATA.has(c.block));
  const text = reading ? (reading.line_text ?? reading.quote).replace(/\s+/g, ' ').trim() : (run.reason ?? '');
  return `${run.label} · ${reading ? `[${reading.block} L${reading.line}] ` : ''}${text}`;
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

// One day's sums, as its summary row opens to.
export function dayText(root: string, day: string): string[] {
  const d = journalSummary(root, { query: { day } })[0];
  if (!d) return [`${day}: no runs.`];
  const order = ['passed', 'partial', 'failed', 'refused', 'pending'];
  const rank = (k: string) => (order.includes(k) ? order.indexOf(k) : order.length);
  const outcomes = Object.entries(d.outcomes)
    .sort(([a], [b]) => rank(a) - rank(b))
    .map(([k, n]) => `${n} ${k}`)
    .join(', ');
  return [
    `${day}: ${plural(d.runs, 'run', 'runs')}, ${outcomes}.`,
    `Tokens the models reported: ${d.tokens.input.toLocaleString('en-US')} in, ${d.tokens.output.toLocaleString('en-US')} out, over ${plural(d.tokens.reported_runs, 'run', 'runs')}; the packets came to ${d.tokens.packet.toLocaleString('en-US')} tokens.`,
    d.cost.priced_runs ? `Cost where known: $${d.cost.usd.toFixed(4)}, over ${plural(d.cost.priced_runs, 'run', 'runs')}${d.cost.unpriced_runs ? `; ${d.cost.unpriced_runs} with no price` : ''}.` : 'No cost is known for these runs.',
  ];
}

// The day folder a row's run sits in.
export const dayOf = (row: JournalRow): string => basename(dirname(dirname(row.dir)));

// The rows with a summary row above each day's: its runs, how many passed, the tokens the
// models reported and the cost where known. A summary row opens to that day's sums.
export function withDaySummaries(rows: JournalRow[], root: string): JournalRow[] {
  const out: JournalRow[] = [];
  let current = '';
  for (const r of rows) {
    const folder = dayOf(r);
    if (folder !== current) {
      current = folder;
      // Runs and order intents are counted apart: an intent is not a run.
      const day = rows.filter((x) => dayOf(x) === folder);
      const same = day.filter((x) => !INTENTS.has(x.operation));
      const intents = day.length - same.length;
      const passed = same.filter((x) => x.outcome === 'passed').length;
      // The sums of the runs shown under it, so a filtered list sums what it shows.
      let input = 0;
      let output = 0;
      let reported = false;
      let usd = 0;
      let priced = false;
      for (const x of same) {
        const spent = runSpend(x.dir);
        if (spent?.tokens.input !== null && spent?.tokens.input !== undefined) {
          reported = true;
          input += spent.tokens.input;
          output += spent.tokens.output ?? 0;
        }
        if (spent?.cost && spent.cost.basis === 'list price') {
          priced = true;
          usd += spent.cost.usd;
        }
      }
      // Short, so it fits a row: the tokens the models reported and the cost where known.
      const spent = `${reported ? `${(input + output).toLocaleString('en-US')} tokens` : 'no tokens reported'}${priced ? `, $${usd.toFixed(4)}` : ''}`;
      out.push({ day: r.day, time: '', operation: 'day', title: `${plural(same.length, 'run', 'runs')}, ${passed} passed, ${spent}${intents ? `; ${plural(intents, 'order intent', 'order intents')}` : ''}`, outcome: '', dir: join(root, folder) });
    }
    out.push(r);
  }
  return out;
}
