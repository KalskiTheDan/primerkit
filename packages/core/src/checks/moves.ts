// A move said with its figure: "up 2.5%", "a 2.5% fall", "a rise of 3 points". The walk of
// 2026-10-14: a digest said "up 2.5% over 7 days" of a line that gives "-2.5% (falling)", and
// every check passed. The wording review's ruling of 13:30Z makes each such move a rise or a
// fall, held to the sign test as the direction words are.

// A percent or points figure: "2.5%", "26 percent", "3 points", "a 3-point rise", "0.4
// percentage points", and basis points as rates are written, "25 basis points", "25bp", "10
// bps" (the wording review, 14:34Z).
export const MOVE_UNIT = String.raw`(?:%|percent\b|per cent\b|(?:percentage\s+|basis\s+)?points?\b|bps?\b)`;
export const MOVE_FIGURE = String.raw`\d[\d,]*(?:\.\d+)?[\s-]?${MOVE_UNIT}`;

// "up" or "down" directly before such a figure: "up 2.5%", "down by 0.4 points". Not before a
// $ figure, as the news check rules too: "paid down $1.2 billion", "drew down $500 million" and
// "wrote down $80 million" are a filing's facts. Nor alone: "the CEO stepped down" says no way
// a thing moved. A move noun beside such a figure: "a 2.5% fall", "a fall of 2.5%", "a 3%
// decline". Not "gain" or "loss", left out as "gained" and "lost" are: "a loss of $3 billion"
// is a filing's fact.
const RISES = ['up', 'rise', 'increase'];
const NOUNS = 'rise|increase|fall|drop|decrease|decline';
const MOVE = new RegExp(String.raw`\b(up|down)\s+(?:by\s+)?${MOVE_FIGURE}|\b(${NOUNS})\s+of\s+${MOVE_FIGURE}|(?<![\w.,])${MOVE_FIGURE}\s+(${NOUNS})\b`, 'gi');

export interface Move {
  said: string; // as written: "up 2.5%", "2.5% fall", "fall of 2.5%"
  at: number;
  sign: 'rise' | 'fall';
}

export function movesIn(text: string): Move[] {
  return [...text.matchAll(MOVE)].map((m) => {
    const word = (m[1] ?? m[2] ?? m[3])!.toLowerCase();
    return { said: m[0], at: m.index!, sign: RISES.includes(word) ? 'rise' : 'fall' };
  });
}
