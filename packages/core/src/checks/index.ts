import type { Check, CheckFailure, Operation, Packet } from '../types';
import { asOfCheck } from './as-of';
import { citationsCheck } from './citations';
import { citesDataCheck } from './cites-data';
import { groundedDirectionsCheck } from './directions';
import { groundedNumbersCheck } from './numbers';
import { schemaCheck } from './schema';
import { scopeCheck } from './scope';
import { coverageCheck, inDiffCheck } from './digest';

export { asOfCheck } from './as-of';
export { coverageCheck, inDiffCheck } from './digest';
export { citationsCheck, citedLine, normalizeSpace } from './citations';
export { RULES_BLOCK, citesDataCheck } from './cites-data';
export { COMPARATIVES, DIRECTION_WORDS, backsDirection, directionsIn, groundedDirectionsCheck, signOf, signOfWord, windowsIn, type Sign } from './directions';
export { claimFigures, figuresIn, groundedNumbersCheck, numbersIn, signedFiguresIn } from './numbers';
export { schemaCheck } from './schema';
export { MAX_BACKGROUND, NEWS_BLOCK, adviceIn, priceOrMoveIn, scopeCheck } from './scope';
export { answerKeyOf, answerOf, backgroundOf, claimsOf } from './shape';
export { NAMED_INDEXES, namesOut } from './terms';

export const CHECKS: Record<string, Check> = {
  schema: schemaCheck,
  citations: citationsCheck,
  cites_data: citesDataCheck,
  grounded_numbers: groundedNumbersCheck,
  grounded_directions: groundedDirectionsCheck,
  scope: scopeCheck,
  in_diff: inDiffCheck,
  coverage: coverageCheck,
  as_of: asOfCheck,
};

export interface CheckResult {
  id: string;
  failures: CheckFailure[];
}

// Runs the checks an operation names, in its order.
export function runChecks(operation: Operation, packet: Packet, response: unknown): CheckResult[] {
  return operation.spec.checks.map((id) => {
    const check = CHECKS[id];
    if (!check) throw new Error(`unknown check ${id}`);
    return { id, failures: check.run(packet, response, operation) };
  });
}

// Runs the checks an operation names on a model's reply. A reply in the wrong shape is held
// to its format alone, as one that is not JSON is: no other check runs on it, so none can
// be counted as held when it had nothing it was written to check (the review of 10-14). A
// field a trade would need is still refused: a schema that holds no such field fails it on
// its format, and one that lets it through leaves it to scope.
export function checkReply(operation: Operation, packet: Packet, response: unknown): CheckResult[] {
  if (operation.spec.checks.includes('schema')) {
    const failures = schemaCheck.run(packet, response, operation);
    if (failures.length) return [{ id: 'schema', failures: failures.map((f) => ({ ...f, reason: 'format' as const })) }];
  }
  return runChecks(operation, packet, response);
}
