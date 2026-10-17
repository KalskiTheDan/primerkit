import type { Check, CheckFailure, Packet } from '../types';
import { claimsOf } from './shape';

export const normalizeSpace = (s: string): string => s.replace(/\s+/g, ' ').trim();

// The line a citation names, or null when the block or the line does not exist.
export function citedLine(packet: Packet, block: string, line: number): string | null {
  const b = packet.blocks.find((x) => x.id === block);
  if (!b || !Number.isInteger(line) || line < 1) return null;
  const index = b.numbers ? b.numbers.indexOf(line) : line - 1;
  return index >= 0 ? (b.lines[index] ?? null) : null;
}

// Every claim cites at least one line; each cited line exists; and the quoted words
// appear in it verbatim, whitespace normalized.
export const citationsCheck: Check = {
  id: 'citations',
  run(packet, response): CheckFailure[] {
    const failures: CheckFailure[] = [];
    claimsOf(response).forEach((claim, i) => {
      if (claim.citations.length === 0) {
        failures.push({ check: 'citations', claim: i, message: 'the claim cites no line' });
        return;
      }
      for (const c of claim.citations) {
        const line = citedLine(packet, c.block, c.line);
        if (line === null) {
          failures.push({ check: 'citations', claim: i, message: `[${c.block} L${c.line}] is not a line in the packet` });
        } else if (!c.quote.trim() || !normalizeSpace(line).includes(normalizeSpace(c.quote))) {
          failures.push({ check: 'citations', claim: i, message: `the quote "${c.quote}" is not in [${c.block} L${c.line}]` });
        }
      }
    });
    return failures;
  },
};
