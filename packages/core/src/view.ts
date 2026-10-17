import { answerOf, backgroundOf } from './checks/shape';
import { NEWS_BLOCK } from './checks/scope';
import type { CheckResult } from './checks/index';
import type { RunResult } from './executor';
import type { FailureReason } from './types';

// What an answer shows, whatever draws it: the terminal session, or the markdown the
// journal keeps and an AI app prints.
export interface AnswerView {
  headline: string;
  sentences: Array<{ text: string; refs: number[] }>;
  sources: Array<{ n: number; block: string; line: number }>;
  background?: string[]; // from the model's general knowledge, shown apart from the data
  dropped: Array<{ text: string; reasons: string[]; background?: boolean }>;
  checks: Checks;
  tokens: number;
  seconds: number;
  briefings: string[]; // every block read: briefings, and metrics by their ids
  generated: string | null; // the newest Generated time among the blocks read
  asOf: string | null; // the past day the blocks were read for; null when read as they stand now
  partial: boolean;
}

export function answerView(result: RunResult): AnswerView | null {
  if (!result.response) return null;
  const sources: AnswerView['sources'] = [];
  const refOf = (block: string, line: number): number => {
    const found = sources.find((s) => s.block === block && s.line === line);
    if (found) return found.n;
    sources.push({ n: sources.length + 1, block, line });
    return sources.length;
  };
  const sentences = result.response.claims.map((c) => ({ text: c.text, refs: [...new Set(c.citations.map((x) => refOf(x.block, x.line)))] }));
  const generated = result.packet.blocks.map((b) => b.generatedAt).filter((g): g is string => Boolean(g)).sort().at(-1) ?? null;
  return {
    headline: answerOf(result.response),
    sentences,
    sources,
    background: backgroundOf(result.response),
    dropped: result.dropped.map((d) => ({ text: d.claim.text, reasons: d.reasons, ...(d.background ? { background: true } : {}) })),
    checks: checksOf(result.checks.map((c) => c.id), [result.checks]),
    tokens: result.packet.tokens.count,
    seconds: result.timings.totalMs / 1000,
    briefings: result.packet.blocks.map((b) => b.id),
    generated,
    asOf: result.packet.asOf ?? null,
    partial: result.outcome === 'partial',
  };
}

// The checks an answer or a digest ran, by name, and how many held. `ran` is missing from
// a view kept before the checks were named, and `reasons` from one kept before a failed
// check said which way it failed.
export interface Checks {
  passed: number;
  total: number;
  ran?: Array<{ id: string; ok: boolean; reasons?: FailureReason[] }>;
}

// The checks a line names, from the results of one reply or of several (a digest's local
// model writes one a briefing), in the order the operation names them: held where every
// reply held it, and failed where any failed it, with the ways it failed. A check a reply
// did not run is neither named nor counted. No check runs past a reply that is not JSON or
// not in its shape, and its format failure says so: the digest once named all six of its
// checks as failed for such a reply, five of which never ran (the recheck, 10-13). A soft
// failure does not count against a check.
export function checksOf(ids: readonly string[], replies: ReadonlyArray<readonly CheckResult[]>): Checks {
  const ran: NonNullable<Checks['ran']> = [];
  for (const id of ids) {
    const each = replies.map((r) => r.find((c) => c.id === id));
    const failures = each.flatMap((c) => c?.failures.filter((f) => !f.soft) ?? []);
    const reasons = [...new Set(failures.flatMap((f) => (f.reason ? [f.reason] : [])))];
    if (failures.length) ran.push({ id, ok: false, ...(reasons.length ? { reasons } : {}) });
    else if (each.length && each.every(Boolean)) ran.push({ id, ok: true });
  }
  return { passed: ran.filter((c) => c.ok).length, total: ran.length, ran };
}

// What each check tests, as a person reads it: its name where it held, and what failed
// where it did not. A line names what was checked and never more (the wording review, 10-12):
// "no advice words", not "no advice", since a list of words cannot show that an answer
// holds no advice, only that it holds none of those words.
export const CHECK_WORDS: Record<string, { held: string; failed: string }> = {
  schema: { held: 'answer format', failed: "the answer's format is wrong" },
  citations: { held: 'claims cite their lines', failed: 'a claim does not cite its line as it stands' },
  cites_data: { held: 'the label cites the data', failed: 'the label cites only your rules, or sets a target citing none of them' },
  grounded_numbers: { held: 'figures match the lines cited', failed: 'a figure does not match its cited line' },
  scope: { held: 'no advice words', failed: 'advice words appear' },
  grounded_directions: { held: 'direction words cite a change', failed: 'a direction the cited lines do not hold' },
  as_of: { held: 'dated the day the briefings were read for', failed: 'the answer is not dated the day the briefings were read for' },
  in_diff: { held: 'every change is in the diff', failed: 'a change is not in the diff' },
  coverage: { held: 'every item has a change', failed: 'an item has no change' },
};

// What failed, where a check can fail in more than one way: a reply that is not JSON or not
// in its shape, which no other check runs past, and each rule scope holds, which once all
// read "advice words appear" (the recheck, 10-13).
export const FAILED_WORDS: Record<FailureReason, string> = {
  format: "the answer's format is wrong, so the other checks did not run on it",
  field: 'the answer holds a field it may not',
  advice: 'advice words appear',
  background_advice: 'advice words appear in the background',
  background_length: 'more than four background sentences',
  equities: 'an equities briefing that names no company was read',
  news_move: 'a price or move beside a news record',
};

// "4 of 4 checks: answer format · claims cite their lines · figures match the lines cited ·
// no advice words", named from the checks that ran, or where one failed, which one and how:
// "3 of 4 checks: a figure does not match its cited line". A view kept before the checks
// were named says how many passed.
export function checksText(checks: Checks): { ok: boolean; text: string } {
  const ok = checks.passed === checks.total;
  if (!checks.ran?.length) return { ok, text: `${checks.passed} of ${checks.total} checks passed` };
  const words = (id: string) => CHECK_WORDS[id] ?? { held: id, failed: `${id} failed` };
  const failed = (c: { id: string; reasons?: FailureReason[] }) => (c.reasons?.length ? c.reasons.map((r) => FAILED_WORDS[r] ?? words(c.id).failed) : [words(c.id).failed]);
  const named = ok ? checks.ran.map((c) => words(c.id).held) : [...new Set(checks.ran.filter((c) => !c.ok).flatMap(failed))];
  return { ok, text: `${checks.passed} of ${checks.total} checks: ${named.join(' · ')}` };
}

// When the data stood: "as it stood on Aug 15, 2026" for a past day, otherwise the time
// PreReason generated it, "generated 14:01 UTC"; a metric names no such time, so an answer
// read from metrics alone says "as it stands now".
export function whenRead(view: Pick<AnswerView, 'asOf' | 'generated'>): string {
  if (view.asOf) return `as it stood on ${longDay(view.asOf)}`;
  return view.generated ? `generated ${hhmm(view.generated)} UTC` : 'as it stands now';
}

// "Aug 15, 2026", from 2026-08-15.
export function longDay(iso: string): string {
  const [y, m, d] = iso.split('-').map(Number) as [number, number, number];
  return `${['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][m - 1] ?? '?'} ${d}, ${y}`;
}

// "14:01", from an ISO time.
export function hhmm(iso: string | null): string {
  if (!iso) return 'unknown';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toISOString().slice(11, 16);
}

// A sentence with its source markers before its closing stop: "over 30 days [1]."
export function withRefs(text: string, refs: number[]): string {
  const trimmed = text.trim();
  if (!refs.length) return trimmed;
  const stop = /[.!?]$/.test(trimmed) ? trimmed.slice(-1) : '';
  return `${stop ? trimmed.slice(0, -1) : trimmed} ${refs.map((r) => `[${r}]`).join(' ')}${stop}`;
}

// The words that set background apart from what the data says, wherever an answer is drawn.
export const BACKGROUND_LABEL = "Background, from the model's general knowledge, not from the data";

// Fills an operation's render.md: {{headline}}, {{body}}, {{background}}, {{checks}},
// {{sources}}, {{dropped}}, {{briefings}}, {{generated}} and {{when}} (whenRead). An operation can add its own, such as a
// routine's {{label}}, or say one differently, such as the briefings a routine reads.
export function renderMarkdown(template: string, view: AnswerView, extra: Record<string, string> = {}): string {
  const body = view.sentences.map((s) => withRefs(s.text, s.refs)).join(' ');
  const sources = view.sources.map((s) => `[${s.n}] ${s.block}, line ${s.line}`).join(' · ');
  const named = checksText(view.checks);
  const checks = `${named.ok ? '✓' : '✗'} ${named.text} · ${view.tokens.toLocaleString('en-US')} tokens read`;
  const claims = view.dropped.filter((d) => !d.background);
  const background = view.dropped.filter((d) => d.background);
  // On a news answer, background also sets no price or move beside a record (the wording review, 10-14).
  const holds = view.briefings.includes(NEWS_BLOCK) ? 'no number, no advice and no price or move' : 'no number and no advice';
  const dropped = [
    claims.length ? `Partial answer. Not supported by the data, so taken out: ${claims.map((d) => `"${d.text}"`).join('; ')}.` : '',
    background.length ? `Taken out of the background, which holds ${holds}: ${background.map((d) => `"${d.text}"`).join('; ')}.` : '',
  ].filter(Boolean).join('\n\n');
  const fill: Record<string, string> = {
    headline: view.headline,
    body,
    background: view.background?.length ? `*${BACKGROUND_LABEL}:* ${view.background.join(' ')}` : '',
    checks,
    sources,
    dropped,
    briefings: view.briefings.join(', '),
    generated: hhmm(view.generated),
    when: whenRead(view),
    ...extra,
  };
  return template
    .replace(/\{\{(\w+)\}\}/g, (_, key: string) => fill[key] ?? '')
    .replace(/\n{3,}/g, '\n\n')
    .trim() + '\n';
}
