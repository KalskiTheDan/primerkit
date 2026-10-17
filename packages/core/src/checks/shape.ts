import type { Citation, Claim } from '../types';

// The claims of a response, read defensively: a response that failed its schema check
// can still be read for the claims it does have, so every check reports what it can.
export function claimsOf(response: unknown): Claim[] {
  if (!response || typeof response !== 'object') return [];
  // An ask's claims, or a digest's changes: each has text and citations.
  const r = response as { claims?: unknown; changes?: unknown };
  const claims = r.claims ?? r.changes;
  if (!Array.isArray(claims)) return [];
  return claims.map((c): Claim => {
    const obj = (c ?? {}) as { text?: unknown; citations?: unknown };
    const citations = Array.isArray(obj.citations)
      ? obj.citations.map((x): Citation => {
          const cit = (x ?? {}) as { block?: unknown; line?: unknown; quote?: unknown };
          return { block: String(cit.block ?? ''), line: Number(cit.line), quote: String(cit.quote ?? '') };
        })
      : [];
    return { text: String(obj.text ?? ''), citations };
  });
}

// An ask's background sentences, read as defensively as its claims: none where there are none.
export function backgroundOf(response: unknown): string[] {
  if (!response || typeof response !== 'object') return [];
  const background = (response as { background?: unknown }).background;
  return Array.isArray(background) ? background.map((s) => String(s ?? '')) : [];
}

// The sentence that sums a response up: an ask's answer, or a routine's reason for its
// label. Its numbers are held to the lines the claims cite.
export function answerKeyOf(response: unknown): 'answer' | 'reason' | null {
  if (!response || typeof response !== 'object') return null;
  const r = response as { answer?: unknown; reason?: unknown };
  return typeof r.answer === 'string' ? 'answer' : typeof r.reason === 'string' ? 'reason' : null;
}

export function answerOf(response: unknown): string {
  const key = answerKeyOf(response);
  return key ? String((response as Record<string, unknown>)[key]) : '';
}
