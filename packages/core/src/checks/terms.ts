// Names written with digits that state no figure, taken out of a background sentence before
// its figures are counted (the wording review's ruling of 2026-10-14, 16:28Z). Background holds
// no number, and in the personas walk of 10-14 "10Y" and "10Y-2Y" in two background sentences
// cost a whole repair turn. Three kinds of name, and no others:
// - a maturity or term: digits then Y, W or D, as one word ("10Y", "2Y", "30D"), alone or
//   joined to another ("10Y-2Y", "2Y/10Y"); a month term ("3M") only before a rate word or
//   joined to another term (below);
// - a curve spread named by its maturities ("10s2s", "2s10s");
// - an index on a fixed list, NAMED_INDEXES ("the S&P 500"), never any word before a number.
// "10%", "5.21", "2026", "$4", "$3M" and "10 years" are still numbers, and so is "Apple 2000".
// In a claim these names are still figures, held to the lines it cites, as the rates lines
// name their maturity ("10Y Treasury yield at 5.11%"): a claim that gives the 2Y the 10Y's
// yield fails.

// The indexes whose names hold a number: the ruling's list, which holds every one the
// briefings and the saved fixtures name (the S&P 500, the Nasdaq 100 and the Russell 2000).
export const NAMED_INDEXES: readonly string[] = ['S&P 500', 'Russell 2000', 'Nasdaq 100', 'FTSE 100', 'Nikkei 225', 'Euro Stoxx 50', 'DAX 40', 'CAC 40', 'KOSPI 200', 'Nifty 50'];

// A name stands as a word of its own: not after a letter, a digit, a currency sign or a plus,
// nor after the first part of a decimal ("$3M" and "5.5M" are figures), and not before a letter
// or the rest of a decimal.
const START = String.raw`(?<![\w$€£+]|\d[.,])`;
const END = String.raw`(?!\w|[.,]\d)`;
const TERM = new RegExp(String.raw`${START}\d{1,3}(?:[YWD]|s\d{1,3}s)${END}`, 'g');

// A month term is also how a figure is written ("3M shares" is three million) and a company's
// name, so it is a name only before a rate word on this list ("the 3M bill") or joined to
// another term ("3M-10Y", "10Y-3M"); "3M shares" and "3M reported" still count (the wording
// review, 10-14, 16:52Z).
const RATE_WORDS: readonly string[] = ['bill', 'bills', 'T-bill', 'yield', 'yields', 'rate', 'rates', 'Treasury', 'SOFR'];
const ANY_TERM = String.raw`${START}\d{1,3}[YMWD]${END}`;
const MONTH = new RegExp(String.raw`${START}\d{1,3}M${END}(?=\s+(?:${RATE_WORDS.join('|')})(?![\w-])|[-/]${ANY_TERM})|(?<=${ANY_TERM}[-/])\d{1,3}M${END}`, 'g');

// An index is written as listed, in any case, with a space, a hyphen or nothing before its
// number: "S&P 500", "S&P500", "Nasdaq-100", "NASDAQ 100".
const listed = (name: string): string => {
  const [, words, number] = /^(.*\S)\s+(\d+)$/.exec(name)!;
  const said = words!.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+');
  return `${said}[\\s-]?${number}`;
};
const INDEX = new RegExp(String.raw`\b(?:${NAMED_INDEXES.map(listed).join('|')})${END}`, 'gi');

// A sentence with each of these names taken out, so that only its figures are left to count.
export function namesOut(text: string): string {
  // A month term is read before the other terms are taken out, as its pair may be one of them.
  return text.replace(INDEX, ' ').replace(MONTH, ' ').replace(TERM, ' ');
}
