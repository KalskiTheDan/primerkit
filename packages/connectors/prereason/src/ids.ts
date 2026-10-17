import { companyBriefing, companyOf, equitiesRefusal, refusedEquities, type PacketFormat } from '@primerkit/core';

// Every request to PreReason is built from identifiers that match these patterns, so
// no free text, and nothing from a question or an account, can travel in one.

export const BRIEFING_ID = /^[a-z]+(?:\.[a-z0-9]+(?:-[a-z0-9]+)*)+$/;
export const METRIC_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const DATE = /^\d{4}-\d{2}-\d{2}$/;
export const FORMATS: readonly PacketFormat[] = ['json', 'markdown'];

export class RefusedRequest extends Error {}

// A company briefing names its company in its id, a code and never words (see
// @primerkit/core's company.ts); every other equities briefing is refused, and so is the
// family alone, which names no company.
export function assertBriefing(id: string): void {
  if (companyBriefing(id) === id) return;
  if (refusedEquities(id)) throw new RefusedRequest(equitiesRefusal(id));
  if (!BRIEFING_ID.test(id)) throw new RefusedRequest(`"${id}" is not a briefing id`);
}

export interface ContextRequest {
  briefing: string;
  format: PacketFormat;
  date?: string;
  // A company briefing's numbers block with its statement history (its quarters and fiscal
  // years), which PreReason serves at the company's own door, as it stands today.
  history?: boolean;
}

export function contextUrl(base: string, req: ContextRequest): string {
  assertBriefing(req.briefing);
  if (!FORMATS.includes(req.format)) throw new RefusedRequest(`"${req.format}" is not a format`);
  if (req.date !== undefined && !DATE.test(req.date)) throw new RefusedRequest(`"${req.date}" is not a date`);
  if (req.history) {
    const company = companyOf(req.briefing);
    if (!company) throw new RefusedRequest(`${req.briefing}: statement history is read for a company briefing only`);
    if (req.date) throw new RefusedRequest('statement history is served as it stands today, with no date');
    const door = new URL(`/api/companies/${encodeURIComponent(company)}/numbers`, base);
    door.searchParams.set('history', 'true');
    door.searchParams.set('format', req.format);
    return door.toString();
  }
  const url = new URL('/api/context', base);
  url.searchParams.set('briefing', req.briefing);
  url.searchParams.set('format', req.format);
  if (req.date) url.searchParams.set('date', req.date);
  return url.toString();
}
