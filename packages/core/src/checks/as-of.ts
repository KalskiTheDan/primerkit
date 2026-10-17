import type { Check, CheckFailure } from '../types';

// A packet read for a past day says so, and the answer must name the same day in
// data_as_of, so an answer about that day is never shown as one about today. A packet read
// as things stand now asks nothing of data_as_of.
export const asOfCheck: Check = {
  id: 'as_of',
  run(packet, response): CheckFailure[] {
    if (!packet.asOf) return [];
    const said = response && typeof response === 'object' ? (response as { data_as_of?: unknown }).data_as_of : undefined;
    if (said === packet.asOf) return [];
    return [{ check: 'as_of', message: `data_as_of must be ${packet.asOf}, the day this packet was read for${typeof said === 'string' ? `, not ${said}` : ''}` }];
  },
};
