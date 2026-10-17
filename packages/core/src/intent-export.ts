import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { entryLines, exitLines, intentTitle, readIntent, type IntentChecks, type IntentClose, type IntentFolder, type IntentRecord, type IntentSizing } from './intent';
import { exitWords } from './intent-exits';

// An intent as an auditor reads it: one page from top to bottom, and one row of a CSV for
// many. Both are read from the intent's folder and change nothing in it.

const pct = (share: number): string => `${Number((share * 100).toFixed(2))}%`;
const usd = (n: number): string => `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export function sizingWords(s: IntentSizing): string {
  if (s.kind === 'fixed_notional') return `a fixed amount of ${usd(s.dollars)}`;
  if (s.kind === 'fixed_quantity') return `a fixed quantity of ${s.quantity}, of what is held`;
  if (s.kind === 'percent_of_equity') return `${pct(s.share)} of equity`;
  if (s.kind === 'target_share') return `hold ${pct(s.share)} of equity in it`;
  return `${pct(s.risk_share)} of equity at risk, with the stop ${pct(s.stop_distance)} away`;
}

const checkTable = (c: IntentChecks): string[] => [
  '| check | limit | figure | result |',
  '|---|---|---|---|',
  ...c.checks.map((x) => `| ${x.check} | ${x.limit ?? ''} | ${x.value ?? ''} | ${x.passed ? 'passed' : 'failed'}: ${x.message.replace(/\|/g, '/')} |`),
];

// The page: where it came from, the cited lines, the rule and the size it came to, each check
// with its limit and figure, the yes, each answer from the broker, the exit, and the end.
export function renderIntent(r: IntentRecord): string {
  const i = r.intent;
  const p = i.provenance;
  const source = i.source.kind === 'routine' ? `the routine ${i.source.routine}'s label, given at ${i.source.tick}` : i.source.kind === 'ask' ? `the answer of run ${i.source.run_id}` : i.source.kind === 'webhook' ? `the webhook ${i.source.name}` : 'typed by hand';
  const lines: string[] = [
    `# ${intentTitle(i)}`,
    '',
    `Order intent ${i.intent_id}, ${r.state}. Drafted ${i.created_at}; it expired ${i.expires_at} unless it was sent before then.`,
    '',
    'Your rules and your model decided; PreReason supplied data. Paper trading only.',
    '',
    '## Where it came from',
    '',
    `- From ${source}.`,
    `- Thesis: ${p.thesis}`,
    `- Run: ${p.run_id ?? 'none'}, on ${p.model ?? 'no model'}, with data as of ${p.data_as_of ?? 'unknown'}.`,
    `- Its checks then: ${p.checks_passed.length ? p.checks_passed.map((c) => `${c.check} ${c.passed ? 'passed' : 'failed'}`).join(', ') : 'none kept'}.`,
    ...(p.cited.length ? ['- The lines it cited:', ...p.cited.map((c) => `  - ${c.block} line ${c.line}: "${c.quote}"`)] : ['- It cited no lines.']),
    ...(p.generated.length ? [`- The briefings were generated ${p.generated.join(', ')}.`] : []),
    '',
    '## The order',
    '',
    `- ${i.side} ${i.instrument.symbol} at ${i.instrument.venue}${i.instrument.asset_class ? `, ${i.instrument.asset_class}` : ''}, a ${i.entry.kind} order.`,
    `- The rule: ${sizingWords(i.sizing)}. The amount is computed by code, never by the model.`,
    ...(r.checks ? [`- It came to ${r.checks.computed.notional !== null ? usd(r.checks.computed.notional) : `${r.checks.computed.quantity}`} on equity of ${r.checks.computed.equity !== null ? usd(r.checks.computed.equity) : 'unknown'}, ${r.checks.computed.held ?? 0} held.`] : []),
    `- The exit: ${i.exit ? exitWords(i.exit) : 'none'}.`,
  ];
  if (r.checks) lines.push('', `## The checks before the yes (${r.checks.at})`, '', ...checkTable(r.checks));
  if (r.approval) {
    lines.push('', '## The yes', '', `- Typed "${r.approval.typed}" by ${r.approval.user} at ${r.approval.at}, at ${r.approval.terminal}.`);
    if (r.approval.exits) lines.push(`- Shown with it: ${r.approval.exits}`);
    lines.push('- The order body shown:', '', '```json', JSON.stringify(r.approval.body, null, 2), '```');
  }
  if (r.finalChecks) lines.push('', `## The checks after the yes (${r.finalChecks.at})`, '', ...checkTable(r.finalChecks));
  const said = (o: IntentRecord['orders'][number]) => `- ${o.at}: ${o.status}${o.broker_order_id ? `, order ${o.broker_order_id}` : ''}${o.filled_qty ? `, ${o.filled_qty} filled${o.filled_avg_price ? ` at ${usd(o.filled_avg_price)}` : ''}` : ''}${o.note ? ` (${o.note})` : ''}`;
  if (entryLines(r.orders).length) lines.push('', '## The broker', '', ...entryLines(r.orders).map(said));
  if (exitLines(r.orders).length) lines.push('', '## The standing exit at the broker', '', ...exitLines(r.orders).map(said));
  lines.push('', '## The end', '', r.close ? `${r.close.state}, ${r.close.at}: ${r.close.reason}.` : `Not closed: it is ${r.state}.`);
  return `${lines.join('\n')}\n`;
}

// An intent's end: close.json, then its page, render.md, each written once.
export function closeIntent(folder: IntentFolder, close: IntentClose): void {
  folder.write('close.json', close);
  folder.write('render.md', renderIntent(readIntent(folder.dir, new Date(close.at))));
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;

// Each intent folder in the journal drafted from one day to another, both kept, oldest first.
export function intentDirs(journalRoot: string, from: string, to: string): string[] {
  if (!existsSync(journalRoot)) return [];
  const dirs: string[] = [];
  for (const day of readdirSync(journalRoot).filter((d) => DAY.test(d) && d >= from && d <= to).sort()) {
    const at = join(journalRoot, day, 'intent');
    if (!existsSync(at)) continue;
    for (const id of readdirSync(at).sort()) if (statSync(join(at, id)).isDirectory() && existsSync(join(at, id, 'intent.json'))) dirs.push(join(at, id));
  }
  return dirs;
}

const COLUMNS = ['intent_id', 'created_at', 'state', 'source', 'thesis', 'run_id', 'model', 'symbol', 'side', 'rule', 'computed_notional', 'computed_quantity', 'checks_failed', 'approved_at', 'approved_by', 'broker_order_id', 'filled_qty', 'filled_avg_price', 'exit', 'exit_order_id', 'exit_status', 'closed_at', 'close_reason'] as const;
const cell = (v: unknown): string => {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

// One row for each intent, for a spreadsheet or a compliance reader.
export function intentsCsv(records: IntentRecord[]): string {
  const rows = records.map((r) => {
    const i = r.intent;
    const entry = entryLines(r.orders).at(-1);
    const exit = exitLines(r.orders).at(-1);
    const row: Record<(typeof COLUMNS)[number], unknown> = {
      intent_id: i.intent_id,
      created_at: i.created_at,
      state: r.state,
      source: i.source.kind === 'routine' ? `routine ${i.source.routine}` : i.source.kind,
      thesis: i.provenance.thesis,
      run_id: i.provenance.run_id,
      model: i.provenance.model,
      symbol: i.instrument.symbol,
      side: i.side,
      rule: sizingWords(i.sizing),
      computed_notional: r.checks?.computed.notional,
      computed_quantity: r.checks?.computed.quantity,
      checks_failed: r.finalChecks?.checks.filter((c) => !c.passed).map((c) => c.check).join(' ') ?? r.checks?.checks.filter((c) => !c.passed).map((c) => c.check).join(' '),
      approved_at: r.approval?.at,
      approved_by: r.approval?.user,
      broker_order_id: entry?.broker_order_id,
      filled_qty: entry?.filled_qty,
      filled_avg_price: entry?.filled_avg_price,
      exit: i.exit ? exitWords(i.exit) : '',
      exit_order_id: exit?.broker_order_id,
      exit_status: exit?.status,
      closed_at: r.close?.at,
      close_reason: r.close ? `${r.close.state}: ${r.close.reason}` : '',
    };
    return COLUMNS.map((c) => cell(row[c])).join(',');
  });
  return `${[COLUMNS.join(','), ...rows].join('\r\n')}\r\n`;
}
