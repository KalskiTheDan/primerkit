// Preloaded into a primerkit command by free-key.test.ts (node --import): PreReason as a fake
// that answers every call with FAKE_PREREASON_STATUS, FAKE_PREREASON_BODY and the headers in
// FAKE_PREREASON_HEADERS, and writes each call's path to FAKE_PREREASON_LOG. A call to this
// machine goes through; a call to any other address is refused, so nothing leaves it.
import { appendFileSync } from 'node:fs';

const real = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = new URL(typeof input === 'string' || input instanceof URL ? String(input) : input.url);
  if (url.hostname === '127.0.0.1') return real(input, init);
  if (url.hostname !== 'api.prereason.com') throw new Error(`fake-prereason: ${url.hostname} is not PreReason, and nothing leaves this machine`);
  if (process.env.FAKE_PREREASON_LOG) appendFileSync(process.env.FAKE_PREREASON_LOG, `${url.pathname}\n`);
  return new Response(process.env.FAKE_PREREASON_BODY ?? '{}', { status: Number(process.env.FAKE_PREREASON_STATUS ?? 429), headers: JSON.parse(process.env.FAKE_PREREASON_HEADERS ?? '{}') });
};
