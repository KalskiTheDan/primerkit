import type { Check, CheckFailure } from '../types';
import { citedLine } from './citations';
import { claimsOf } from './shape';

// The block a routine's rules are in. Every other block in its packet is data the rules
// are applied to: a briefing, a metric, the price table or the position.
export const RULES_BLOCK = 'rules';

// A routine's label cites at least one line of the data, not the person's rules alone: an
// exit that cited only "rules line 2", and no line of what it was applied to, passed every
// other check (the personas walk, 10-14). A label that moves the account cites the rule it
// applies too; one that keeps what is held, such as watch, may stand on the data alone,
// since no rule may have given it (the wording review, 10-14). It never checks that the label
// follows the rules: they are the person's own words, and only a logic test's expected
// label catches a model that misreads them.
export const citesDataCheck: Check = {
  id: 'cites_data',
  run(packet, response, operation): CheckFailure[] {
    const cited = claimsOf(response)
      .flatMap((c) => c.citations)
      .filter((c) => citedLine(packet, c.block, c.line) !== null);
    // An answer that cites no line in the packet at all fails the citations check on every claim.
    if (!cited.length) return [];
    const failures: CheckFailure[] = [];
    if (cited.every((c) => c.block === RULES_BLOCK)) {
      failures.push({ check: 'cites_data', message: 'the label cites only your rules, and no line of the data they were applied to', fix: "Cite the lines of the data the rule was applied to, as well as the rule's line" });
    }
    const label = (response as { label?: unknown }).label;
    const holds = typeof label === 'string' && (operation.holdLabels ?? []).includes(label);
    if (typeof label === 'string' && !holds && !cited.some((c) => c.block === RULES_BLOCK)) {
      failures.push({ check: 'cites_data', message: `the label "${label}" cites no line of your rules, so which rule it applies is not shown`, fix: `Cite the line in block rules that gives ${label}` });
    }
    return failures;
  },
};
