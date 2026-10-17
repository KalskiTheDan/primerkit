import { itemsOf } from '../diff';
import type { Check, CheckFailure } from '../types';

interface Change {
  item?: unknown;
  citations?: Array<{ block?: unknown; line?: unknown }>;
}

const changesOf = (response: unknown): Change[] => {
  const changes = (response as { changes?: unknown } | null)?.changes;
  return Array.isArray(changes) ? (changes as Change[]) : [];
};

// Nothing invented: every change the model writes is an item of the diff, and cites the
// line that item names.
export const inDiffCheck: Check = {
  id: 'in_diff',
  run(packet, response): CheckFailure[] {
    const items = new Map(itemsOf(packet.blocks.find((b) => b.id === 'diff')).map((i) => [i.id, i]));
    const failures: CheckFailure[] = [];
    changesOf(response).forEach((change, i) => {
      const item = items.get(String(change.item));
      if (!item) {
        failures.push({ check: 'in_diff', claim: i, message: `${String(change.item)} is not an item of the diff` });
        return;
      }
      const cites = (change.citations ?? []).some((c) => String(c.block) === item.briefing && Number(c.line) === item.line);
      if (!cites) failures.push({ check: 'in_diff', claim: i, message: `the change for ${item.id} must cite [${item.briefing} L${item.line}]` });
    });
    return failures;
  },
};

// Every item of the diff is covered by a change. A missed item does not stop the digest:
// it is shown as the diff states it, and the digest says so.
export const coverageCheck: Check = {
  id: 'coverage',
  run(packet, response): CheckFailure[] {
    const covered = new Set(changesOf(response).map((c) => String(c.item)));
    return itemsOf(packet.blocks.find((b) => b.id === 'diff'))
      .filter((item) => !covered.has(item.id))
      .map((item) => ({ check: 'coverage', message: `${item.id} has no change`, soft: true }));
  },
};
