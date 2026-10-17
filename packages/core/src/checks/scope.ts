import { equitiesRefusal, refusedEquities } from '../company';
import type { Check, CheckFailure } from '../types';
import { answerOf, backgroundOf, claimsOf } from './shape';

// The background sentences an ask may add, as its primer says.
export const MAX_BACKGROUND = 4;

function keysDeep(value: unknown, out = new Set<string>()): Set<string> {
  if (Array.isArray(value)) for (const v of value) keysDeep(v, out);
  else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      out.add(k);
      keysDeep(v, out);
    }
  }
  return out;
}

// The words that tell a reader what to do with money, in a research operation's own
// sentences: a recommendation, the time to buy or sell, something worth buying, or an
// order given as a sentence of its own. Kept narrow, so that a sentence describing what
// buyers or sellers did ("buyers stepped in", "a sell-off", "short-term") passes.
const ADVICE: RegExp[] = [
  /\byou\s+(?:should|ought to|might want to|may want to|need to|must)\s+(?:buy|sell|hold|short|go long|go short|add to|trim|accumulate|exit|invest)\b/i,
  /\b(?:good|great|bad|right|ideal|best)\s+time\s+to\s+(?:buy|sell|invest|enter|exit|get in|get out|add)\b/i,
  /\bworth\s+(?:buying|selling|investing in|getting into)\b/i,
  /\b(?:i|we)\s+(?:recommend|suggest|advise)\b/i,
  /(?:^|[.;!?]\s+)(?:buy|sell|short|accumulate)(?![-\w])/i,
];

// The first advice phrase in a sentence, as written; null where there is none.
export function adviceIn(text: string): string | null {
  for (const re of ADVICE) {
    const m = re.exec(text);
    if (m) return m[0].replace(/^[.;!?\s]+/, '').trim();
  }
  return null;
}

// The block of PreReason's news records, one record a line, cited as [news L3].
export const NEWS_BLOCK = 'news';

// A price or a move set beside a news record (the wording review's rule, its rulings of 10-14):
// a move verb, a market price phrase, or a figure beside a move: a $ or % figure next to a move
// verb or to "higher" or "lower", or a % figure after "up" or "down" ("up 26%", "down by 3%").
// Kept to those, so "the CEO stepped down", "drew down $500 million" and "a 20% down payment"
// pass, and so does a figure the record itself states ("a $2 billion share repurchase"), which
// grounded_numbers holds to its line.
const MOVES = 'rose|fell|jumped|dropped|surged|plunged|soared|slid|tumbled|rallied|climbed|sank|spiked|slumped';
const PERCENT = String.raw`[+\-−]?\d[\d,]*(?:\.\d+)?\s?(?:%|percent\b|per cent\b)`;
const DOLLARS = String.raw`[+\-−]?[$€£]\s?\d[\d,]*(?:\.\d+)?(?:\s?(?:billion|million|thousand|bn|mn|m|k)\b)?`;
const BESIDE = `${MOVES}|higher|lower`;
const MOVE_VERB = new RegExp(String.raw`\b(?:${MOVES})\b`, 'i');
const PRICE_PHRASE = /\b(?:share price|stock price|price target|market cap(?:italization|italisation)?|market value|trading at|closed at)\b/i;
const FIGURE_BESIDE = new RegExp(String.raw`\b(?:${BESIDE})\s+(?:by\s+)?(?:${PERCENT}|${DOLLARS})|(?<![\w.])(?:${PERCENT}|${DOLLARS})\s+(?:${BESIDE})\b|\b(?:up|down)\s+(?:by\s+)?${PERCENT}`, 'i');

// The first price or move in a sentence, as written; null where there is none. Background
// holds no figure at all, so it is read for the words alone.
export function priceOrMoveIn(text: string, figures = true): string | null {
  for (const re of figures ? [FIGURE_BESIDE, MOVE_VERB, PRICE_PHRASE] : [MOVE_VERB, PRICE_PHRASE]) {
    const m = re.exec(text);
    if (m) return m[0].trim();
  }
  return null;
}

// What the person reads names what failed; what to do instead is said to the model alone, on
// its repair turn (the wording review, 10-14).
const besideRecord = (found: string): string => `a price or move beside a news record: "${found}"`;
const SAY_WHAT = 'Say what the record is and when instead';

// Research operations may not return what a trade would need, such as action, side or
// size, and only a strategy operation may return a label. Nor may their own sentences
// advise: the primer says "add no advice", and the answer and each claim are held to it
// (the quoted words are the briefing's, not the model's). Of the equities briefings, only
// a company briefing that names its company may be in a packet. A claim that cites a news
// record sets no price or move beside it, nor does the answer that sums such claims up, nor
// the background of a news answer: until 10-14 only the primer said so, and "its shares rose
// 26% after its 8-K [news L3]" passed every check.
export const scopeCheck: Check = {
  id: 'scope',
  run(packet, response, operation): CheckFailure[] {
    const failures: CheckFailure[] = [];
    const keys = keysDeep(response);
    const forbidden = [...operation.spec.output.forbiddenFields];
    if (operation.spec.kind === 'research') forbidden.push('label');
    // Each failure says which rule it broke, so the checks line names it, not advice words for all.
    for (const f of forbidden) if (keys.has(f)) failures.push({ check: 'scope', reason: 'field', message: `a ${operation.spec.kind} operation may not return ${f}` });
    if (operation.spec.kind === 'research') {
      for (const text of [answerOf(response), ...claimsOf(response).map((c) => c.text)]) {
        const advice = adviceIn(text);
        if (advice) failures.push({ check: 'scope', reason: 'advice', message: `a research operation gives no advice, and this sentence does: "${advice}". Describe what the lines say instead` });
      }
      // Background is held to the same rule, and to four sentences at most; a sentence that
      // breaks either is taken out on its own, as a failing claim is.
      backgroundOf(response).forEach((text, i) => {
        const advice = adviceIn(text);
        if (advice) failures.push({ check: 'scope', reason: 'background_advice', background: i, message: `background sentence ${i + 1} gives advice: "${advice}". Background explains; it gives no advice` });
        else if (i >= MAX_BACKGROUND) failures.push({ check: 'scope', reason: 'background_length', background: i, message: `background holds at most ${MAX_BACKGROUND} sentences, and sentence ${i + 1} is past them` });
      });
    }
    // A claim on a record is taken out on its own, as a failing claim is; the answer fails the run.
    const onRecords = claimsOf(response).map((c, i) => ({ i, text: c.text, cites: c.citations.some((x) => x.block === NEWS_BLOCK) })).filter((c) => c.cites);
    for (const c of onRecords) {
      const found = priceOrMoveIn(c.text);
      if (found) failures.push({ check: 'scope', reason: 'news_move', claim: c.i, message: besideRecord(found), fix: SAY_WHAT });
    }
    const summed = onRecords.length ? priceOrMoveIn(answerOf(response)) : null;
    if (summed) failures.push({ check: 'scope', reason: 'news_move', message: besideRecord(summed), fix: SAY_WHAT });
    // Background on a news answer is held to the move verbs and the price phrases, and a
    // sentence that holds one is taken out on its own, as other failing background is.
    const onNews = packet.blocks.some((b) => b.id === NEWS_BLOCK);
    backgroundOf(response).forEach((text, i) => {
      const found = onNews ? priceOrMoveIn(text, false) : null;
      if (found) failures.push({ check: 'scope', reason: 'news_move', background: i, message: besideRecord(found), fix: `Background sentence ${i + 1} explains, and sets no price or move beside a record` });
    });
    for (const b of packet.blocks) if (refusedEquities(b.id)) failures.push({ check: 'scope', reason: 'equities', message: equitiesRefusal(b.id) });
    return failures;
  },
};
