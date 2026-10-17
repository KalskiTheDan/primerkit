import type { Arm, ForwardAccount, MemoryAnswer, Replay, TickRecord, TickWorkings } from '@primerkit/core';
import { lineChart, wrap, type Line, type Maker } from '@primerkit/ui';
import { beyond, within, SERIES_ROWS, type Board } from './boards';
import { BOARD_ROOM, wrapIn } from './fit';

// A backtest's boards: its plan, the memory check when it stops a run, and the report a
// finished run replays, each drawn as the other boards are. Every figure is the run's
// own, from its folder; nothing is asked of a model here.

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const DAY = 86_400_000;
const dayLabel = (iso: string, year = false): string => `${MONTHS[Number(iso.slice(5, 7)) - 1]} ${Number(iso.slice(8, 10))}${year ? `, ${iso.slice(0, 4)}` : ''}`;
const span = (from: string, to: string): string =>
  from.slice(0, 4) === to.slice(0, 4) ? `${dayLabel(from)} to ${dayLabel(to, true)}` : `${dayLabel(from, true)} to ${dayLabel(to, true)}`;
const pct = (x: number): string => `${x > 0 ? '+' : x < 0 ? '-' : ''}${Math.abs(x * 100).toFixed(1)}%`;
const share = (x: number): string => `${Math.abs(x * 100).toFixed(1)}%`;
const points = (x: number): string => `${x > 0 ? '+' : x < 0 ? '-' : ''}${Math.abs(x * 100).toFixed(1)} points`;
const usd = (v: number): string => `$${v.toLocaleString('en-US', { maximumFractionDigits: 0 })}`;
const thousands = (v: number): string => `$${(v / 1000).toFixed(1)}K`;
// A fee in cents where it is small, as a rebalance's often is: $0.01, not $0.
const fee = (v: number): string => (v < 100 ? `$${v.toFixed(2)}` : usd(v));
const ARM_NAME: Record<Arm | 'buy and hold', string> = { treatment: 'treatment', control: 'control', placebo: 'placebo', 'buy and hold': 'buy and hold' };

// ------------------------------------------------------------------ the plan

// The plan as `planLines` words it, drawn with its labels dim and each value wrapped under
// its own column, and what stops it bright.
export function planBoard(t: Maker, lines: string[], room = BOARD_ROOM): Board {
  const [head = '', ...rest] = lines;
  const [title = head, ...sub] = head.split(' | ');
  const width = within(room);
  const LABEL = 9;
  const body: Line[] = [];
  for (const line of rest) {
    const problem = /^ {2}cannot run: (.*)$/.exec(line);
    if (problem) {
      const text = wrapIn(t, 'fg', problem[1] as string, width - 12, '');
      body.push(...text.map((l, i): Line => [t('bright', i ? ''.padEnd(12) : 'cannot run  '), ...l]));
      continue;
    }
    const row = /^ {2}(\S+) +(.*)$/.exec(line);
    const more = /^ {11}(.*)$/.exec(line);
    const [label, value] = row ? [row[1] as string, row[2] as string] : ['', (more?.[1] ?? line.trim()) as string];
    wrapIn(t, 'fg', value, width - LABEL, '').forEach((l, i) => body.push([t('dim', (i === 0 ? label : '').padEnd(LABEL)), ...l]));
  }
  return { title, subtitle: sub.join(' | '), lines: body, sources: '', generated: null };
}

// ------------------------------------------------------------------ the memory check

// What the model said of the window's closes with no data, when that stops the run for
// the person's yes.
export function memoryBoard(t: Maker, o: { routine: string; from: string; to: string; model: string; answers: MemoryAnswer[]; stopped: string; next: string }, room = BOARD_ROOM): Board {
  const width = within(room);
  const lines: Line[] = [
    [t('muted', 'The memory check'), t('dim', `  Bitcoin's close asked with no data, before any tick`)],
    [t('dim', 'day'.padEnd(10)), t('dim', `${o.model} said`.padStart(18)), t('dim', 'the close'.padStart(14))],
    ...o.answers.map((a): Line => [
      t('fg', dayLabel(a.date).padEnd(10)),
      t('bright', (a.price === null ? 'no price' : usd(a.price)).padStart(18)),
      t('fg', usd(a.truth).padStart(14)),
      t(a.within ? 'bright' : 'dim', a.within ? '  within 5%' : a.price === null ? '' : '  further off'),
    ]),
    [],
    ...wrap(t, `Stopped before the first tick: ${o.stopped}.`, width),
    [],
    ...wrapIn(t, 'muted', o.next, width, ''),
  ];
  return { title: `${o.routine}  backtest`, subtitle: `${span(o.from, o.to)} | stopped for your yes`, lines, sources: 'history', generated: null };
}

// ------------------------------------------------------------------ the forward record

// A routine's forward record: its account since the first run against buying and
// holding, each run newest first, and whether the machine's scheduler runs it.
export function forwardBoard(
  t: Maker,
  plain: boolean,
  o: { routine: string; briefings: string[]; account: ForwardAccount; schedule: { at: string; where: string } | null },
  room = BOARD_ROOM,
  height = SERIES_ROWS,
): Board {
  const width = within(room);
  const { account } = o;
  const runs = account.entries;
  const lines: Line[] = [];
  const onSchedule = o.schedule
    ? `It runs every day at ${o.schedule.at}, on ${o.schedule.where}.`
    : `It is not on the schedule: primerkit routine ${o.routine} track --at 07:30 --yes adds it, to run every day.`;
  if (!runs.length) {
    lines.push(...wrap(t, `No run yet. primerkit routine ${o.routine} track runs it once now, on the data as served, and writes its label before the outcome exists.`, width));
    lines.push([], ...wrapIn(t, 'muted', onSchedule, width, ''));
    return { title: `${o.routine}  forward record`, subtitle: 'not started', lines, sources: [...o.briefings, 'history'].join(', '), generated: null };
  }
  const first = runs[0]!;
  const start = Date.parse(first.close.date);
  const x = (d: string) => (Date.parse(d) - start) / DAY;
  if (account.marks.length >= 2) {
    const days = x(account.marks.at(-1)!.date) || 1;
    const back = (marks: Array<{ equity: number }>) => (marks.at(-1)?.equity ?? 0) / (marks[0]?.equity || 1) - 1;
    const ends = [
      { y: account.marks.at(-1)!.equity, text: `${o.routine} ${pct(back(account.marks))}`, role: 'bright' },
      { y: account.buyAndHold.at(-1)?.equity ?? 0, text: `buy and hold ${pct(back(account.buyAndHold))}`, role: 'muted' },
    ];
    const ys = [...account.marks, ...account.buyAndHold].map((m) => m.equity);
    const gutter = Math.max(thousands(Math.min(...ys)).length, thousands(Math.max(...ys)).length);
    const on = days <= 6 ? Array.from({ length: days + 1 }, (_, i) => i) : [0, 1, 2, 3].map((i) => Math.round((days * i) / 3));
    lines.push(
      ...lineChart(t, {
        series: [
          { points: account.marks.map((m): [number, number] => [x(m.date), m.equity]), style: 'main' },
          { points: account.buyAndHold.map((m): [number, number] => [x(m.date), m.equity]), style: 'compare' },
        ],
        points: [{ x: x(account.marks.at(-1)!.date), y: account.marks.at(-1)!.equity }],
        width: Math.max(20, width - gutter - 2 - Math.max(...ends.map((e) => e.text.length)) - 1) + beyond(room),
        height,
        xRange: [0, days],
        yLabel: thousands,
        xTicks: on.map((n) => ({ x: n, label: dayLabel(new Date(start + n * DAY).toISOString().slice(0, 10)) })),
        ends,
        plain,
      }),
      [],
    );
  } else {
    lines.push(...wrapIn(t, 'muted', 'The chart starts once a close has come after the first run.', width, ''), []);
  }
  // The runs, newest first: the label, and what the account did with it.
  lines.push([t('muted', 'The runs'), t('dim', '  newest first, each written before its outcome existed')]);
  for (const r of [...runs].reverse().slice(0, 10)) {
    const when = `${dayLabel(r.day)} ${r.at.slice(11, 16)}`;
    const did = r.fill
      ? `to ${share(r.fill.toShare)} at the ${dayLabel(r.fill.date)} close, ${usd(r.fill.price)}`
      : r.pending
        ? `waits for the close after ${dayLabel(r.close.date)}`
        : r.label === null
          ? `no label (${r.outcome}), so it held`
          : r.target === null
            ? 'held what it held'
            : 'already at its share';
    lines.push([t('fg', when.padEnd(14)), t('accentBold', (r.label ?? '-').padEnd(8)), ...wrapIn(t, 'fg', did, Math.max(10, width - 22), '')[0]!]);
  }
  if (runs.length > 10) lines.push([t('dim', `and ${runs.length - 10} runs before these, in the record`)]);
  lines.push([]);
  // Figures only once a close has come after the first run: before it, every one is nil.
  if (account.stats && account.buyAndHoldStats && account.marks.length >= 2) {
    lines.push(...wrap(t, `Since the first run: ${o.routine} ${pct(account.stats.return)}, fell ${share(account.stats.maxDrawdown)} at most, ${account.stats.trades} ${account.stats.trades === 1 ? 'trade' : 'trades'}; buying and holding ${pct(account.buyAndHoldStats.return)}.`, width));
  }
  lines.push(...wrapIn(t, 'muted', onSchedule, width, ''));
  lines.push([]);
  lines.push(...wrapIn(t, 'dim', 'Labels only: no order goes anywhere. Each run reads the data as served at the time and writes its label before the outcome exists, so a model cannot remember what came next.', width, ''));
  lines.push(...wrapIn(t, 'muted', 'A simulated account: not a forecast, and not advice.', width, ''));
  return {
    title: `${o.routine}  forward record`,
    subtitle: `since ${dayLabel(first.day, true)} | ${runs.length} ${runs.length === 1 ? 'run' : 'runs'}${account.through ? ` | closes to ${dayLabel(account.through)}` : ''}`,
    lines,
    sources: [...o.briefings, 'history'].join(', '),
    generated: runs.at(-1)!.at,
  };
}

// ------------------------------------------------------------------ a tick's inner workings

const CHECK_NAMES: Record<string, string> = { schema: 'shape', citations: 'citations', cites_data: 'data cited', grounded_numbers: 'numbers', scope: 'scope' };

// What each arm did on one tick, step by step, as screen 31 shows a routine's run: what
// it read, the rules as read, what the model returned and cited, the checks, and what
// the account did. From the run's records and the journal, which keeps every answer.
export function tickBoard(t: Maker, replay: Replay, tick: string, workings: TickWorkings[], room = BOARD_ROOM): Board {
  const width = within(room);
  const LABEL = 11;
  const lines: Line[] = [];
  const step = (n: number, label: string, text: string, role = 'fg') =>
    wrapIn(t, role, text, width - LABEL, '').forEach((l, i) => lines.push(i ? [t('fg', ''.padEnd(LABEL)), ...l] : [t('accent', `${n} `), t('dim', label.padEnd(LABEL - 2)), ...l]));
  const briefings = replay.run.spec.briefings;
  const named = (ids: string[]) => (ids.length > 1 ? `${ids.slice(0, -1).join(', ')} and ${ids.at(-1)}` : ids[0] ?? '');
  for (const w of workings) {
    const r = w.record;
    if (lines.length) lines.push([]);
    lines.push([t('bright', dayLabel(tick)), t('muted', `  ${ARM_NAME[w.arm]}`), t('accentBold', `  ${r.label ?? 'no label'}`)]);
    const read = r.read;
    const what =
      w.arm === 'control'
        ? 'no briefings: the price table and the position alone'
        : `${named(briefings)} as ${briefings.length > 1 ? 'they' : 'it'} stood on ${read ? dayLabel(read, read.slice(0, 4) !== tick.slice(0, 4)) : 'the tick'}${
            w.arm === 'placebo' && replay.run.blind && read ? `, ${placeboDaysOf(tick, read)} days before, dated as the tick's own` : ''
          }; the price table and the position`;
    step(1, 'read', `${what}${w.kept?.tokens ? `: ${w.kept.tokens.toLocaleString('en-US')} tokens` : ''}`);
    if (w.kept?.rules) step(2, 'rules', `${w.kept.rules.path.split(/[\\/]/).at(-1)}, ${w.kept.rules.lines} lines, as it read them (${w.kept.rules.hash.slice(0, 8)})`);
    else step(2, 'rules', 'as the run read them; the journal keeps no copy here');
    const answer = w.kept?.answer;
    const model = w.kept?.model ?? replay.run.modelName ?? replay.run.model;
    if (r.label === null) step(3, 'model', `${model}'s answer failed its checks${w.kept?.attempts && w.kept.attempts > 1 ? ' after a repair turn' : ''}, so the position held`);
    else step(3, 'model', `${model} returned ${r.label}${answer?.reason ? `: ${answer.reason}` : ''}${answer?.cited.length ? ` Cited ${answer.cited.join(', ')}.` : ''}`);
    const checks = w.kept?.checks ?? [];
    if (checks.length) {
      const row: Line = [t('accent', '4 '), t('dim', 'checks'.padEnd(LABEL - 2))];
      for (const c of checks) row.push(t(c.failed ? 'bright' : 'accent', c.failed ? '✗ ' : '✓ ', c.failed ? 'x ' : 'ok '), t('fg', `${CHECK_NAMES[c.id] ?? c.id}  `));
      lines.push(row);
      if ((w.kept?.attempts ?? 1) > 1) lines.push([t('fg', ''.padEnd(LABEL)), t('muted', 'after one repair turn')]);
    } else step(4, 'checks', 'not kept in the journal here');
    const account = r.fill
      ? `to ${share(r.fill.toShare)} of the account at ${usd(r.fill.price)} on ${dayLabel(r.fill.date)}, a fee of ${fee(r.fill.fee)}${r.capped ? ', capped at your share' : ''}`
      : r.pending
        ? 'its order waits for a close after the window'
        : r.label === null || r.target === null
          ? 'held what it held'
          : 'already at its share: nothing to trade';
    step(5, 'account', account);
  }
  return {
    title: `${replay.run.routine}  ${dayLabel(tick, true)}`,
    subtitle: 'each arm, step by step',
    lines: lines.length ? lines : [[t('fg', 'No arm ran on this tick.')]],
    sources: [...briefings, 'history'].join(', '),
    generated: replay.run.startedAt,
  };
}

const placeboDaysOf = (tick: string, read: string): number => Math.round((Date.parse(tick) - Date.parse(read)) / DAY);

// ------------------------------------------------------------------ the report

// A tick in every arm of the first repeat, as a line under the chart says it.
function tickSentence(records: TickRecord[], tick: string): string {
  const said = (r: TickRecord | undefined): string => {
    if (!r) return 'not run';
    if (r.label === null) return `no label (${r.outcome}), so it held`;
    if (r.fill) return `${r.label}, to ${share(r.fill.toShare)} at ${usd(r.fill.price)} on ${dayLabel(r.fill.date)}`;
    return r.pending ? `${r.label}, waiting for a close after the window` : `${r.label}, nothing to trade`;
  };
  const arms = (['treatment', 'control', 'placebo'] as const).filter((a) => records.some((r) => r.arm === a));
  return `${dayLabel(tick)}: ${arms.map((a) => `${a} ${said(records.find((r) => r.rep === 1 && r.arm === a && r.tick === tick))}`).join('; ')}.`;
}

// The report a finished run replays: each arm's account day by day against buying and
// holding, the arms' figures, what the data changed, and every note the report carries.
// `tick`, when given, is the tick of the first repeat the arrows have moved to.
export function backtestBoard(t: Maker, plain: boolean, replay: Replay, room = BOARD_ROOM, height = SERIES_ROWS, tick: number | null = null): Board {
  const { run, report, curves, records } = replay;
  const width = within(room);
  const start = Date.parse(curves.marked.from);
  const x = (d: string) => (Date.parse(d) - start) / DAY;
  const days = x(curves.marked.to) || 1;
  const armCurves = run.arms.map((arm) => ({ arm, marks: curves.arms.find((c) => c.arm === arm && c.rep === 1)?.marks ?? [] }));
  const lines: Line[] = [];
  const sample = report.sample ?? { kind: 'inside' as const, line: report.notes[0] ?? '' };
  lines.push(...wrapIn(t, sample.kind === 'out' ? 'muted' : 'bright', sample.line, width, ''));
  lines.push([]);
  // The chart: the treatment solid, the other arms and buying and holding dotted, each
  // named at its end with its return, and the tick the arrows are on marked on the
  // treatment's line.
  const ended = (marks: Array<{ equity: number }>) => marks.at(-1)?.equity ?? 0;
  const firstEquity = (marks: Array<{ equity: number }>) => marks[0]?.equity ?? 0;
  const ends = [
    ...armCurves.map((c) => ({ y: ended(c.marks), text: `${ARM_NAME[c.arm]} ${pct(ended(c.marks) / firstEquity(c.marks) - 1)}`, role: c.arm === 'treatment' ? 'bright' : 'muted' })),
    { y: ended(curves.buyAndHold.marks), text: `${ARM_NAME['buy and hold']} ${pct(report.buyAndHold.return)}`, role: 'muted' },
  ];
  const endWidth = Math.max(...ends.map((e) => e.text.length)) + 1;
  const ticked = tick !== null ? run.ticks[tick] : undefined;
  const treatment = armCurves.find((c) => c.arm === 'treatment') ?? armCurves[0];
  const at = ticked ? treatment?.marks.find((m) => m.date === ticked) : undefined;
  const ys = [...armCurves.flatMap((c) => c.marks.map((m) => m.equity)), ...curves.buyAndHold.marks.map((m) => m.equity)];
  const gutter = Math.max(thousands(Math.min(...ys)).length, thousands(Math.max(...ys)).length);
  const on = days <= 6 ? Array.from({ length: days + 1 }, (_, i) => i) : [0, 1, 2, 3].map((i) => Math.round((days * i) / 3));
  const ticks = on.map((n) => {
    const d = new Date(start + n * DAY).toISOString().slice(0, 10);
    return { x: n, label: dayLabel(d) };
  });
  lines.push(
    ...lineChart(t, {
      series: [
        ...armCurves.map((c) => ({ points: c.marks.map((m): [number, number] => [x(m.date), m.equity]), style: c.arm === 'treatment' ? ('main' as const) : ('compare' as const) })),
        { points: curves.buyAndHold.marks.map((m): [number, number] => [x(m.date), m.equity]), style: 'compare' as const },
      ],
      points: [...(treatment?.marks.length ? [{ x: x(treatment.marks.at(-1)!.date), y: ended(treatment.marks) }] : []), ...(at ? [{ x: x(at.date), y: at.equity }] : [])],
      width: Math.max(20, width - gutter - 2 - endWidth) + beyond(room),
      height,
      xRange: [0, days],
      yLabel: thousands,
      xTicks: ticks,
      ends,
      plain,
    }),
  );
  if (ticked) lines.push([], ...wrap(t, tickSentence(records, ticked), width));
  lines.push([]);
  // The arms' figures, in columns that leave out the least needed first in a narrow room.
  const reps = run.reps;
  const cols = [
    { head: reps > 1 ? 'mean' : 'return', w: 8 },
    { head: 'fell', w: 7 },
    { head: 'trades', w: 7 },
    { head: 'in market', w: 11 },
    { head: 'fees', w: 7 },
  ];
  const fit = cols.filter((_, i) => 13 + cols.slice(0, i + 1).reduce((s, c) => s + c.w, 0) <= width);
  const cell = (i: number, text: string, role: string) => (fit[i] ? [t(role, text.padStart(fit[i]!.w))] : []);
  lines.push([t('dim', ''.padEnd(13)), ...fit.map((c) => t('dim', c.head.padStart(c.w)))]);
  for (const a of report.arms) {
    const s = a.reps[0];
    if (!s) continue;
    lines.push([
      t('fg', ARM_NAME[a.arm].padEnd(13)),
      ...cell(0, pct(reps > 1 ? a.mean.return : s.return), 'bright'),
      ...cell(1, share(reps > 1 ? a.mean.maxDrawdown : s.maxDrawdown), 'fg'),
      ...cell(2, String(s.trades), 'fg'),
      ...cell(3, `${s.daysInMarket} of ${s.days}`, 'fg'),
      ...cell(4, share(s.fees), 'fg'),
    ]);
  }
  const bh = report.buyAndHold;
  lines.push([
    t('fg', ARM_NAME['buy and hold'].padEnd(13)),
    ...cell(0, pct(bh.return), 'bright'),
    ...cell(1, share(bh.maxDrawdown), 'fg'),
    ...cell(2, String(bh.trades), 'fg'),
    ...cell(3, `${bh.daysInMarket} of ${bh.days}`, 'fg'),
    ...cell(4, share(bh.fees), 'fg'),
  ]);
  lines.push([]);
  // What the data added: the arms against each other, and the labels it changed.
  const said: string[] = [];
  if (report.treatmentVsControl.length) said.push(`Treatment against control ${report.treatmentVsControl.map(points).join(', ')}${report.treatmentVsPlacebo.length ? `, against placebo ${report.treatmentVsPlacebo.map(points).join(', ')}` : ''}.`);
  for (const c of report.labelsChanged) said.push(`The data changed the label on ${c.changed} of ${c.compared} ticks${report.labelsChanged.length > 1 ? ` in repeat ${c.rep}` : ''}.`);
  if (report.pending) said.push(`${report.pending} ${report.pending === 1 ? 'order waits' : 'orders wait'} for a close after the window.`);
  if (reps > 1) said.push(`The chart draws the first repeat; the table's returns are the mean of ${reps}.`);
  if (said.length) lines.push(...wrap(t, said.join(' '), width));
  lines.push([]);
  // The notes, except the sample line drawn at the top and the last word, drawn last.
  const LAST = 'A simulation on past data: not a forecast, and not advice.';
  for (const note of report.notes.slice(1).filter((n) => n !== LAST)) lines.push(...wrapIn(t, 'dim', note, width, ''));
  lines.push(...wrapIn(t, 'muted', LAST, width, ''));
  const briefings = run.spec.briefings;
  return {
    title: `${run.routine}  backtest`,
    subtitle: `${span(run.from, run.to)} | every ${run.every} | ${run.ticks.length} ${run.ticks.length === 1 ? 'tick' : 'ticks'}${reps > 1 ? ` | ${reps} repeats` : ''}`,
    lines,
    sources: [...briefings, 'history'].join(', '),
    generated: run.startedAt,
  };
}
