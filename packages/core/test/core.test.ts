import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  CHECKS,
  CHECK_WORDS,
  DIRECTION_WORDS,
  Journal,
  NAMED_INDEXES,
  NEWS_BLOCK,
  adviceIn,
  priceOrMoveIn,
  answerView,
  backsDirection,
  checkReply,
  checksOf,
  checksText,
  directionsIn,
  signOf,
  windowsIn,
  figuresIn,
  signedFiguresIn,
  memoryGave,
  whenRead,
  blockFromJson,
  blockFromMarkdown,
  buildPacket,
  loadOperation,
  numbersIn,
  readConfig,
  renderMarkdown,
  runChecks,
  runOperation,
  RunCancelled,
  validateSpec,
  writeConfig,
  type CheckFailure,
  type DataBlock,
  type ModelAdapter,
  type ModelCapabilities,
  type Packet,
} from '../src/index';

const here = dirname(fileURLToPath(import.meta.url));
const ASK = loadOperation(join(here, '..', '..', '..', 'operations', 'ask'));
const FIXTURES = join(here, '..', '..', '..', 'operations', 'bench-comprehension', 'briefings-2026-09-25');
const FETCHED = '2026-09-25T09:06:00.000Z';

const md = (id: string): DataBlock => blockFromMarkdown(id, readFileSync(join(FIXTURES, `${id}.md`), 'utf8'), FETCHED);
const json = (id: string): DataBlock => blockFromJson(id, readFileSync(join(FIXTURES, `${id}.json`), 'utf8'), FETCHED);

// btc.pulse, as the markdown numbers it: L7 is the price, L11 the dominance.
const PULSE = md('btc.pulse');
const packetOf = (blocks: DataBlock[] = [PULSE], question = 'Where does Bitcoin stand?'): Packet =>
  buildPacket({ operation: ASK, question, blocks, runId: 'test-run' });

const PRICE = 'BTC at $84,512.32, up 10.6% over 7d.';
const DOMINANCE = 'BTC dominance at 58.5%, falling.';

function response(claims: Array<{ text: string; line: number; quote: string; block?: string }>, answer?: string): string {
  return JSON.stringify({
    answer: answer ?? claims.map((c) => c.text).join(' '),
    claims: claims.map((c) => ({ text: c.text, citations: [{ block: c.block ?? 'btc.pulse', line: c.line, quote: c.quote }] })),
    not_in_data: [],
  });
}

const GOOD = response([
  { text: 'Bitcoin is at $84,512.32, up 10.6% over 7 days.', line: 7, quote: PRICE },
  { text: 'BTC dominance is 58.5% and falling.', line: 11, quote: DOMINANCE },
]);

// A model that returns the texts it is given, one per turn.
class Scripted implements ModelAdapter {
  readonly id = 'scripted';
  readonly label = 'scripted';
  readonly repairs: Array<CheckFailure[] | undefined> = [];
  private turn = 0;
  constructor(private readonly texts: string[], private readonly caps: Partial<ModelCapabilities> = {}) {}
  async capabilities(): Promise<ModelCapabilities> {
    return { local: true, schemaConstraint: true, contextTokens: null, canRaiseContext: false, format: 'markdown', ...this.caps };
  }
  async complete(_packet: Packet, repair?: CheckFailure[]) {
    this.repairs.push(repair);
    const text = this.texts[Math.min(this.turn++, this.texts.length - 1)] ?? '';
    return { text };
  }
}

const failuresOf = (packet: Packet, text: string) => runChecks(ASK, packet, JSON.parse(text)).flatMap((r) => r.failures);

describe('the packet builder', () => {
  it('numbers every line of a briefing from 1, without blank lines', () => {
    expect(PULSE.lines[0]).toBe('# BTC Pulse');
    expect(PULSE.lines[6]).toContain(PRICE);
    expect(PULSE.lines.every((l) => l.trim().length > 0)).toBe(true);
    expect(PULSE.generatedAt).toBe('2026-09-25T09:05:00.000Z');
  });

  it('removes the MCP account line before numbering', () => {
    const block = blockFromMarkdown('btc.pulse', `[Account: free tier]\n\n# BTC Pulse\nBTC at $1.`, FETCHED);
    expect(block.lines).toEqual(['# BTC Pulse', 'BTC at $1.']);
  });

  it('writes each line with its id, as the model reads it', () => {
    const packet = packetOf();
    expect(packet.text).toContain(`[btc.pulse L7] ${PULSE.lines[6]}`);
    expect(packet.text).toContain('Question: Where does Bitcoin stand?');
    expect(packet.text.indexOf(ASK.primer.split('\n')[0]!)).toBe(0);
    expect(packet.text).toContain(JSON.stringify(ASK.schema));
  });

  it('puts the question last when asked, so its start is the same for any question and can be cached', () => {
    const last = (question: string) => buildPacket({ operation: ASK, question, blocks: [PULSE], runId: 'test-run', questionLast: true });
    const a = last('Where does Bitcoin stand?');
    const b = last('Is the trend up?');
    expect(a.cachePrefix).toBeGreaterThan(0);
    expect(a.text.slice(a.cachePrefix)).toMatch(/^Question: Where does Bitcoin stand\?\n/);
    expect(a.text.slice(0, a.cachePrefix)).toContain(`[btc.pulse L7] ${PULSE.lines[6]}`);
    expect(a.text.slice(0, a.cachePrefix)).not.toContain('Question:');
    expect(a.text.indexOf(`[btc.pulse L1]`)).toBeLessThan(a.text.indexOf('Question:'));
    expect(a.text.slice(0, a.cachePrefix)).toBe(b.text.slice(0, b.cachePrefix));
    expect(a.text.endsWith(JSON.stringify(ASK.schema))).toBe(true);
    // The usual packet keeps the question first, and says nothing of a cache.
    expect(packetOf().cachePrefix).toBeUndefined();
    expect(packetOf().text.indexOf('Question:')).toBeLessThan(packetOf().text.indexOf('[btc.pulse L1]'));
  });

  it('hashes the packet it sends and counts its tokens with a named proxy', () => {
    const packet = packetOf();
    expect(packet.hash).toBe(createHash('sha256').update(packet.text).digest('hex'));
    expect(packetOf().hash).toBe(packet.hash);
    expect(packet.tokens.count).toBeGreaterThan(100);
    expect(packet.tokens.label).toMatch(/o200k_base.*proxy/);
  });

  it('puts one JSON object on each line: the header, each metric, each correlation, then data quality', () => {
    const block = json('btc.pulse');
    const lines = block.lines.map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(lines[0]).toMatchObject({ briefing: 'btc.pulse', date: '2026-09-25' });
    expect(lines.slice(1, 4).map((l) => l.metric)).toEqual(['bitcoin-price', 'bitcoin-change-24h', 'bitcoin-dominance']);
    expect(lines[4]).toHaveProperty('correlation');
    expect(lines.at(-1)).toHaveProperty('data_quality');
  });

  it('leaves out the timing a response carries', () => {
    const body = JSON.parse(readFileSync(join(FIXTURES, 'btc.pulse.json'), 'utf8')) as Record<string, unknown>;
    const block = blockFromJson('btc.pulse', { ...body, _timing: { total_ms: 12 } }, FETCHED);
    expect(block.lines.some((l) => l.includes('_timing'))).toBe(false);
  });
});

describe('the checks', () => {
  const packet = packetOf();

  it('pass an answer whose claims quote and cite their lines', () => {
    expect(failuresOf(packet, GOOD)).toEqual([]);
  });

  it('schema: a missing field or an extra one fails', () => {
    const missing = JSON.stringify({ answer: 'x', claims: [] });
    expect(failuresOf(packet, missing).map((f) => f.check)).toContain('schema');
    const extra = JSON.stringify({ ...JSON.parse(GOOD), mood: 'calm' });
    expect(failuresOf(packet, extra).map((f) => f.check)).toContain('schema');
  });

  it('schema: names a field the format does not allow, so a refused trade field reads as one', () => {
    const format = (over: Record<string, unknown>) => failuresOf(packet, JSON.stringify({ ...JSON.parse(GOOD), ...over })).filter((f) => f.check === 'schema').map((f) => f.message);
    expect(format({ action: 'buy' })).toEqual(['the response holds a field its format does not allow: action']);
    // Two of one object's fields, named together.
    expect(format({ action: 'buy', size: 0.5 })).toEqual(['the response holds fields its format does not allow: action, size']);
    // A field inside a claim is named where it is.
    const deep = JSON.parse(GOOD) as { claims: Array<Record<string, unknown>> };
    deep.claims[0]!.side = 'long';
    expect(failuresOf(packet, JSON.stringify(deep)).filter((f) => f.check === 'schema').map((f) => f.message)).toEqual(['/claims/0 holds a field its format does not allow: side']);
    // CONTROL: a failure of another kind keeps the validator's own words.
    expect(failuresOf(packet, JSON.stringify({ answer: 'x', claims: [] })).filter((f) => f.check === 'schema').map((f) => f.message)).toEqual(["the response must have required property 'not_in_data'"]);
  });

  it('citations: a line that does not exist, or a quote that is not in its line, fails', () => {
    const noLine = response([{ text: 'BTC dominance is 58.5%.', line: 99, quote: DOMINANCE }]);
    expect(failuresOf(packet, noLine)).toContainEqual(expect.objectContaining({ check: 'citations', claim: 0, message: '[btc.pulse L99] is not a line in the packet' }));
    const wrongQuote = response([{ text: 'BTC dominance is 58.5%.', line: 11, quote: 'BTC dominance at 60%' }]);
    expect(failuresOf(packet, wrongQuote).map((f) => f.check)).toContain('citations');
    const otherBlock = response([{ text: 'BTC dominance is 58.5%.', line: 11, quote: DOMINANCE, block: 'btc.full' }]);
    expect(failuresOf(packet, otherBlock).map((f) => f.check)).toContain('citations');
  });

  it('citations: spacing inside a quote is not held against it', () => {
    const spaced = response([{ text: 'BTC dominance is 58.5%.', line: 11, quote: 'BTC  dominance   at 58.5%,' }]);
    expect(failuresOf(packet, spaced)).toEqual([]);
  });

  it('grounded numbers: formatting is not a difference, rounding is', () => {
    expect(numbersIn('$84,512.32, up 10.6% and −2.1')).toEqual(['84512.32', '10.6', '2.1']);
    // Zeros at the end of a decimal are formatting, and a whole number keeps its own.
    expect(numbersIn('-0.40%, 5.00, 10.50, 0.0 and 100')).toEqual(['0.4', '5', '10.5', '0', '100']);
    const rounded = response([{ text: 'Bitcoin is at $84,512, up 10.6% over 7 days.', line: 7, quote: PRICE }]);
    expect(failuresOf(packet, rounded)).toContainEqual(expect.objectContaining({ check: 'grounded_numbers', claim: 0 }));
    const invented = response([{ text: 'Bitcoin is at $90,000.', line: 7, quote: PRICE }]);
    expect(failuresOf(packet, invented)).toContainEqual(expect.objectContaining({ check: 'grounded_numbers', message: '90000 is not in the lines this claim cites' }));
  });

  it('grounded numbers: a rule or a line named by its number is no figure, and a figure beside it still counts', () => {
    // The test rounds of 2026-10-09: "neither above +5% (rule 1) nor below -5% (rule 2)" failed
    // its check on the 1 and the 2, on 17 of 27 backtest ticks.
    expect(figuresIn('Rule 3 gives watch: 58.5% is neither above rule 1 nor below rules 2 and 3, as line 11 and L12 say [btc.pulse L11].')).toEqual(['58.5']);
    const named = response([{ text: 'BTC dominance is 58.5%, which rule 1 compares and rules 2 and 3 do not.', line: 11, quote: DOMINANCE }], 'Rule 1 gives the label: dominance is 58.5%.');
    expect(failuresOf(packet, named)).toEqual([]);
    const invented = response([{ text: 'Rule 2 applies, since dominance fell 7.5%.', line: 11, quote: DOMINANCE }]);
    expect(failuresOf(packet, invented)).toContainEqual(expect.objectContaining({ check: 'grounded_numbers', claim: 0, message: '7.5 is not in the lines this claim cites' }));
  });

  it('grounded numbers: a figure right after a rule or a line number is a figure, not part of the reference', () => {
    // Found reading the code on 2026-10-09: the list of rule numbers took "3, 58,000" whole.
    expect(figuresIn('By rule 3, 58,000 is the floor.')).toEqual(['58000']);
    expect(figuresIn('The trend line 61,250 held.')).toEqual(['61250']);
    expect(figuresIn('Rules 1 and 2.5% more.')).toEqual(['2.5']);
    expect(figuresIn('Steps 2 to 15% above.')).toEqual(['15']);
    expect(figuresIn('Rule 4 - 2.1% lower.')).toEqual(['2.1']);
    // CONTROL: references alone still name no figure.
    expect(figuresIn('Rules 1, 2 and 3 apply, as lines 4 to 6 say.')).toEqual([]);
    const invented = response([{ text: 'By rule 1, 58,000 is the floor.', line: 11, quote: DOMINANCE }]);
    expect(failuresOf(packet, invented)).toContainEqual(expect.objectContaining({ check: 'grounded_numbers', claim: 0, message: '58000 is not in the lines this claim cites' }));
  });

  it('grounded numbers: the answer may state no number its claims do not cite', () => {
    const text = response([{ text: 'BTC dominance is 58.5%.', line: 11, quote: DOMINANCE }], 'Dominance is 58.5% and Bitcoin is at $84,512.32.');
    expect(failuresOf(packet, text)).toContainEqual({ check: 'grounded_numbers', message: 'the answer states 84512.32, which no cited line holds' });
  });

  it('scope: a research answer may not carry a label, an action, a side or a size, however deep', () => {
    const labelled = JSON.stringify({ ...JSON.parse(GOOD), label: 'bullish' });
    expect(failuresOf(packet, labelled)).toContainEqual(expect.objectContaining({ check: 'scope', message: 'a research operation may not return label' }));
    const deep = JSON.parse(GOOD) as { claims: Array<Record<string, unknown>> };
    deep.claims[0]!.side = 'buy';
    expect(failuresOf(packet, JSON.stringify(deep))).toContainEqual(expect.objectContaining({ check: 'scope', message: 'a research operation may not return side' }));
  });

  it('scope: a research answer gives no advice in its own words, and words that describe trading pass', () => {
    // The test rounds of 2026-10-08: "You should buy Bitcoin now" passed all four checks.
    const told = response([{ text: 'BTC dominance is 58.5%.', line: 11, quote: DOMINANCE }], 'You should buy Bitcoin now; it is a good time to buy.');
    expect(failuresOf(packet, told)).toContainEqual(expect.objectContaining({ check: 'scope', message: expect.stringContaining('a research operation gives no advice, and this sentence does: "You should buy"') }));
    // A claim alone: the answer sentence is clean.
    const inClaim = response([{ text: 'Dominance is 58.5%, so Bitcoin is worth buying.', line: 11, quote: DOMINANCE }], 'BTC dominance is 58.5%.');
    expect(failuresOf(packet, inClaim)).toContainEqual(expect.objectContaining({ check: 'scope', message: expect.stringContaining('"worth buying"') }));
    for (const said of ['Buy now.', 'Dominance rose. Sell before it turns.', 'We recommend caution.', 'Now is the right time to get in.']) expect(adviceIn(said), said).not.toBeNull();
    for (const said of ['Buyers stepped in after the sell-off.', 'Short-term momentum is accelerating.', 'Selling pressure eased.', 'ETF holders added 1,000 BTC.', 'The 10-year yield is at 4.1%.', 'A buy signal is not given here.']) expect(adviceIn(said), said).toBeNull();
    expect(failuresOf(packet, GOOD)).toEqual([]);
  });

  it('scope: a claim that cites a news record sets no price or move beside it, as the wording review ruled on 10-14', () => {
    // Made-up records, one a line, as the news block numbers them.
    const NEWS: DataBlock = { id: NEWS_BLOCK, source: 'prereason', format: 'markdown', fetchedAt: FETCHED, heading: "PreReason's news (block news)", lines: [
      'Oct 8, 2026 · FILED · Fictional Group Corp · 8-K item 5.02, departure of directors or certain officers · Sample Filings Registry 8-K items',
      'Oct 7, 2026 · FILED · Fictional Group Corp · 8-K item 8.01, other events: a $2 billion share repurchase · Sample Filings Registry 8-K items',
      'Oct 1, 2026 · FILED · Fictional Group Corp · 8-K item 8.01, other events: its offering priced at $20 per share · Sample Filings Registry 8-K items',
    ] };
    const news = packetOf([NEWS]);
    const onRecord = (text: string, line: number, quote: string, answer = 'Fictional Group Corp filed 8-K items.') => failuresOf(news, response([{ text, line, quote, block: NEWS_BLOCK }], answer)).filter((f) => f.check === 'scope');
    // What the person reads names what failed; what to do instead is the model's alone.
    const beside = (found: string) => [{ check: 'scope', reason: 'news_move', claim: 0, message: `a price or move beside a news record: "${found}"`, fix: 'Say what the record is and when instead' }];
    // FAILS, each a failure of its claim alone, so the repair turn and then the claim's removal follow.
    expect(onRecord("Fictional Group Corp's shares rose 26% after its 8-K.", 3, '8-K item 8.01')).toEqual(beside('rose 26%'));
    expect(onRecord('The stock fell after the filing.', 3, '8-K item 8.01')).toEqual(beside('fell'));
    expect(onRecord('Fictional Group Corp was trading at $41 after the release.', 3, '8-K item 8.01')).toEqual(beside('trading at'));
    expect(onRecord('Fictional Group Corp fell $3 after the filing.', 3, '8-K item 8.01')).toEqual(beside('fell $3'));
    expect(onRecord('Fictional Group Corp ended $4 lower after the filing.', 3, '8-K item 8.01')).toEqual(beside('$4 lower'));
    // PASSES: a departure, a debt paid or drawn and a value written down, and figures the
    // record itself states, which grounded_numbers holds to its line.
    expect(onRecord("Fictional Group Corp's CEO stepped down, as its 8-K of Oct 8, 2026 reports.", 1, 'departure of directors or certain officers')).toEqual([]);
    for (const said of ['Fictional Group Corp drew down $500 million under its credit facility.', 'Fictional Group Corp paid down $1.2 billion of its notes.', 'Fictional Group Corp wrote down $80 million of goodwill.']) expect(onRecord(said, 3, '8-K item 8.01'), said).toEqual([]);
    const repurchase = response([{ text: 'Fictional Group Corp announced a $2 billion share repurchase.', line: 2, quote: 'a $2 billion share repurchase', block: NEWS_BLOCK }]);
    expect(failuresOf(news, repurchase)).toEqual([]);
    const offering = response([{ text: 'Fictional Group Corp priced its offering at $20 per share.', line: 3, quote: 'its offering priced at $20 per share', block: NEWS_BLOCK }]);
    expect(failuresOf(news, offering)).toEqual([]);
    // The answer that sums such claims up is held too, and fails the run as a whole.
    expect(onRecord('Fictional Group Corp filed an 8-K on Oct 1, 2026.', 3, '8-K item 8.01', 'Fictional Group Corp filed an 8-K, and its share price jumped.')).toEqual([{ check: 'scope', reason: 'news_move', message: 'a price or move beside a news record: "jumped"', fix: 'Say what the record is and when instead' }]);
    // Background on a news answer is held to the move verbs and the price phrases, each
    // sentence on its own, as other failing background is.
    const withBackground = JSON.stringify({ ...JSON.parse(response([{ text: 'Fictional Group Corp filed an 8-K on Oct 1, 2026.', line: 3, quote: '8-K item 8.01', block: NEWS_BLOCK }])), background: ['A current report names events a company discloses.', 'The stock fell after the filing.', 'Its market value is watched.'] });
    expect(failuresOf(news, withBackground)).toEqual([
      { check: 'scope', reason: 'news_move', background: 1, message: 'a price or move beside a news record: "fell"', fix: 'Background sentence 2 explains, and sets no price or move beside a record' },
      { check: 'scope', reason: 'news_move', background: 2, message: 'a price or move beside a news record: "market value"', fix: 'Background sentence 3 explains, and sets no price or move beside a record' },
    ]);
    // CONTROL: the same words in a claim, or in background, on a briefing line are no record's, and pass.
    const briefing = response([{ text: 'Bitcoin rose to $84,512.32, up 10.6% over 7 days.', line: 7, quote: PRICE }]);
    expect(failuresOf(packet, briefing)).toEqual([]);
    expect(failuresOf(packet, JSON.stringify({ ...JSON.parse(briefing), background: ['Prices often fell after a halving.'] }))).toEqual([]);
  });

  it("scope: the wording review's words for a price or move, and the words it ruled out", () => {
    // (a) the move verbs, (b) the market price phrases, (c) a $ or % figure next to a move verb
    // or to higher or lower, or a % figure after up or down, with or without "by".
    for (const verb of ['rose', 'fell', 'jumped', 'dropped', 'surged', 'plunged', 'soared', 'slid', 'tumbled', 'rallied', 'climbed', 'sank', 'spiked', 'slumped']) expect(priceOrMoveIn(`Its shares ${verb.toUpperCase()} after the filing.`), verb).toBe(verb.toUpperCase());
    for (const phrase of ['share price', 'stock price', 'price target', 'market cap', 'market capitalization', 'market value', 'trading at', 'closed at']) expect(priceOrMoveIn(`The filing named its ${phrase} then.`), phrase).toBe(phrase);
    for (const [said, found] of [['Its shares were up 26% on the day.', 'up 26%'], ['It was down 3% by the close.', 'down 3%'], ['They ended 26% higher.', '26% higher'], ['It ended $1.5 billion lower.', '$1.5 billion lower'], ['It was higher by 4.5 percent.', 'higher by 4.5 percent'], ['It rose 7% on Oct 7.', 'rose 7%'], ['It fell $3 on the day.', 'fell $3'], ['It ended $4 lower.', '$4 lower'], ['It was up by 26% on the day.', 'up by 26%'], ['It was down by 3% at the close.', 'down by 3%']]) expect(priceOrMoveIn(said!), said).toBe(found);
    // Ruled out as words of their own: shares, stock, price, up, down, gained and lost; a
    // figure next to none of the words; a $ figure after up or down, which names a debt drawn
    // or paid, or a value written down; and a % figure before up or down, as in a filing's own
    // "a 20% down payment".
    for (const said of ['The CEO stepped down.', 'It set up a $2 billion share repurchase plan.', 'The stock exchange listed its shares.', 'The price of the offering was $20 per share.', 'It gained approval and lost a lawsuit.', 'It holds a 26% stake, up from none.', 'Its notes pay 5.25%.', 'It drew down $500 million.', 'It paid down $1.2 billion.', 'It wrote down $80 million.', 'It made a 20% down payment.', 'It ended 26% up on the year.']) expect(priceOrMoveIn(said), said).toBeNull();
    // Background holds no figure, so it is read for the words alone.
    expect(priceOrMoveIn('The stock fell after the filing.', false)).toBe('fell');
    expect(priceOrMoveIn('It was up 26% after the filing.', false)).toBeNull();
  });

  it('scope: an equities block is refused', () => {
    const equities: DataBlock = { id: 'equities.fxmp', source: 'prereason', format: 'markdown', fetchedAt: FETCHED, lines: ['FXMP at $1.'] };
    expect(failuresOf(packetOf([PULSE, equities]), GOOD)).toContainEqual(expect.objectContaining({ check: 'scope' }));
  });

  it('research operations always forbid action, side and size', () => {
    const spec = validateSpec({ id: 'mine', version: '1', kind: 'research', title: 't', data: { sources: [{ connector: 'file', path: 'x' }] }, output: { schema: 's.json' }, checks: [] });
    expect(spec.output.forbiddenFields).toEqual(['action', 'side', 'size']);
  });
});

// The full run of 2026-10-14: a Free key read the yield curve's latest reading alone, and
// "The yield curve is currently steepening to 0.42%" passed 4 of 4 checks. L2 and L5 are as
// PreReason served them that day; the lines around them are made up for the test.
describe('grounded directions: a direction needs a change in the lines a claim cites', () => {
  const CURVE = blockFromMarkdown(
    'yield-curve',
    [
      '# Yield Curve Spread (10Y-2Y)',
      '**Latest reading:** 0.42%',
      '*Source: Sample Statistics Office | Updated: 2026-10-13T00:00:00Z | 1 day old*',
      '---',
      'A free key reads the latest reading of this metric. Its interpretation, trend and context are served at the basic tier and above.',
    ].join('\n\n'),
    FETCHED,
  );
  const LEVEL = '**Latest reading:** 0.42%';
  const STEEP = 'The yield curve is currently steepening to 0.42%.';
  const curve = (claims: Array<{ text: string; line: number; quote: string }>, answer?: string) => response(claims.map((c) => ({ ...c, block: 'yield-curve' })), answer);
  const directionFailures = (blocks: DataBlock[], text: string) => failuresOf(packetOf(blocks), text).filter((f) => f.check === 'grounded_directions');

  it('fails "steepening" cited to a latest reading alone, and after the repair turn cuts the claim and names it', async () => {
    expect(CURVE.lines[1]).toBe(LEVEL);
    expect(CURVE.lines[4]).toMatch(/^A free key reads the latest reading/);
    const steep = curve([{ text: STEEP, line: 2, quote: LEVEL }]);
    expect(directionFailures([CURVE], steep)).toEqual([
      { check: 'grounded_directions', claim: 0, message: '"steepening" is a direction the lines this claim cites do not hold: none of them states a change' },
      { check: 'grounded_directions', message: 'the answer states "steepening", a direction no cited line holds' },
    ]);
    // Citing the line that says the trend is not served backs no direction either.
    const withNotice = JSON.parse(steep) as { claims: Array<{ citations: unknown[] }> };
    withNotice.claims[0]!.citations.push({ block: 'yield-curve', line: 5, quote: 'Its interpretation, trend and context are served at the basic tier and above.' });
    expect(directionFailures([CURVE], JSON.stringify(withNotice)).map((f) => f.claim)).toEqual([0, undefined]);

    // The answer of that run, on its own: the repair turn names the failure, and the claim,
    // still failing, is taken out, so no claim is left to show.
    const alone = new Scripted([steep, steep]);
    const failed = await runOperation({ operation: ASK, question: 'Is the yield curve steepening?', blocks: [CURVE], model: alone });
    expect(alone.repairs[1]?.map((f) => f.check)).toContain('grounded_directions');
    expect(failed.outcome).toBe('failed');
    expect(failed.dropped).toEqual([{ claim: expect.objectContaining({ text: STEEP }), reasons: ['"steepening" is a direction the lines this claim cites do not hold: none of them states a change'] }]);

    // Beside a claim the line does hold, the level stands, and the direction is taken out and
    // named; the answer, which said "steepening", is replaced by the checked claim.
    const mixed = curve([{ text: 'The yield curve spread is at 0.42%.', line: 2, quote: LEVEL }, { text: STEEP, line: 2, quote: LEVEL }], STEEP);
    const result = await runOperation({ operation: ASK, question: 'Is the yield curve steepening?', blocks: [CURVE], model: new Scripted([mixed, mixed]) });
    expect(result.outcome).toBe('partial');
    expect(result.response?.claims.map((c) => c.text)).toEqual(['The yield curve spread is at 0.42%.']);
    expect(result.response?.answer).toBe('The yield curve spread is at 0.42%.');
    const text = renderMarkdown(ASK.render!, answerView(result)!);
    expect(text).toContain(`Partial answer. Not supported by the data, so taken out: "${STEEP}".`);
    expect(text).not.toContain('**The yield curve is currently steepening');
  });

  it('passes "Net liquidity rose 1.3% over 7 days" cited to a line that states the 7 day change, however it is served', () => {
    const ROSE = 'Net liquidity rose 1.3% over 7 days, to $5.87T.';
    // A metric's sentence, as PreReason serves it: "<level>; 7d <signed change>".
    const metric = blockFromMarkdown('net-liquidity', '# Net Liquidity\n\n**Latest reading:** $5.87T\n\nNet liquidity at $5.87T; 7d +1.3%.', FETCHED);
    const rose = response([{ text: ROSE, line: 3, quote: 'Net liquidity at $5.87T; 7d +1.3%.', block: 'net-liquidity' }]);
    expect(failuresOf(packetOf([metric]), rose)).toEqual([]);
    // CONTROL: the same claim cited to the latest reading alone fails, and so does the answer.
    const level = response([{ text: ROSE, line: 2, quote: '**Latest reading:** $5.87T', block: 'net-liquidity' }]);
    expect(directionFailures([metric], level).map((f) => f.claim)).toEqual([0, undefined]);
    // Each way a line states a change backs a direction: a glyph, a figure over a period, a
    // period and a signed figure, a change with its figure, from one reading to another.
    for (const line of [
      'Net liquidity $5.87T ▲ 1.3%',
      'Net liquidity $5.87T ▼ 1.3%',
      'Net liquidity at $5.87T, up 1.3% over 7d.',
      'Net liquidity at $5.87T, 1.3% over 7 days.',
      'Net liquidity at $5.87T; 7d -1.3%.',
      'S&P 500 e-mini net position at percentile 61.5 of the prior 26 weekly reports; 7d +11.5.',
      'Net liquidity at $5.87T, +1.3% over 30d.',
      'BTC 24h change at +1.08%, up.',
      'Net liquidity 7-day change of 1.3%.',
      'Net liquidity moved from $5.79T to $5.87T.',
      'Net liquidity rising at $5.87T.',
    ]) expect(backsDirection(line), line).toBe(true);
    // A level, a correlation, a negative level, a tenor, a period with no figure, and the
    // tier's own note back none.
    for (const line of [
      LEVEL,
      '**Latest reading:** -0.12%',
      '- **Bitcoin Price vs BTC Dominance:** 0.26: Weak positive correlation (+0.26) [n=29d]',
      'Yield curve spread (10Y - 2Y) at 0.42%.',
      '**Bitcoin price, mining health, and liquidity overview with 7-day and 30-day trend signals**',
      'A free key reads the latest reading of this metric. Its interpretation, trend and context are served at the basic tier and above.',
      'Changes are served at the basic tier and above.',
    ]) expect(backsDirection(line), line).toBe(false);
  });

  it("reads PreReason's own lines of 2026-09-25: each that states a change backs a direction", () => {
    // Every markdown sentence with a figure over 7 or 30 days, and every JSON metric with its trend.
    const said = ['btc.pulse', 'btc.context', 'btc.grid-stress', 'macro.snapshot'].flatMap((id) => md(id).lines.filter((l) => / over (?:7|30)d\b/.test(l)));
    expect(said.length).toBeGreaterThan(15);
    for (const line of said) expect(backsDirection(line), line).toBe(true);
    const metrics = ['btc.pulse', 'btc.context', 'btc.grid-stress', 'macro.snapshot'].flatMap((id) => json(id).lines.filter((l) => l.startsWith('{"metric"') && l.includes('"trend"')));
    expect(metrics.length).toBeGreaterThan(15);
    for (const line of metrics) expect(backsDirection(line), line).toBe(true);
  });

  it('holds direction words whole and in any case, and never bare "up" or "down": "the CEO stepped down" is no direction', () => {
    expect(directionsIn('Yields Rising, a surprising move; the curve is STEEPENING and dominance lower.')).toEqual(['rising', 'steepening', 'lower']);
    expect(directionsIn('The CEO stepped down on Oct 1, and the shares are up.')).toEqual([]);
    const news: DataBlock = { id: 'news', source: 'prereason', format: 'markdown', fetchedAt: FETCHED, lines: ['2026-10-01 · FILED · Fictional Corp · 8-K · the CEO stepped down'] };
    const stepped = response([{ text: 'Fictional Corp filed that its CEO stepped down on 2026-10-01.', line: 1, quote: 'the CEO stepped down', block: 'news' }]);
    expect(directionFailures([news], stepped)).toEqual([]);
    // CONTROL: a direction word in the same claim is caught.
    const rose = response([{ text: "Fictional Corp's shares rose after its CEO stepped down on 2026-10-01.", line: 1, quote: 'the CEO stepped down', block: 'news' }]);
    expect(directionFailures([news], rose).filter((f) => f.claim === 0).map((f) => f.message)).toEqual(['"rose" is a direction the lines this claim cites do not hold: none of them states a change']);
    expect(DIRECTION_WORDS).not.toContain('up');
    expect(DIRECTION_WORDS).not.toContain('down');
  });

  it("holds the words of the wording review of 2026-10-14: moves and trend states, and not inverted, gained or lost", () => {
    expect(directionsIn('Yields jumped and spiked, then eased; the dollar slid and tumbled; Bitcoin rallied, peaked and sank.')).toEqual(['jumped', 'spiked', 'eased', 'slid', 'tumbled', 'rallied', 'peaked', 'sank']);
    expect(directionsIn('Stocks surged, plunged, soared and slumped; oil dropped, rebounded and recovered; rates tightened.')).toEqual(['surged', 'plunged', 'soared', 'slumped', 'dropped', 'rebounded', 'recovered', 'tightened']);
    expect(directionsIn('Liquidity is expanding, credit contracting, the curve inverting; it steepens, then flattens; conditions rebounding, recovering, easing and tightening.')).toEqual([
      'expanding', 'contracting', 'inverting', 'steepens', 'flattens', 'rebounding', 'recovering', 'easing', 'tightening',
    ]);
    expect(directionsIn('The curve is inverted; the index gained 2 points and lost 3.')).toEqual([]);
    // Each is held to the lines like any direction: "jumped" cited to a level alone fails.
    const jumped = response([{ text: 'The yield curve jumped to 0.42%.', line: 2, quote: LEVEL, block: 'yield-curve' }]);
    expect(directionFailures([CURVE], jumped).filter((f) => f.claim === 0).map((f) => f.message)).toEqual(['"jumped" is a direction the lines this claim cites do not hold: none of them states a change']);
  });

  it('passes "the 10 year is higher than the 2 year" with both yields cited, and fails it with one', () => {
    const yields = (id: string, name: string, reading: string) => blockFromMarkdown(id, `# ${name}\n\n**Latest reading:** ${reading}\n`, FETCHED);
    const TEN = yields('treasury-10y', '10-Year Treasury Yield', '5.11%');
    const TWO = yields('treasury-2y', '2-Year Treasury Yield', '4.85%');
    const HIGHER = 'The 10 year yield is higher than the 2 year yield.';
    const cites = (...at: Array<[string, number, string]>) => JSON.stringify({ answer: HIGHER, claims: [{ text: HIGHER, citations: at.map(([block, line, quote]) => ({ block, line, quote })) }], not_in_data: [] });
    const both = cites(['treasury-10y', 2, '**Latest reading:** 5.11%'], ['treasury-2y', 2, '**Latest reading:** 4.85%']);
    expect(directionFailures([TEN, TWO], both)).toEqual([]);
    const one = cites(['treasury-10y', 2, '**Latest reading:** 5.11%']);
    expect(directionFailures([TEN, TWO], one)).toEqual([
      { check: 'grounded_directions', claim: 0, message: '"higher" is a direction the lines this claim cites do not hold: none of them states a change, and they do not give both values compared' },
      { check: 'grounded_directions', message: 'the answer states "higher", a direction no cited line holds' },
    ]);
    // CONTROL: a heading names the yield and gives no value, so a heading and one reading are one value.
    const heading = cites(['treasury-10y', 1, '# 10-Year Treasury Yield'], ['treasury-10y', 2, '**Latest reading:** 5.11%']);
    expect(directionFailures([TEN, TWO], heading).map((f) => f.claim)).toEqual([0, undefined]);
    // Two values back a comparative only: "rising" still needs a change.
    const rising = JSON.stringify({ ...(JSON.parse(both) as object), answer: 'The 10 year yield is rising.', claims: [{ ...(JSON.parse(both) as { claims: object[] }).claims[0], text: 'The 10 year yield is rising, above the 2 year yield.' }] });
    expect(directionFailures([TEN, TWO], rising).map((f) => f.message)).toEqual([
      '"rising" is a direction the lines this claim cites do not hold: none of them states a change',
      'the answer states "rising", a direction no cited line holds',
    ]);
  });

  // The wording review of 2026-10-14, 11:09Z: a word whose sign is fixed fails against a change
  // its lines state the other way, and the change of a change needs two windows.
  it('fails a direction against the sign of the change its line states, and leaves the sign of "improving" to the series', () => {
    const at = (id: string, ...lines: string[]) => blockFromMarkdown(id, lines.join('\n\n'), FETCHED);
    const said = (block: string, line: number, quote: string, text: string) => JSON.stringify({ answer: text, claims: [{ text, citations: [{ block, line, quote }] }], not_in_data: [] });
    const NET = at('net-liquidity', '# Net Liquidity', 'Net liquidity $5.87T ▼ 1.3%', 'Net liquidity $5.87T ▲ 1.3%');
    const claimed = (blocks: DataBlock[], text: string) => directionFailures(blocks, text).filter((f) => f.claim === 0).map((f) => f.message);
    expect(claimed([NET], said('net-liquidity', 2, '▼ 1.3%', 'Net liquidity is rising, at $5.87T.'))).toEqual(['"rising" is a direction the lines this claim cites do not hold: the change they state is a fall']);
    expect(claimed([NET], said('net-liquidity', 3, '▲ 1.3%', 'Net liquidity is falling, at $5.87T.'))).toEqual(['"falling" is a direction the lines this claim cites do not hold: the change they state is a rise']);
    // CONTROL: each the way its line runs passes.
    expect(claimed([NET], said('net-liquidity', 2, '▼ 1.3%', 'Net liquidity is falling, at $5.87T.'))).toEqual([]);
    expect(claimed([NET], said('net-liquidity', 3, '▲ 1.3%', 'Net liquidity is rising, at $5.87T.'))).toEqual([]);
    // A steepening is the spread's rise, so a spread whose change is a fall does not hold it.
    const SPREAD = at('yield-curve', '# Yield Curve Spread (10Y-2Y)', 'Yield curve spread (10Y-2Y) at 0.31% ▼ 0.05 over 7d.');
    expect(claimed([SPREAD], said('yield-curve', 2, 'at 0.31% ▼ 0.05 over 7d', 'The yield curve is steepening, at 0.31%.'))).toEqual(['"steepening" is a direction the lines this claim cites do not hold: the change they state is a fall']);
    expect(claimed([SPREAD], said('yield-curve', 2, 'at 0.31% ▼ 0.05 over 7d', 'The yield curve is flattening, at 0.31%.'))).toEqual([]);
    // Unemployment falling is a labour market improving: which way "improving", "worsening",
    // "strengthening" and "weakening" run depends on the series, so a change is enough.
    const JOBS = at('unemployment', '# Unemployment Rate', 'Unemployment rate at 4.1% ▼ 0.2 over 30d.');
    for (const word of ['improving', 'worsening', 'strengthening', 'weakening']) expect(claimed([JOBS], said('unemployment', 2, 'Unemployment rate at 4.1%', `The labour market is ${word}, with unemployment at 4.1%.`)), word).toEqual([]);
    // A line gives a sign only where it shows one. A minus beside a period is a fall, as a plus
    // beside one is a rise (the wording review, 11:24Z); a minus with no period may be a level,
    // and gives none.
    expect(signOf('Net liquidity at $5.87T; 7d -1.3%.')).toBe('fall');
    expect(signOf('Net liquidity at $5.87T, -1.3% over 7 days.')).toBe('fall');
    expect(claimed([at('net-liquidity', '# Net Liquidity', 'Net liquidity at $5.87T; 7d -1.3%.')], said('net-liquidity', 2, 'Net liquidity at $5.87T', 'Net liquidity is rising, at $5.87T.'))).toEqual(['"rising" is a direction the lines this claim cites do not hold: the change they state is a fall']);
    expect(signOf('The yield curve is at -0.12%.')).toBeNull();
    expect(backsDirection('The yield curve is at -0.12%.')).toBe(false);
    // A line whose changes run both ways gives no sign of its own.
    expect(signOf('SPY at $671.20; 7d +1.2%, 30d -2.6%.')).toBeNull();
    expect(signOf(json('macro.snapshot').lines.find((l) => l.startsWith('{"metric":"yield-curve"'))!)).toBeNull();
    expect(signOf('Yield curve spread (10Y-2Y) at 0.31%, flattening 34.0% over 30d. Tightening signal: recession risk rises as curve compresses.')).toBe('fall');
    expect(signOf('BTC dominance at 58.5%, falling. Decelerating: alt season conditions developing, risk appetite broadening.')).toBe('fall');
    expect(signOf('Mining difficulty at 132.8T, +5.5% over 30d. Network competition intensifying: hashrate rising faster than expected.')).toBe('rise');
    expect(signOf(LEVEL)).toBeNull();
  });

  it('tests the sign of the window a claim names, and gives a mixed line no sign where it names none', () => {
    const SPY = blockFromMarkdown('spy', '# SPY\n\nSPY at $671.20; 7d +1.2%, 30d -2.6%.', FETCHED);
    const claimed = (text: string) => directionFailures([SPY], JSON.stringify({ answer: text, claims: [{ text, citations: [{ block: 'spy', line: 2, quote: 'SPY at $671.20' }] }], not_in_data: [] })).filter((f) => f.claim === 0).map((f) => f.message);
    expect(claimed('SPY fell 2.6% over 30 days.')).toEqual([]);
    expect(claimed('SPY rose over 30 days.')).toEqual(['"rose" is a direction the lines this claim cites do not hold: the change they state is a fall']);
    expect(claimed('SPY rose this week.')).toEqual([]);
    expect(claimed('SPY fell over the 7d window.')).toEqual(['"fell" is a direction the lines this claim cites do not hold: the change they state is a rise']);
    // With no window named, the mixed line gives no sign, and its change is enough either way.
    expect(claimed('SPY fell, to $671.20.')).toEqual([]);
    expect(claimed('SPY rose, to $671.20.')).toEqual([]);
  });

  it('leaves the sign of "tightened", "tightening", "eased" and "easing" to the series, and of a negated word', () => {
    const at = (id: string, line: string) => blockFromMarkdown(id, `# ${id}\n\n${line}`, FETCHED);
    const claimed = (block: DataBlock, text: string) => directionFailures([block], JSON.stringify({ answer: text, claims: [{ text, citations: [{ block: block.id, line: 2, quote: block.lines[1]!.slice(0, 12) }] }], not_in_data: [] })).filter((f) => f.claim === 0).map((f) => f.message);
    // Credit spreads that tighten fall; policy that tightens rises. A cited change is enough.
    const SPREADS = at('hy-spread', 'High yield spread at 3.1% ▼ 0.2 over 7d.');
    const RATES = at('fed-funds', 'Fed funds rate at 4.33% ▲ 0.25 over 30d.');
    for (const block of [SPREADS, RATES]) for (const word of ['tightened', 'tightening', 'eased', 'easing']) expect(claimed(block, `Conditions ${word}.`), `${word} on ${block.id}`).toEqual([]);
    // "Not rising" and "no longer falling" say no way the thing moved, so a change is enough,
    // and a level alone still holds none.
    const NET = at('net-liquidity', 'Net liquidity $5.87T ▼ 1.3%');
    expect(claimed(NET, 'Net liquidity is not rising, at $5.87T.')).toEqual([]);
    expect(claimed(at('dom', 'BTC dominance 58.5% ▲ 1.3%'), 'BTC dominance is no longer falling.')).toEqual([]);
    expect(claimed(at('level', '**Latest reading:** $5.87T'), 'Net liquidity is not rising, at $5.87T.')).toEqual(['"rising" is a direction the lines this claim cites do not hold: none of them states a change']);
    // CONTROL: said plainly, it is held to the sign.
    expect(claimed(NET, 'Net liquidity is rising, at $5.87T.')).toEqual(['"rising" is a direction the lines this claim cites do not hold: the change they state is a fall']);
  });

  it('holds "accelerating", "decelerating" and "slowing" to the change over two windows of one series', () => {
    const at = (id: string, line: string) => blockFromMarkdown(id, `# ${id}\n\n${line}`, FETCHED);
    const said = (block: string, quote: string, text: string) => JSON.stringify({ answer: text, claims: [{ text, citations: [{ block, line: 2, quote }] }], not_in_data: [] });
    const claimed = (blocks: DataBlock[], text: string) => directionFailures(blocks, text).filter((f) => f.claim === 0).map((f) => f.message);
    const TWO = at('spy', 'SPY at $671.20; 7d +1.2%, 30d +2.6%.');
    const ONE = at('qqq', 'QQQ at $598.41; 7d +2.0%.');
    expect(windowsIn('SPY at $671.20; 7d +1.2%, 30d +2.6%.')).toEqual(new Set(['7d', '30d']));
    for (const word of ['accelerating', 'decelerating', 'slowing']) {
      expect(claimed([TWO], said('spy', 'SPY at $671.20', `SPY's gains are ${word}.`)), word).toEqual([]);
      expect(claimed([ONE], said('qqq', 'QQQ at $598.41', `QQQ's gains are ${word}.`)), word).toEqual([`"${word}" is a direction the lines this claim cites do not hold: none of them states a change over two windows`]);
    }
    // A JSON metric gives its change over 1, 7, 30 and 90 days.
    const macro = json('macro.snapshot');
    const tga = macro.lines.findIndex((l) => l.startsWith('{"metric":"tga"')) + 1;
    expect(claimed([macro], JSON.stringify({ answer: 'x', claims: [{ text: 'The TGA is accelerating.', citations: [{ block: 'macro.snapshot', line: tga, quote: '"metric":"tga"' }] }], not_in_data: [] }))).toEqual([]);
    // A line that says it of itself holds it, as PreReason's "Accelerating:" does, but not the
    // other way: a decelerating line holds no acceleration.
    const TGA = 'Treasury General Account at $977.08B, up 2.8% over 30d. Accelerating: draining liquidity from system.';
    expect(claimed([at('tga', TGA)], said('tga', TGA, TGA))).toEqual([]);
    const DOM = 'BTC dominance at 58.5%, falling. Decelerating: alt season conditions developing, risk appetite broadening.';
    expect(claimed([at('dom', DOM)], said('dom', DOM, 'BTC dominance is slowing, at 58.5%.'))).toEqual([]);
    // The words must agree (the wording review, 11:24Z), even where the line has two windows.
    expect(claimed([at('dom', DOM)], said('dom', DOM, 'BTC dominance is accelerating, at 58.5%.'))).toEqual(['"accelerating" is a direction the lines this claim cites do not hold: the change they state is decelerating']);
    for (const word of ['decelerating', 'slowing']) expect(claimed([at('tga', TGA)], said('tga', TGA, `The TGA is ${word}.`)), word).toEqual([`"${word}" is a direction the lines this claim cites do not hold: the change they state is accelerating`]);
    expect(claimed([macro], JSON.stringify({ answer: 'x', claims: [{ text: 'The TGA is slowing.', citations: [{ block: 'macro.snapshot', line: tga, quote: '"metric":"tga"' }] }], not_in_data: [] }))).toEqual(['"slowing" is a direction the lines this claim cites do not hold: the change they state is accelerating']);
  });

  it('passes a claim that gives the level alone, with no direction word', async () => {
    const level = curve([{ text: 'The yield curve spread is at 0.42%.', line: 2, quote: LEVEL }]);
    expect(failuresOf(packetOf([CURVE]), level)).toEqual([]);
    const result = await runOperation({ operation: ASK, question: 'Is the yield curve steepening?', blocks: [CURVE], model: new Scripted([level]) });
    expect(result.outcome).toBe('passed');
    expect(checksText(answerView(result)!.checks).text).toBe('5 of 5 checks: answer format · claims cite their lines · figures match the lines cited · direction words cite a change · no advice words');
  });

  it('holds the answer to it too: a direction no cited line backs fails, and the checked claims replace it', async () => {
    const said = curve([{ text: 'The yield curve spread is at 0.42%.', line: 2, quote: LEVEL }], 'The yield curve is steepening, at 0.42%.');
    expect(directionFailures([CURVE], said)).toEqual([{ check: 'grounded_directions', message: 'the answer states "steepening", a direction no cited line holds' }]);
    const result = await runOperation({ operation: ASK, question: 'Is the yield curve steepening?', blocks: [CURVE], model: new Scripted([said, said]) });
    expect(result.outcome).toBe('partial');
    expect(result.response?.answer).toBe('The yield curve spread is at 0.42%.');
    // CONTROL: an answer whose direction a claim's line states passes.
    expect(directionFailures([PULSE], GOOD)).toEqual([]);
  });

  it('tells the model a level alone supports no direction, and names the check where it fails', () => {
    expect(packetOf().text).toContain('3. A direction, such as rising or steepening, needs a change in the lines you cite. A line\n   that gives only a level supports no direction. Higher or lower than another value needs\n   both values in the lines you cite. A rise needs a change that rises, and accelerating or\n   slowing the change over two windows.');
    const ran = { passed: 4, total: 5, ran: ['schema', 'citations', 'grounded_numbers', 'grounded_directions', 'scope'].map((id) => ({ id, ok: id !== 'grounded_directions' })) };
    expect(checksText(ran)).toEqual({ ok: false, text: '4 of 5 checks: a direction the cited lines do not hold' });
  });
});

// The walk of 2026-10-14: a digest said "up 2.5% over 7 days" of a line that gives "-2.5%
// (falling)", and every check passed; the figure check matched the 2.5 and left its sign. The
// wording review's ruling of 13:30Z: "up" or "down" before a percent or points figure is a rise
// or a fall, so is a move noun beside one, and a figure written with a sign keeps it. The
// lines are made up for the test.
describe('a move said with its figure, and a figure written with a sign, keep their sign', () => {
  const at = (line: string, id = 'btc') => blockFromMarkdown(id, `# ${id}\n\n${line}`, FETCHED);
  const FALLING = at('Bitcoin price at $62,140.00; 7d -2.5% (falling).');
  const FELL = at('Bitcoin price at $62,140.00; 7d -2.5%.');
  const ROSE = at('Bitcoin price at $62,140.00; 7d +2.5%.');
  const said = (block: DataBlock, text: string, answer?: string) =>
    failuresOf(packetOf([block]), JSON.stringify({ answer: answer ?? text, claims: [{ text, citations: [{ block: block.id, line: 2, quote: block.lines[1]!.slice(0, 16) }] }], not_in_data: [] }));
  const claimed = (block: DataBlock, text: string, check: string) => said(block, text).filter((f) => f.check === check && f.claim === 0).map((f) => f.message);

  it('fails "up 2.5%" against "-2.5% (falling)", in the words the review cleared', () => {
    expect(claimed(FALLING, 'Bitcoin price is up 2.5% over 7 days.', 'grounded_directions')).toEqual(['"up 2.5%" is a direction the lines this claim cites do not hold: the change they state is a fall']);
    // It fails with no window named too, and nothing else fails: the 2.5, unsigned, is the line's.
    expect(said(FALLING, 'Bitcoin price is up 2.5%.').map((f) => f.message)).toEqual([
      '"up 2.5%" is a direction the lines this claim cites do not hold: the change they state is a fall',
      'the answer states "up 2.5%", a direction no cited line holds',
    ]);
  });

  it('fails "+2.5%" against "-2.5%", and says what the lines give', () => {
    expect(claimed(FELL, 'Bitcoin price changed +2.5% over 7 days.', 'grounded_numbers')).toEqual(['+2.5 is not in the lines this claim cites; they give -2.5']);
    expect(claimed(ROSE, 'Bitcoin price changed -2.5% over 7 days.', 'grounded_numbers')).toEqual(['-2.5 is not in the lines this claim cites; they give +2.5']);
  });

  it('fails "a 2.5% fall" against "+2.5%"', () => {
    expect(claimed(ROSE, 'Bitcoin price saw a 2.5% fall over 7 days.', 'grounded_directions')).toEqual(['"2.5% fall" is a direction the lines this claim cites do not hold: the change they state is a rise']);
  });

  it('passes "down 2.5%" against "-2.5%", a move noun the way its line runs, and an unsigned "2.5%" against either sign', () => {
    for (const block of [FELL, FALLING]) {
      expect(said(block, 'Bitcoin price is down 2.5% over 7 days.'), block.lines[1]).toEqual([]);
      expect(said(block, 'Bitcoin price saw a 2.5% fall over 7 days.'), block.lines[1]).toEqual([]);
      expect(said(block, 'Bitcoin price changed -2.5% over 7 days.'), block.lines[1]).toEqual([]);
    }
    expect(said(ROSE, 'Bitcoin price saw a rise of 2.5% over 7 days.')).toEqual([]);
    expect(said(ROSE, 'Bitcoin price changed +2.5% over 7 days.')).toEqual([]);
    for (const block of [FELL, ROSE]) expect(said(block, 'Bitcoin price moved 2.5% over 7 days.'), block.lines[1]).toEqual([]);
  });

  it('passes "paid down $1.2 billion" and "drew down $500 million": a $ figure after up or down is no move', () => {
    const filed = (line: string) => at(line, 'filings');
    for (const [line, text] of [
      ['8-K item 8.01, other events: paid down $1.2 billion of its notes', 'Fictional Group Corp paid down $1.2 billion of its notes.'],
      ['8-K item 2.03: drew down $500 million under its credit facility', 'Fictional Group Corp drew down $500 million under its credit facility.'],
      ['8-K item 2.06: wrote down $80 million of goodwill', 'Fictional Group Corp wrote down $80 million of goodwill.'],
    ]) {
      expect(directionsIn(text!), text).toEqual([]);
      expect(said(filed(line!), text!), text).toEqual([]);
    }
    // CONTROL: a % figure after "down" in the same sentence is a move, and the filing states none.
    expect(claimed(filed('8-K item 8.01, other events: paid down $1.2 billion of its notes'), 'Fictional Group Corp was down 3% after it paid down $1.2 billion of its notes.', 'grounded_directions')).toEqual([
      '"down 3%" is a direction the lines this claim cites do not hold: none of them states a change',
    ]);
  });

  it('compares a signed level as a level: "-0.12%" is not "+0.12%"', () => {
    const level = (reading: string) => at(`**Latest reading:** ${reading}`, 'yield-curve');
    expect(claimed(level('+0.12%'), 'The yield curve spread is at -0.12%.', 'grounded_numbers')).toEqual(['-0.12 is not in the lines this claim cites; they give +0.12']);
    expect(claimed(level('-0.12%'), 'The yield curve spread is at +0.12%.', 'grounded_numbers')).toEqual(['+0.12 is not in the lines this claim cites; they give -0.12']);
    // CONTROL: the sign the line gives passes, and a figure written with none matches either.
    expect(said(level('-0.12%'), 'The yield curve spread is at -0.12%.')).toEqual([]);
    expect(said(level('-0.12%'), 'The yield curve spread is at 0.12%.')).toEqual([]);
    expect(said(level('+0.12%'), 'The yield curve spread is at 0.12%.')).toEqual([]);
  });

  it('holds the answer to it too, and names the sign the cited lines give', () => {
    expect(said(FELL, 'Bitcoin price changed -2.5% over 7 days.', 'Bitcoin price changed +2.5% this week.')).toEqual([
      { check: 'grounded_numbers', message: 'the answer states +2.5, which no cited line holds; the cited lines give -2.5' },
    ]);
  });

  it('reads "up" or "down" before a percent or points figure, and a move noun beside one; not bare "up" or "down", a $ figure, "gain" or "loss"', () => {
    expect(directionsIn('Up 2.5% on the week, down by 0.4 points, up by 26 percent and down 25 basis points.')).toEqual(['up 2.5%', 'down by 0.4 points', 'up by 26 percent', 'down 25 basis points']);
    expect(directionsIn('A 2.5% fall, a fall of 2.5%, a rise of 3 points, a 4% drop, an increase of 1.2 points, a decrease of 0.5% and a 3% decline.')).toEqual([
      '2.5% fall', 'fall of 2.5%', 'rise of 3 points', '4% drop', 'increase of 1.2 points', 'decrease of 0.5%', '3% decline',
    ]);
    // In the order said, beside the direction words.
    expect(directionsIn('Yields rose, up 0.2 points, then fell.')).toEqual(['rose', 'up 0.2 points', 'fell']);
    for (const text of ['The CEO stepped down, and the shares are up.', 'It paid down $1.2 billion and drew down $500 million.', 'It wrote down $80 million.', 'A loss of $3 billion and a gain of 2%.', 'It made a 20% down payment.', 'Yields could go up to 5%.', 'The fall of 2025 was calm.']) expect(directionsIn(text), text).toEqual([]);
  });

  it('reads basis points as points, as rates are written: "up 25bp", "down 10 bps", "25 BPS", "a 25bp rise" (the wording review, 14:34Z)', () => {
    expect(directionsIn('Rates were up 25bp, then up 25 BPS, down 10 bps, up 25 basis points and a 25bp rise.')).toEqual(['up 25bp', 'up 25 bps', 'down 10 bps', 'up 25 basis points', '25bp rise']);
    // "up 25bp" on a falling line fails; "down 25bp" on it passes.
    const CUT = at('Fed funds rate at 4.08%; 30d -25bp.', 'fed-funds');
    expect(claimed(CUT, 'The fed funds rate was up 25bp over 30 days.', 'grounded_directions')).toEqual(['"up 25bp" is a direction the lines this claim cites do not hold: the change they state is a fall']);
    expect(said(CUT, 'The fed funds rate was down 25bp over 30 days.')).toEqual([]);
    // A line states a change in basis points over a period too: "-10 bps over 7d" is a fall,
    // so "down 10 bps" on it passes, and "up 10 bps" fails.
    const TEN = at('10Y Treasury yield at 4.21%, -10 bps over 7d.', 'treasury-10y');
    expect(backsDirection(TEN.lines[1]!)).toBe(true);
    expect(signOf(TEN.lines[1]!)).toBe('fall');
    expect(said(TEN, 'The 10Y yield was down 10 bps over 7 days.')).toEqual([]);
    expect(claimed(TEN, 'The 10Y yield was up 10 bps over 7 days.', 'grounded_directions')).toEqual(['"up 10 bps" is a direction the lines this claim cites do not hold: the change they state is a fall']);
    // A figure in basis points keeps its sign, and a line's "down 25bp" gives it one.
    expect(claimed(at('Fed funds rate at 4.08%, down 25bp over 30d.', 'fed-funds'), 'The fed funds rate changed +25bp over 30 days.', 'grounded_numbers')).toEqual(['+25 is not in the lines this claim cites; they give -25']);
  });

  it('holds "up" and "down" to the window a claim names, and a line whose changes run both ways gives none', () => {
    const SPY = at('SPY at $671.20; 7d +1.2%, 30d -2.6%.', 'spy');
    expect(claimed(SPY, 'SPY was down 2.6% over 30 days.', 'grounded_directions')).toEqual([]);
    expect(claimed(SPY, 'SPY was up 2.6% over 30 days.', 'grounded_directions')).toEqual(['"up 2.6%" is a direction the lines this claim cites do not hold: the change they state is a fall']);
    expect(claimed(SPY, 'SPY was down 1.2% over 7 days.', 'grounded_directions')).toEqual(['"down 1.2%" is a direction the lines this claim cites do not hold: the change they state is a rise']);
    // With no window named, the mixed line gives no sign, and its change is enough either way.
    expect(claimed(SPY, 'SPY was up 1.2%.', 'grounded_directions')).toEqual([]);
    expect(claimed(SPY, 'SPY was down 2.6%.', 'grounded_directions')).toEqual([]);
    // A level alone states no change, so it holds no move.
    expect(claimed(at('**Latest reading:** 2.5%'), 'It is up 2.5%.', 'grounded_directions')).toEqual(['"up 2.5%" is a direction the lines this claim cites do not hold: none of them states a change']);
  });

  it('reads a sign as written, where a hyphen in a word, a range or a date is none, and a line shows one by ▲, ▼ or its move', () => {
    const written = (text: string) => signedFiguresIn(text).map((f) => `${f.sign ?? ''}${f.n}`);
    expect(written('The 10Y-2Y spread on 2026-10-14, 2.5-3% wide, was −2.1 and (+0.26).')).toEqual(['10', '2', '2026', '10', '14', '2.5', '3', '-2.1', '+0.26']);
    expect(written('Net liquidity $5.87T ▼ 1.3% and ▲ 0.25; zero is +0.0%.')).toEqual(['5.87', '-1.3', '+0.25', '0']);
    // PreReason's own line says "up 10.6% over 7d": its 10.6 is a rise.
    const price = (text: string) => failuresOf(packetOf(), response([{ text, line: 7, quote: PRICE }])).filter((f) => f.check === 'grounded_numbers' && f.claim === 0).map((f) => f.message);
    expect(price('Bitcoin changed -10.6% over 7 days.')).toEqual(['-10.6 is not in the lines this claim cites; they give +10.6']);
    expect(price('Bitcoin changed +10.6% over 7 days.')).toEqual([]);
    const NET = at('Net liquidity $5.87T ▼ 1.3%', 'net-liquidity');
    expect(claimed(NET, 'Net liquidity changed +1.3%, to $5.87T.', 'grounded_numbers')).toEqual(['+1.3 is not in the lines this claim cites; they give -1.3']);
    expect(said(NET, 'Net liquidity changed -1.3%, to $5.87T.')).toEqual([]);
  });
});

describe('an operation read from a Windows checkout', () => {
  it('builds the same packet, hash and render from CRLF files as from LF files', () => {
    const copy = (eol: string) => {
      const dir = mkdtempSync(join(tmpdir(), 'primerkit-op-'));
      for (const name of ['operation.yaml', 'primer.md', 'schema.json', 'render.md']) {
        const lf = readFileSync(join(ASK.dir, name), 'utf8').replace(/\r\n/g, '\n');
        writeFileSync(join(dir, name), lf.replace(/\n/g, eol));
      }
      return loadOperation(dir);
    };
    const [lf, crlf] = [copy('\n'), copy('\r\n')];
    expect(crlf.render).toBe(lf.render);
    const packet = (op: typeof ASK) => buildPacket({ operation: op, question: 'q', blocks: [PULSE], runId: 'r' });
    expect(packet(crlf).hash).toBe(packet(lf).hash);
    expect(packet(crlf).text).not.toContain('\r');
  });
});

describe('the journal', () => {
  it('keeps each file once: a second write to the same name fails', () => {
    const root = mkdtempSync(join(tmpdir(), 'primerkit-journal-'));
    const run = new Journal(root).open('ask', 'r1', new Date('2026-09-26T10:00:00Z'));
    expect(run.dir).toBe(join(root, '2026-09-26', 'ask', 'r1'));
    run.write('a.json', { n: 1 });
    expect(() => run.write('a.json', { n: 2 })).toThrow(/EEXIST/);
    expect(JSON.parse(readFileSync(join(run.dir, 'a.json'), 'utf8'))).toEqual({ n: 1 });
  });
});

describe('the executor', () => {
  const journalRoot = () => new Journal(mkdtempSync(join(tmpdir(), 'primerkit-run-')));

  it('passes a checked answer on the first turn and journals the run', async () => {
    const journal = journalRoot();
    const result = await runOperation({ operation: ASK, question: 'Where does Bitcoin stand?', blocks: [PULSE], model: new Scripted([GOOD]), journal });
    expect(result.outcome).toBe('passed');
    expect(result.attempts).toBe(1);
    expect(result.checks.map((c) => c.id)).toEqual(['schema', 'citations', 'grounded_numbers', 'grounded_directions', 'scope']);
    expect(readdirSync(result.journalDir!).sort()).toEqual(['checks.json', 'meta.json', 'packet.json', 'packet.md', 'render.md', 'response.json']);
    const meta = JSON.parse(readFileSync(join(result.journalDir!, 'meta.json'), 'utf8')) as { hash: string; outcome: string };
    expect(meta).toMatchObject({ outcome: 'passed', hash: result.packet.hash });
  });

  it('gives the model one repair turn with the failures', async () => {
    const bad = response([{ text: 'Bitcoin is at $84,512, up 10.6% over 7 days.', line: 7, quote: PRICE }]);
    const model = new Scripted([bad, GOOD]);
    const journal = journalRoot();
    const result = await runOperation({ operation: ASK, question: 'q', blocks: [PULSE], model, journal });
    expect(result.outcome).toBe('passed');
    expect(result.attempts).toBe(2);
    expect(model.repairs[1]?.[0]).toMatchObject({ check: 'grounded_numbers' });
    expect(existsSync(join(result.journalDir!, 'response.repair.json'))).toBe(true);
  });

  it('drops a claim that still fails, names it, and marks the answer partial', async () => {
    const mixed = response(
      [
        { text: 'BTC dominance is 58.5% and falling.', line: 11, quote: DOMINANCE },
        { text: 'Bitcoin is at $90,000.', line: 7, quote: PRICE },
      ],
      'Dominance is 58.5% and Bitcoin is at $90,000.',
    );
    const result = await runOperation({ operation: ASK, question: 'q', blocks: [PULSE], model: new Scripted([mixed, mixed]) });
    expect(result.outcome).toBe('partial');
    expect(result.response?.claims.map((c) => c.text)).toEqual(['BTC dominance is 58.5% and falling.']);
    expect(result.dropped).toEqual([{ claim: expect.objectContaining({ text: 'Bitcoin is at $90,000.' }), reasons: ['90000 is not in the lines this claim cites'] }]);
    // The answer stated the dropped figure, so it is replaced by the checked claims.
    expect(result.response?.answer).toBe('BTC dominance is 58.5% and falling.');
    expect(result.checks.every((c) => c.failures.length === 0)).toBe(true);
  });

  it('fails a run whose response cannot be read, after the repair turn', async () => {
    const result = await runOperation({ operation: ASK, question: 'q', blocks: [PULSE], model: new Scripted(['not json', 'still not json']) });
    expect(result.outcome).toBe('failed');
    expect(result.attempts).toBe(2);
    expect(result.response).toBeNull();
  });

  it('stops when the run is cancelled, and keeps nothing from it', async () => {
    const root = mkdtempSync(join(tmpdir(), 'primerkit-stop-'));
    const controller = new AbortController();
    const waiting: ModelAdapter = {
      id: 'waiting',
      label: 'waiting',
      capabilities: async () => ({ local: true, schemaConstraint: true, contextTokens: null, canRaiseContext: false, format: 'markdown' }),
      complete: (_p, _r, signal) =>
        new Promise((_, reject) => {
          signal?.addEventListener('abort', () => reject(new Error('aborted')));
        }),
    };
    const run = runOperation({ operation: ASK, question: 'q', blocks: [PULSE], model: waiting, journal: new Journal(root), signal: controller.signal });
    setTimeout(() => controller.abort(), 10);
    await expect(run).rejects.toThrow(RunCancelled);
    expect(readdirSync(root)).toEqual([]);
  });

  it('refuses a packet over the model context and never calls the model', async () => {
    const model = new Scripted([GOOD], { contextTokens: 1200 });
    const result = await runOperation({ operation: ASK, question: 'q', blocks: [PULSE, md('macro.snapshot')], model });
    expect(result.outcome).toBe('refused');
    expect(model.repairs.length).toBe(0);
    expect(result.reason).toMatch(/It needs a context of at least/);
  });
});

describe('the checks line', () => {
  it('names each check that ran, says which failed, and has words for every check there is', () => {
    // The wording review (10-12): the line names what was checked, never more.
    const ran = (ok: boolean[]) => ({ passed: ok.filter(Boolean).length, total: ok.length, ran: ['schema', 'citations', 'grounded_numbers', 'scope'].map((id, i) => ({ id, ok: ok[i]! })) });
    expect(checksText(ran([true, true, true, true]))).toEqual({ ok: true, text: '4 of 4 checks: answer format · claims cite their lines · figures match the lines cited · no advice words' });
    expect(checksText(ran([true, true, false, true]))).toEqual({ ok: false, text: '3 of 4 checks: a figure does not match its cited line' });
    // Every check the code can run has its words, so none can ship unnamed. The ids are the
    // registry runChecks reads, not a list typed here: one typed here left as_of out, and a
    // dated answer's line ended with the raw id (the recheck, 10-13).
    const unnamed = (registry: Record<string, unknown>) => Object.keys(registry).filter((id) => !CHECK_WORDS[id]);
    expect(unnamed(CHECKS)).toEqual([]);
    // CONTROL: a check added to the registry with no words of its own is caught.
    expect(unnamed({ ...CHECKS, a_new_check: CHECKS.scope })).toEqual(['a_new_check']);
    // CONTROL: a view kept before the checks were named still says how many passed, and a
    // check with no words of its own is named by its id.
    expect(checksText({ passed: 4, total: 4 })).toEqual({ ok: true, text: '4 of 4 checks passed' });
    expect(checksText({ passed: 1, total: 1, ran: [{ id: 'mine', ok: true }] }).text).toBe('1 of 1 checks: mine');
  });

  it("names as_of on a dated answer's line in words that say what it checks, not by its id", async () => {
    const dated = { ...ASK, spec: { ...ASK.spec, checks: [...ASK.spec.checks, 'as_of'] } };
    const reply = JSON.stringify({ ...(JSON.parse(GOOD) as object), data_as_of: '2026-08-15' });
    const result = await runOperation({ operation: dated, question: 'q', blocks: [PULSE], model: new Scripted([reply]), asOf: '2026-08-15' });
    const text = renderMarkdown(ASK.render!, answerView(result)!);
    expect(text).toContain('✓ 6 of 6 checks: answer format · claims cite their lines · figures match the lines cited · direction words cite a change · no advice words · dated the day the briefings were read for ·');
    expect(text).not.toContain('as_of');
  });

  it('names only the format check for a reply that is not JSON, or not in its shape, and says the others did not run on it', async () => {
    const said = { ok: false, text: "0 of 1 checks: the answer's format is wrong, so the other checks did not run on it" };
    // Not JSON; and JSON in the wrong shape, which until the review of 10-14 ran every check
    // and read "3 of 4 checks", three held with nothing they were written to check.
    for (const reply of ['Bitcoin is up.', '{"answer":"Bitcoin is up."}', JSON.stringify({ ...(JSON.parse(GOOD) as object), confidence: 'high' })]) {
      const model = new Scripted([reply]);
      const journal = new Journal(mkdtempSync(join(tmpdir(), 'primerkit-shape-')));
      const result = await runOperation({ operation: ASK, question: 'q', blocks: [PULSE], model, journal });
      expect(result.outcome, reply).toBe('failed');
      expect(result.checks.map((c) => c.id), reply).toEqual(['schema']);
      // The journal keeps the same, and a backtest's tick board draws its checks row from it.
      expect((JSON.parse(readFileSync(join(result.journalDir!, 'checks.json'), 'utf8')) as Array<{ id: string }>).map((c) => c.id), reply).toEqual(['schema']);
      // The repair turn is told of the format alone, as no other check ran.
      expect(model.repairs[1]?.every((f) => f.check === 'schema'), reply).toBe(true);
      // An answer that fails is not drawn, so its view is drawn here with a response put back,
      // to read the line it would carry: the format check alone, counted alone.
      expect(checksText(answerView({ ...result, response: JSON.parse(GOOD) })!.checks), reply).toEqual(said);
      // Drawn from the operation's own list of checks, as the digest draws it: the same.
      expect(checksText(checksOf(ASK.spec.checks, [result.checks])), reply).toEqual(said);
    }
    // CONTROL: a reply in its shape runs every check, and the line names each.
    const whole = await runOperation({ operation: ASK, question: 'q', blocks: [PULSE], model: new Scripted([GOOD]) });
    expect(checksText(checksOf(ASK.spec.checks, [whole.checks])).text).toBe('5 of 5 checks: answer format · claims cite their lines · figures match the lines cited · direction words cite a change · no advice words');
  });

  it('names which rule a scope failure broke, not advice words for every one', () => {
    const good = JSON.parse(GOOD) as Record<string, unknown>;
    // The line a reply would carry, its checks run as a reply's are.
    const line = (value: object, blocks: DataBlock[] = [PULSE], operation = ASK) => checksText(checksOf(operation.spec.checks, [checkReply(operation, packetOf(blocks), value)])).text;
    const plain = ['Dominance is a share of a whole.', 'A share can rise as others fall.', 'Coins differ in age.', 'Some coins are newer.', 'Markets move on news.'];
    const equities: DataBlock = { id: 'equities.fxmp', source: 'prereason', format: 'markdown', fetchedAt: FETCHED, lines: ['FXMP at $1.'] };
    // A field the answer may not hold: an operation whose schema lets it through names it. The
    // ask's own schema holds no such field, so there it breaks the format and stops the rest.
    expect(line({ ...good, action: 'hold' }, [PULSE], { ...ASK, schema: { type: 'object' } })).toBe('4 of 5 checks: the answer holds a field it may not');
    expect(line({ ...good, action: 'hold' })).toBe("0 of 1 checks: the answer's format is wrong, so the other checks did not run on it");
    expect(line({ ...good, answer: 'You should buy Bitcoin now.' })).toBe('4 of 5 checks: advice words appear');
    expect(line({ ...good, background: ['You should buy Bitcoin now.'] })).toBe('4 of 5 checks: advice words appear in the background');
    expect(line({ ...good, background: plain })).toBe('4 of 5 checks: more than four background sentences');
    expect(line(good, [PULSE, equities])).toBe('4 of 5 checks: an equities briefing that names no company was read');
    // CONTROL: a view kept before a failure said which way it failed reads as it did.
    expect(checksText({ passed: 3, total: 4, ran: [{ id: 'schema', ok: true }, { id: 'scope', ok: false }] }).text).toBe('3 of 4 checks: advice words appear');
  });
});

describe('the rendered answer', () => {
  it('numbers the sources, counts the checks and credits the briefings', async () => {
    const result = await runOperation({ operation: ASK, question: 'q', blocks: [PULSE], model: new Scripted([GOOD]) });
    const view = answerView(result)!;
    expect(view.sources).toEqual([
      { n: 1, block: 'btc.pulse', line: 7 },
      { n: 2, block: 'btc.pulse', line: 11 },
    ]);
    expect(view.checks).toMatchObject({ passed: 5, total: 5 });
    // Each check named, from the ones that ran.
    expect(checksText(view.checks)).toEqual({ ok: true, text: '5 of 5 checks: answer format · claims cite their lines · figures match the lines cited · direction words cite a change · no advice words' });
    const text = renderMarkdown(ASK.render!, view);
    expect(text).toContain('[1] btc.pulse, line 7 · [2] btc.pulse, line 11');
    expect(text).toContain('PR · btc.pulse · generated 09:05 UTC · written by your model, not investment advice');
  });
});

// A wide question reaches past the lines; the answer may add background from the model's
// general knowledge, held to no number and no advice, and shown apart from the data.
describe('background on a wide question', () => {
  const withBackground = (background: unknown[], claims = true): string =>
    JSON.stringify({ ...(JSON.parse(claims ? GOOD : JSON.stringify({ answer: 'The lines do not say why dominance matters.', claims: [], not_in_data: ['why dominance matters'] })) as object), background });
  const WHAT = "Dominance is Bitcoin's share of the value of all crypto assets together.";
  const WHY = 'A falling share often means money is moving into other coins.';

  it('tells the model it may add background, and what background may not hold', () => {
    expect(packetOf().text).toContain('you may add up to four sentences of\n   background from your general knowledge');
    expect(packetOf().text).toContain('Background holds no number of any kind, not even a year');
  });

  it('keeps background that holds no number and no advice, and shows it apart, marked as not from the data', async () => {
    const result = await runOperation({ operation: ASK, question: 'Why does dominance matter?', blocks: [PULSE], model: new Scripted([withBackground([WHAT, WHY])]) });
    expect(result.outcome).toBe('passed');
    const view = answerView(result)!;
    expect(view.background).toEqual([WHAT, WHY]);
    const text = renderMarkdown(ASK.render!, view);
    expect(text).toContain(`*Background, from the model's general knowledge, not from the data:* ${WHAT} ${WHY}`);
    // After what the data says, and before the checks.
    expect(text.indexOf('58.5% and falling [2].')).toBeLessThan(text.indexOf('*Background'));
    expect(text.indexOf('*Background')).toBeLessThan(text.indexOf('5 of 5 checks:'));
    // An answer with no background shows none.
    const plain = renderMarkdown(ASK.render!, answerView(await runOperation({ operation: ASK, question: 'q', blocks: [PULSE], model: new Scripted([GOOD]) }))!);
    expect(plain).not.toContain('Background');
  });

  it('answers a question the lines cannot, with background alone and what is missing named', async () => {
    const result = await runOperation({ operation: ASK, question: 'Why does dominance matter?', blocks: [PULSE], model: new Scripted([withBackground([WHAT], false)]) });
    expect(result.outcome).toBe('passed');
    expect(answerView(result)!.background).toEqual([WHAT]);
    // A background sentence that breaks its rule is taken out, and the answer stands without it.
    const RANGE = 'Dominance has ranged from 40% to 70%.';
    const trimmed = await runOperation({ operation: ASK, question: 'Why does dominance matter?', blocks: [PULSE], model: new Scripted([withBackground([RANGE, WHAT], false)]) });
    expect(trimmed.outcome).toBe('partial');
    expect(trimmed.response!.background).toEqual([WHAT]);
  });

  it('takes out, after the repair turn, a background sentence with a number, with advice, or past the fourth, and names it', async () => {
    const NUMBER = "Bitcoin's supply is capped at 21 million coins.";
    const ADVICE = 'You should buy when dominance falls.';
    const model = new Scripted([withBackground([NUMBER, WHAT, ADVICE, WHY, WHY])]);
    const result = await runOperation({ operation: ASK, question: 'Why does dominance matter?', blocks: [PULSE], model });
    // The repair turn names each one.
    const repair = (model.repairs[1] ?? []).map((f) => f.message);
    expect(repair).toContain('background sentence 1 states 21, and background holds no number; a figure belongs in a claim that cites its line');
    expect(repair).toContain('background sentence 3 gives advice: "You should buy". Background explains; it gives no advice');
    expect(repair).toContain('background holds at most 4 sentences, and sentence 5 is past them');
    // Still there after it, they are taken out on their own: the claims and the rest stand.
    expect(result.outcome).toBe('partial');
    expect(result.response!.claims).toHaveLength(2);
    expect(result.response!.background).toEqual([WHAT, WHY]);
    expect(result.dropped.map((d) => [d.claim.text, d.background])).toEqual([[NUMBER, true], [ADVICE, true], [WHY, true]]);
    const text = renderMarkdown(ASK.render!, answerView(result)!);
    expect(text).toContain(`Taken out of the background, which holds no number and no advice: "${NUMBER}"; "${ADVICE}"; "${WHY}".`);
    expect(text).not.toContain('Not supported by the data');
    // CONTROL: a claim with a number no line holds is still a claim taken out, not background.
    const invented = JSON.stringify({ ...(JSON.parse(GOOD) as object), claims: [...(JSON.parse(GOOD) as { claims: unknown[] }).claims, { text: 'Dominance fell 7.5%.', citations: [{ block: 'btc.pulse', line: 11, quote: DOMINANCE }] }], background: [WHAT] });
    const mixed = await runOperation({ operation: ASK, question: 'q', blocks: [PULSE], model: new Scripted([invented]) });
    expect(mixed.dropped.map((d) => [d.claim.text, d.background ?? false])).toEqual([['Dominance fell 7.5%.', false]]);
    expect(mixed.response!.background).toEqual([WHAT]);
  });

  it('holds background to the schema: a list of sentences', async () => {
    const failures = failuresOf(packetOf(), withBackground(['', 3]));
    expect(failures.filter((f) => f.check === 'schema').length).toBeGreaterThan(0);
  });

  // The personas walk of 2026-10-14: "10Y" and "10Y-2Y" in two background sentences counted as
  // numbers, and cost a whole repair turn. A maturity, a curve spread and a listed index are
  // names (the wording review's ruling of 10-14, 16:28Z); every other figure still counts.
  const MACRO = md('macro.snapshot');
  const TEN = MACRO.lines.findIndex((l) => l.startsWith('10Y Treasury yield at 5.11%')) + 1;
  const onRates = (background: string[], claim = 'The 10Y Treasury yield is at 5.11%.'): string =>
    JSON.stringify({ answer: claim, claims: [{ text: claim, citations: [{ block: 'macro.snapshot', line: TEN, quote: '10Y Treasury yield at 5.11%' }] }], not_in_data: [], background });
  const stated = (sentence: string): string[] =>
    failuresOf(packetOf([MACRO]), onRates([sentence])).filter((f) => f.check === 'grounded_numbers' && f.background !== undefined).map((f) => f.message);
  const states = (figures: string): string[] => [`background sentence 1 states ${figures}, and background holds no number; a figure belongs in a claim that cites its line`];

  it('reads a maturity, a curve spread or a listed index in background as a name, not a number', () => {
    const named = [
      'The 10Y and 2Y yields are what the market pays to lend to the Treasury for ten and two years.',
      'Traders watch the gap between the 10Y and the 2Y.',
      'The 10Y-2Y spread, also called 10s2s, turns negative when the curve inverts.',
      'The 3M bill follows the policy rate closely, and a 30D window smooths out daily noise.',
      'The S&P 500, the Nasdaq-100 and the Russell 2000 are stock indexes.',
      'The S&P500 and the NASDAQ 100 are the same names, written another way.',
    ];
    expect(named.map(stated)).toEqual(named.map(() => []));
  });

  it('still counts every other figure in background, beside a name or not', () => {
    expect(stated('The 10Y rose 10% over the year.')).toEqual(states('10'));
    expect(stated('The 10Y at 5.21 is high by recent standards.')).toEqual(states('5.21'));
    expect(stated('In 2026 the curve steepened.')).toEqual(states('2026'));
    expect(stated('A note that matures in 10 years is a 10Y.')).toEqual(states('10'));
    expect(stated('The S&P 500 at 5,800 is a level, not a name.')).toEqual(states('5800'));
    expect(stated('A $4 fee, a $3M trade and a 5.5M volume are figures.')).toEqual(states('4, 3, 5.5'));
    expect(stated('A 2.5Y note and a 5.5M bill are figures too.')).toEqual(states('2.5, 5.5'));
    // Only an index on the list is a name: any other word before a number is a figure.
    expect(stated('Apple 2000 is no index.')).toEqual(states('2000'));
  });

  // The wording review, 10-14, 16:52Z: "3M" is also three million and a company's name, so a
  // month term is a name only before a rate word or joined to another term.
  it('reads a month term as a name only before a rate word or joined to another term', () => {
    const named = [
      'The 3M bill follows the policy rate.',
      'The 3M-10Y spread turns negative when the curve inverts.',
      'Some read the 10Y-3M spread instead.',
      'The 6M T-bill, the 1M Treasury and 3M SOFR are short rates.',
      'The 3M yield and 6M rates move with the policy rate.',
    ];
    expect(named.map(stated)).toEqual(named.map(() => []));
    expect(stated('3M shares changed hands.')).toEqual(states('3'));
    expect(stated('3M reported a loss.')).toEqual(states('3'));
    expect(stated('The 3M were sold.')).toEqual(states('3'));
    // A pair needs a term on each side: "$3M-10Y" is a figure and a term.
    expect(stated('A $3M-10Y swap is a trade.')).toEqual(states('3'));
  });

  it('says the same rule in the ask primer', () => {
    expect(packetOf().text.replace(/\s+/g, ' ')).toContain('not even a year; a tenor such as 10Y or 3M bills, or a listed index name such as the S&P 500, is a name, not a number.');
  });

  it('holds the indexes it reads as names to one fixed list, each as written there', () => {
    expect(NAMED_INDEXES).toEqual(['S&P 500', 'Russell 2000', 'Nasdaq 100', 'FTSE 100', 'Nikkei 225', 'Euro Stoxx 50', 'DAX 40', 'CAC 40', 'KOSPI 200', 'Nifty 50']);
    expect(NAMED_INDEXES.map((name) => stated(`The ${name} is a stock index.`))).toEqual(NAMED_INDEXES.map(() => []));
    // An index the list does not hold is a word before a number, and its number counts.
    expect(stated('The S&P 600 and the FTSE 250 are stock indexes too.')).toEqual(states('600, 250'));
  });

  it('answers with a maturity in background, with no repair turn', async () => {
    const SPREAD = 'The 10Y-2Y spread is the gap between the yields on ten and two year Treasury notes.';
    const model = new Scripted([onRates([SPREAD])]);
    const result = await runOperation({ operation: ASK, question: 'Where does the 10Y stand?', blocks: [MACRO], model });
    expect(result.outcome).toBe('passed');
    expect(model.repairs).toEqual([undefined]);
    expect(result.response!.background).toEqual([SPREAD]);
  });

  it('still holds a maturity in a claim to the lines it cites', () => {
    // CONTROL: the rates lines name their maturity, so a claim that gives the 2Y the 10Y's
    // yield fails on the 2, and one that names the 10Y passes.
    expect(failuresOf(packetOf([MACRO]), onRates([], 'The 2Y Treasury yield is at 5.11%.'))).toContainEqual({ check: 'grounded_numbers', claim: 0, message: '2 is not in the lines this claim cites' });
    expect(failuresOf(packetOf([MACRO]), onRates([]))).toEqual([]);
  });
});

describe('the config', () => {
  it('is written whole and read back', () => {
    const home = mkdtempSync(join(tmpdir(), 'primerkit-home-'));
    expect(readConfig(home)).toEqual({});
    writeConfig(home, { disclaimer_accepted_at: '2026-09-26T10:00:00.000Z', packet_format: 'json' });
    expect(readConfig(home)).toEqual({ disclaimer_accepted_at: '2026-09-26T10:00:00.000Z', packet_format: 'json' });
  });
});

describe('the small words', () => {
  it('says an answer read from metrics alone stands as it is now, not "generated unknown UTC"', () => {
    expect(whenRead({ asOf: null, generated: null })).toBe('as it stands now');
    expect(whenRead({ asOf: null, generated: '2026-10-07T09:05:00.000Z' })).toBe('generated 09:05 UTC');
  });

  it('says a model that gave no close gave no price, not "gave 0, 0 of them"', () => {
    expect(memoryGave('m', [{ price: null, within: false }, { price: null, within: false }])).toBe('m gave no price for any of them');
    expect(memoryGave('m', [{ price: 61000, within: true }, { price: null, within: false }])).toBe('m gave a price for 1, 1 of them within 5%');
  });
});
