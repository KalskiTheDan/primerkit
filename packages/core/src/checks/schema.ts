import { Ajv2020 } from 'ajv/dist/2020.js';
import type { ValidateFunction } from 'ajv';
import type { Check, CheckFailure } from '../types';

const ajv = new Ajv2020({ allErrors: true, strict: false });
const compiled = new WeakMap<object, ValidateFunction>();

// The response validates against the operation's JSON Schema (draft 2020-12).
export const schemaCheck: Check = {
  id: 'schema',
  run(_packet, response, operation): CheckFailure[] {
    let validate = compiled.get(operation.schema);
    if (!validate) {
      validate = ajv.compile(operation.schema);
      compiled.set(operation.schema, validate);
    }
    if (validate(response)) return [];
    // A field the format does not allow is named, all of one object's in one failure, so a
    // refused trade field reads as one: "the response holds a field its format does not
    // allow: action", not "must NOT have additional properties".
    const said: Array<{ at: string; fields?: string[]; message?: string }> = [];
    for (const e of validate.errors ?? []) {
      const field = e.keyword === 'additionalProperties' ? (e.params as { additionalProperty?: unknown }).additionalProperty : undefined;
      const same = typeof field === 'string' ? said.find((s) => s.fields && s.at === e.instancePath) : undefined;
      if (typeof field !== 'string') said.push({ at: e.instancePath, message: e.message ?? 'does not match the schema' });
      else if (!same) said.push({ at: e.instancePath, fields: [field] });
      else if (!same.fields!.includes(field)) same.fields!.push(field);
    }
    return said.map((s) => ({
      check: 'schema',
      message: `${s.at || 'the response'} ${s.fields ? `holds ${s.fields.length === 1 ? 'a field' : 'fields'} its format does not allow: ${s.fields.join(', ')}` : s.message}`,
    }));
  },
};
