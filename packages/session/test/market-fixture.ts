import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PreReasonClient } from '@primerkit/connector-prereason';

// The market map's and positioning's metrics as GET /api/metrics/{id} answers them, made
// up, read by the real client on a fake fetch: each answer is read as a key's would be,
// and no request leaves the machine.
const FIXTURE = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'market-metrics-2026-10-13.json'), 'utf8')) as { read_at: string; answers: Record<string, Record<string, unknown>> };

export const READ_AT = FIXTURE.read_at;

// A refusal as PreReason sends one, or any other answer that is not a metric.
export interface Refused {
  status: number;
  body: Record<string, unknown>;
  headers?: Record<string, string>;
}

export const TIER_REFUSED: Refused = { status: 403, body: { error: 'TIER_RESTRICTED', message: 'This metric needs a higher tier.' } };

export function answers(): Record<string, Record<string, unknown>> {
  return structuredClone(FIXTURE.answers);
}

// Each answer as served, with `over` in place of any: an object of fields merged into the
// served answer, a Refused, or null for a metric PreReason does not find. Each metric asked
// for is added to `asked` as the call goes out.
export function marketFetch(over: Record<string, Record<string, unknown> | Refused | null> = {}, asked: string[] = []): typeof fetch {
  return (async (url: string) => {
    const id = new URL(url).pathname.split('/').pop() ?? '';
    asked.push(id);
    const swap = id in over ? over[id] : undefined;
    if (swap && 'status' in swap && typeof swap.status === 'number' && 'body' in swap) return new Response(JSON.stringify(swap.body), { status: swap.status, ...(swap.headers ? { headers: swap.headers as Record<string, string> } : {}) });
    const answer = swap === null ? undefined : { ...FIXTURE.answers[id], ...(swap ?? {}) };
    if (!answer || !FIXTURE.answers[id]) return new Response(JSON.stringify({ error: 'NOT_FOUND', message: `No data found for metric '${id}'` }), { status: 404 });
    return new Response(JSON.stringify(answer), { status: 200 });
  }) as typeof fetch;
}

export function marketConnection(over: Record<string, Record<string, unknown> | Refused | null> = {}, asked: string[] = []): PreReasonClient {
  return new PreReasonClient({ key: null, version: '0.0.0', fetch: marketFetch(over, asked) });
}
