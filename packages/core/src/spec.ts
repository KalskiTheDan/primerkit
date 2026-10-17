import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import type { Operation, OperationSpec } from './types';

export const BUILT_IN_CHECKS = ['schema', 'citations', 'cites_data', 'grounded_numbers', 'grounded_directions', 'scope', 'in_diff', 'coverage'] as const;

export class SpecError extends Error {}

function need(cond: unknown, message: string): asserts cond {
  if (!cond) throw new SpecError(message);
}

// A text file with LF line endings, whatever the checkout wrote, so a packet and its
// hash are the same on every platform.
const readText = (path: string): string => readFileSync(path, 'utf8').replace(/\r\n/g, '\n');

// Reads an operation's folder: operation.yaml, the primer, the schema and the view.
export function loadOperation(dir: string): Operation {
  const specPath = join(dir, 'operation.yaml');
  need(existsSync(specPath), `no operation.yaml in ${dir}`);
  const raw = parse(readFileSync(specPath, 'utf8')) as Record<string, unknown>;
  const spec = validateSpec(raw);
  const primerPath = join(dir, 'primer.md');
  need(existsSync(primerPath), `no primer.md in ${dir}`);
  const schemaPath = join(dir, spec.output.schema);
  need(existsSync(schemaPath), `the schema ${spec.output.schema} is missing in ${dir}`);
  const renderPath = spec.render ? join(dir, spec.render) : null;
  return {
    spec,
    dir,
    primer: readText(primerPath).trim(),
    schema: JSON.parse(readText(schemaPath)) as Record<string, unknown>,
    render: renderPath && existsSync(renderPath) ? readText(renderPath) : null,
  };
}

export function validateSpec(raw: Record<string, unknown>): OperationSpec {
  need(typeof raw.id === 'string' && /^[a-z][a-z0-9.-]*$/.test(raw.id), 'id must be lower case letters, digits, dots and dashes');
  need(typeof raw.version === 'string', 'version is required');
  need(raw.kind === 'research' || raw.kind === 'strategy', 'kind must be research or strategy');
  need(typeof raw.title === 'string', 'title is required');
  const inputs = Array.isArray(raw.inputs) ? raw.inputs : [];
  const data = raw.data as Record<string, unknown> | undefined;
  need(data && Array.isArray(data.sources) && data.sources.length > 0, 'data.sources needs at least one source');
  const output = raw.output as Record<string, unknown> | undefined;
  need(output && typeof output.schema === 'string', 'output.schema is required');
  const checks = Array.isArray(raw.checks) ? (raw.checks as string[]) : [];
  for (const c of checks) need((BUILT_IN_CHECKS as readonly string[]).includes(c), `unknown check ${c}`);
  // Research operations may never return what a trade would need.
  const forbidden = Array.isArray(output.forbiddenFields) ? (output.forbiddenFields as string[]) : [];
  if (raw.kind === 'research') for (const f of ['action', 'side', 'size']) if (!forbidden.includes(f)) forbidden.push(f);
  return {
    id: raw.id,
    version: raw.version,
    kind: raw.kind,
    title: raw.title,
    inputs: inputs as OperationSpec['inputs'],
    data: {
      sources: data.sources as OperationSpec['data']['sources'],
      ...(typeof data.maxPacketTokens === 'number' ? { maxPacketTokens: data.maxPacketTokens } : {}),
    },
    output: { schema: output.schema, forbiddenFields: forbidden },
    checks,
    ...(typeof raw.render === 'string' ? { render: raw.render } : {}),
  };
}
