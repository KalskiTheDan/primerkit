import { LiveIntentError } from '@primerkit/core';
import { PreReasonError } from '@primerkit/connector-prereason';

// The error codes a script or an AI app reads, the same in --json output and in the MCP
// server's results: a key's tier refused the read, PreReason's rate window is spent, no key or
// no model is set, an answer failed its checks, the input was not usable, the thing named was
// not found, or anything else.
export const ERROR_CODES = ['tier_refused', 'rate_window', 'no_key', 'no_model', 'check_failed', 'bad_input', 'not_found', 'failed'] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];

export class CodedError extends Error {
  constructor(
    message: string,
    readonly code: ErrorCode = 'failed',
  ) {
    super(message);
  }
}

// The code an error is read as.
export function codeOf(error: unknown): ErrorCode {
  if (error instanceof CodedError) return error.code;
  if (error instanceof LiveIntentError) return 'bad_input';
  if (error instanceof PreReasonError) {
    if (error.tierRefusal) return 'tier_refused';
    if (error.status === 429) return 'rate_window';
    if (error.status === 401) return 'no_key';
    if (error.status === 404) return 'not_found';
  }
  return 'failed';
}

// An error as JSON: its code, its words, and for a rate window the wait PreReason named.
export function errorJson(error: unknown): { ok: false; error: { code: ErrorCode; message: string; retry_after_seconds?: number } } {
  const message = error instanceof Error ? error.message : String(error);
  const retry = error instanceof PreReasonError && error.retryAfterSeconds ? { retry_after_seconds: error.retryAfterSeconds } : {};
  return { ok: false, error: { code: codeOf(error), message, ...retry } };
}
