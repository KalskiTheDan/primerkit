import { request as httpRequest } from 'node:http';
import type { CheckFailure, Packet } from '@primerkit/core';

export interface ChatMessage {
  role: 'system' | 'user';
  content: string;
}

export const SYSTEM_PROMPT = 'Answer with one JSON object that matches the schema in the packet, and nothing else.';

// The messages every chat runtime gets: the packet, and on a repair turn the checks
// the last answer failed. The packet carries the primer, the data and the schema. The
// repair goes in the same message as the packet, as the Anthropic adapter sends it: a
// model whose chat template needs the roles to alternate refuses two user messages in a row.
export function chatMessages(packet: Packet, repair?: CheckFailure[]): ChatMessage[] {
  const repairText = repairMessage(repair);
  return [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: repairText ? `${packet.text}\n\n${repairText}` : packet.text },
  ];
}

// Each failure as the person reads it, and what to do instead where the check says so: that
// part is for the model alone, and is shown nowhere else.
export function repairMessage(repair?: CheckFailure[]): string | null {
  if (!repair?.length) return null;
  return `Your last answer failed these checks:\n${repair.map((f) => `- ${f.check}: ${f.message}${f.fix ? `. ${f.fix}` : ''}`).join('\n')}\nAnswer again, fixing them. Quote cited lines exactly, and use only numbers those lines hold.`;
}

export class ModelError extends Error {
  constructor(
    message: string,
    readonly status: number | null = null,
  ) {
    super(message);
  }
}

// A server's address as a person types it: "127.0.0.1:1234/v1" or "localhost:1234/v1" is
// read as http://127.0.0.1:1234/v1; an address that names its scheme is kept as it is.
export function serverUrl(text: string): string {
  const typed = text.trim();
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(typed) ? typed : `http://${typed}`;
}

// Whether a server's address, as serverUrl reads it, is an address at all.
export function isServerUrl(text: string): boolean {
  try {
    const url = new URL(serverUrl(text));
    return (url.protocol === 'http:' || url.protocol === 'https:') && url.hostname !== '';
  } catch {
    return false;
  }
}

export function isLocalUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname;
    return host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]';
  } catch {
    return false;
  }
}

// The schema as a provider takes it: keywords that describe the document itself, such
// as $schema, are left out.
export function bareSchema(schema: Record<string, unknown>): Record<string, unknown> {
  const { $schema: _schema, $id: _id, ...rest } = schema;
  return rest;
}

// OpenAI's strict mode takes a schema only when every object lists all its properties
// as required and allows no others. Other schemas are sent without strict, and the
// checks hold the answer to the schema either way.
export function strictCompatible(schema: unknown): boolean {
  if (!schema || typeof schema !== 'object') return true;
  if (Array.isArray(schema)) return schema.every(strictCompatible);
  const s = schema as Record<string, unknown>;
  if (s.type === 'object' || s.properties) {
    const props = Object.keys((s.properties ?? {}) as object);
    const required = new Set((s.required ?? []) as string[]);
    if (s.additionalProperties !== false || props.some((p) => !required.has(p))) return false;
  }
  return Object.values(s).every(strictCompatible);
}

// A request that cannot reach its runtime at all says which runtime and where. One that
// reached it and then gave up waiting says so, since the model may only be slow.
export async function reach(fetchImpl: typeof fetch, url: string, init: RequestInit, who: string): Promise<Response> {
  try {
    return await fetchImpl(url, init);
  } catch (error) {
    if (init.signal?.aborted) throw error;
    const code = (error as { cause?: { code?: string }; code?: string }).cause?.code ?? (error as { code?: string }).code ?? '';
    if (/TIMEOUT/i.test(code)) throw new ModelError(`${who} at ${new URL(url).origin} took too long to answer (${code})`);
    throw new ModelError(`${who} is not answering at ${new URL(url).origin}`);
  }
}

const NO_BODY = new Set([101, 204, 205, 304]);

// Node's fetch gives up on a response whose headers take more than five minutes, and a
// local model sends none until it has read the whole packet and answered, which on a
// laptop can take longer. Runtimes on this machine are reached through node:http, which
// waits as long as the model needs; a stop still ends the wait.
export const localFetch: typeof fetch = (input, init = {}) => {
  const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
  if (url.protocol !== 'http:') return fetch(input, init);
  return new Promise<Response>((resolve, reject) => {
    const headers = Object.fromEntries(new Headers(init.headers).entries());
    const req = httpRequest(url, { method: init.method ?? 'GET', headers, ...(init.signal ? { signal: init.signal } : {}) }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('error', reject);
      res.on('end', () => {
        const status = res.statusCode ?? 502;
        const pairs = Object.entries(res.headers).flatMap(([k, v]): Array<[string, string]> => (v === undefined ? [] : Array.isArray(v) ? v.map((x): [string, string] => [k, x]) : [[k, v]]));
        resolve(new Response(NO_BODY.has(status) ? null : Buffer.concat(chunks), { status, headers: pairs }));
      });
    });
    req.on('error', reject);
    if (typeof init.body === 'string') req.write(init.body);
    req.end();
  });
};

// The message in an error body, so a refusal reads as the provider wrote it.
export async function errorText(res: Response): Promise<string> {
  const text = await res.text().catch(() => '');
  try {
    const body = JSON.parse(text) as { error?: { message?: string } | string; message?: string };
    const message = typeof body.error === 'string' ? body.error : (body.error?.message ?? body.message);
    if (message) return message;
  } catch {
    // not JSON
  }
  return text.slice(0, 200) || res.statusText;
}
