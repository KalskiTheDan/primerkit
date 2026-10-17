import { longDay } from '@primerkit/core';
import { NEWS_MAX_DAYS } from './news';

// The day a question asks about, as code reads it: only exact dates. 2026-08-15, and a
// month by its name with its day, with or without the year: Aug 15, August 15, 2026,
// 15 August 2026. Nothing relative: "last Friday" or "yesterday" is a day the model in
// the loop names, never code. A day without its year is the latest one not after today.

const MONTHS: Record<string, number> = {
  jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3, apr: 4, april: 4, may: 5, jun: 6, june: 6,
  jul: 7, july: 7, aug: 8, august: 8, sep: 9, sept: 9, september: 9, oct: 10, october: 10, nov: 11, november: 11, dec: 12, december: 12,
};
const MONTH = 'jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?';
const ISO = /(?<![\d-])(\d{4})-(\d{2})-(\d{2})(?![\d-])/g;
const MONTH_DAY = new RegExp(`\\b(${MONTH})\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b(?:,?\\s+(\\d{4})\\b)?`, 'gi');
const DAY_MONTH = new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(${MONTH})\\b\\.?(?:,?\\s+(\\d{4})\\b)?`, 'gi');

export const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

// A date written as the end or the start of a reporting period names that period, not a day
// to read briefings on: "the quarter ended June 30, 2026", "the six months to June 30", "the
// nine months from April 1 to December 31, 2022". A period's figures come out after it ends,
// so reading as of its last day would read them before they were reported.
const PERIOD = '(?:years?|quarters?|months?|weeks?|half|period|fy)';
const BOUNDS_PERIOD = new RegExp(`(?:\\b(?:ended|ending|closed)(?:\\s+on)?|\\b${PERIOD}\\s+(?:to|through|from|starting|beginning))\\s+$`, 'i');
const RUNS_TO = /^\s*(?:to|through|until)\s*$/i;

// YYYY-MM-DD where that day is on the calendar, otherwise null.
export function realDay(year: number, month: number, day: number): string | null {
  const d = new Date(Date.UTC(year, month - 1, day));
  if (d.getUTCFullYear() !== year || d.getUTCMonth() !== month - 1 || d.getUTCDate() !== day) return null;
  return d.toISOString().slice(0, 10);
}

export interface NamedDays {
  days: string[]; // each a day on the calendar, YYYY-MM-DD, once each, in the order named
  periods: string[]; // the days that end or start a reporting period, never a day to read on
  unreal: string[]; // as written, where no such day exists: 2026-02-30
  written: string[]; // every date as the question writes it, so its words can be set aside
}

export function daysIn(question: string, today: string): NamedDays {
  const found: Array<{ at: number; day: string | null; written: string }> = [];
  const ty = Number(today.slice(0, 4));
  const withYear = (month: number, day: number, year: string | undefined): string | null => {
    if (year) return realDay(Number(year), month, day);
    // The latest such day not after today.
    const thisYear = realDay(ty, month, day);
    if (thisYear && thisYear <= today) return thisYear;
    return realDay(ty - 1, month, day);
  };
  for (const m of question.matchAll(ISO)) found.push({ at: m.index, day: realDay(Number(m[1]), Number(m[2]), Number(m[3])), written: m[0] });
  const named = (word: string): number | null => (word === 'may' ? null : (MONTHS[word.toLowerCase()] ?? null));
  for (const m of question.matchAll(MONTH_DAY)) {
    // "may" is a month only when it is written May: "it may 2x" names no day.
    const month = m[1] === 'May' ? 5 : named(m[1]!);
    if (month) found.push({ at: m.index, day: withYear(month, Number(m[2]), m[3]), written: m[0] });
  }
  for (const m of question.matchAll(DAY_MONTH)) {
    const month = m[2] === 'May' ? 5 : named(m[2]!);
    if (month) found.push({ at: m.index, day: withYear(month, Number(m[1]), m[3]), written: m[0] });
  }
  found.sort((a, b) => a.at - b.at);
  const days: string[] = [];
  const periods: string[] = [];
  const unreal: string[] = [];
  let bound: { at: number; written: string } | null = null;
  for (const f of found) {
    // A period's start runs on to its end: "from April 1 to December 31".
    const runsOn: boolean = bound !== null && RUNS_TO.test(question.slice(bound.at + bound.written.length, f.at));
    const isBound: boolean = runsOn || BOUNDS_PERIOD.test(question.slice(Math.max(0, f.at - 40), f.at));
    bound = isBound ? f : null;
    if (f.day === null) unreal.push(f.written.trim());
    else if (isBound) {
      if (!periods.includes(f.day)) periods.push(f.day);
    } else if (!days.includes(f.day)) days.push(f.day);
  }
  return { days, periods, unreal, written: found.map((f) => f.written) };
}

// What a question reads: as things stand now, as they stood on one past day, or nothing,
// with the reason, where the day it names cannot be read. period: it names a reporting
// period's dates and no other day, so it reads as things stand now.
export type DayOfQuestion = { kind: 'now' } | { kind: 'day'; day: string } | { kind: 'period'; days: string[] } | { kind: 'refused'; why: string } | { kind: 'none' };

// The day the question itself names. none: it names no day, so the model in the loop may.
// chart: what draws a series over a span of days where this question is asked.
export function dayOfQuestion(question: string, today: string, chart = '/chart'): DayOfQuestion {
  const { days, periods, unreal } = daysIn(question, today);
  if (unreal.length) return { kind: 'refused', why: `${unreal[0]} is not a day on the calendar, so nothing was read. Name a real day, such as as of ${dayExample(today)}.` };
  if (days.length > 1) {
    return {
      kind: 'refused',
      why: `This question names ${days.length} days (${days.map(longDay).join(', ')}). An answer reads one day: name one, such as as of ${days[0]}. For a span of days, ${chart} draws a series from one date to another.`,
    };
  }
  const day = days[0];
  if (!day) return periods.length ? { kind: 'period', days: periods } : { kind: 'none' };
  return checkedDay(day, today);
}

// A day handed in by a model or an AI app, held to the same rules: a real past day reads
// as that day, today reads as now, and a day still to come cannot be read.
export function checkedDay(day: string, today: string): DayOfQuestion {
  if (!ISO_DAY.test(day) || !realDay(...(day.split('-').map(Number) as [number, number, number]))) return { kind: 'refused', why: `${day} is not a day on the calendar, so nothing was read. Name a real day, such as as of ${dayExample(today)}.` };
  if (day > today) return { kind: 'refused', why: `${longDay(day)} has not come yet, so nothing was read. A briefing reads as it stood on a past day, such as as of ${dayExample(today)}.` };
  if (day === today) return { kind: 'now' };
  return { kind: 'day', day };
}

// The window a news question reads. A news record is about its own date, so a question about
// news may name a span: from its first named day to its last ("between September 28 and
// October 9"). One day: the window that ends on it (as_of). None: nothing is sent, and
// PreReason reads its own default, the 7 days ending today. A reporting period's dates name
// no window ("the quarter ended June 30"). A window longer than PreReason reads, a day not on
// the calendar, or one still to come, is refused here, before anything is asked.
export type NewsWindow = { kind: 'default' } | { kind: 'span'; since: string; until: string } | { kind: 'day'; asOf: string } | { kind: 'refused'; why: string };

const DAY_MS = 86_400_000;
const addDays = (day: string, n: number): string => new Date(Date.parse(`${day}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);

export function newsWindow(question: string, today: string): NewsWindow {
  const { days, unreal } = daysIn(question, today);
  if (unreal.length) return { kind: 'refused', why: `${unreal[0]} is not a day on the calendar, so nothing was read. Name a real day, such as ${longDay(dayExample(today))}.` };
  if (!days.length) return { kind: 'default' };
  const sorted = [...days].sort();
  return checkedWindow(sorted[0]!, sorted.at(-1)!, today);
}

// A window handed in by a model, held to the same rules; one day, as_of.
export function checkedWindow(since: string, until: string, today: string): NewsWindow {
  for (const day of [since, until]) {
    if (!ISO_DAY.test(day) || !realDay(...(day.split('-').map(Number) as [number, number, number]))) return { kind: 'refused', why: `${day} is not a day on the calendar, so nothing was read. Name a real day, such as ${longDay(dayExample(today))}.` };
  }
  if (until > today) return { kind: 'refused', why: `${longDay(until)} has not come yet, so nothing was read. PreReason's news holds what was filed or published up to today.` };
  if (since > until) return { kind: 'refused', why: `${longDay(since)} comes after ${longDay(until)}, so nothing was read. Name the earlier day first.` };
  if (since === until) return { kind: 'day', asOf: until };
  // As PreReason counts it: the days from since to until, at most 92.
  if ((Date.parse(`${until}T00:00:00Z`) - Date.parse(`${since}T00:00:00Z`)) / DAY_MS > NEWS_MAX_DAYS) {
    return {
      kind: 'refused',
      why: `From ${longDay(since)} to ${longDay(until)} is more than ${NEWS_MAX_DAYS} days, and PreReason's news reads at most ${NEWS_MAX_DAYS} days at a time, so nothing was read. Name a shorter span, such as ${longDay(addDays(until, -NEWS_MAX_DAYS))} to ${longDay(until)}.`,
    };
  }
  return { kind: 'span', since, until };
}

// A day a month before today, for the examples the notes give.
export function dayExample(today: string): string {
  const d = new Date(`${today}T00:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() - 1);
  return d.toISOString().slice(0, 10);
}
