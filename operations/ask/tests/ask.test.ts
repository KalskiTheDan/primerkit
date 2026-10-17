import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { answerView, blockFromJson, blockFromMarkdown, buildPacket, loadOperation, renderMarkdown, runOperation, type DataBlock } from '@primerkit/core';
import { ExtractiveModel, ScriptedModel } from '@primerkit/models';

// The ask operation against the briefings PreReason served on 2026-09-25, with a
// scripted model: no network, no key and no model.

const here = dirname(fileURLToPath(import.meta.url));
const ASK = loadOperation(join(here, '..'));
const FIXTURES = join(here, '..', '..', 'bench-comprehension', 'briefings-2026-09-25');
const FETCHED = '2026-09-25T09:06:00.000Z';
const json = (id: string): DataBlock => blockFromJson(id, readFileSync(join(FIXTURES, `${id}.json`), 'utf8'), FETCHED);
const md = (id: string): DataBlock => blockFromMarkdown(id, readFileSync(join(FIXTURES, `${id}.md`), 'utf8'), FETCHED);

const cite = (line: number, quote: string) => ({ block: 'btc.context', line, quote });
const ANSWER = {
  answer: 'Bitcoin is at $84,512.32, up 10.6% over 7 days, with the hash rate up 4.2% and net liquidity stable at $5.77T.',
  claims: [
    { text: 'Bitcoin is at $84,512.32, up 10.6% over 7 days.', citations: [cite(2, 'BTC at $84,512.32, up 10.6% over 7d.')] },
    { text: 'The hash rate is 933.46 EH/s, up 4.2% over 7 days.', citations: [cite(3, 'Hash rate at 933.46 EH/s, up 4.2% over 7d.')] },
    { text: 'Net liquidity is stable at $5.77T.', citations: [cite(5, 'Net liquidity stable at $5.77T.')] },
  ],
  not_in_data: [],
};

describe('the ask operation', () => {
  it('is a research operation with the five checks, and forbids what a trade would need', () => {
    expect(ASK.spec).toMatchObject({ id: 'ask', kind: 'research', checks: ['schema', 'citations', 'grounded_numbers', 'grounded_directions', 'scope'] });
    expect(ASK.spec.output.forbiddenFields).toEqual(['action', 'side', 'size']);
    expect(ASK.spec.data.sources[0]).toMatchObject({ connector: 'prereason', briefing: { from: 'input' }, format: 'json' });
  });

  it('caps a packet at 32,000 tokens, which a company briefing cut down fits (12,965 for Broadcom on 2026-10-09)', () => {
    expect(ASK.spec.data.maxPacketTokens).toBe(32000);
    // 0.2.0 (2026-10-10): background from the model's general knowledge, apart from the data.
    // 0.3.0 (2026-10-14): a direction needs a change in the lines a claim cites.
    expect(ASK.spec.version).toBe('0.3.0');
  });

  it('fits two JSON briefings within its packet cap', () => {
    const packet = buildPacket({ operation: ASK, question: 'Where does Bitcoin stand?', blocks: [json('btc.pulse'), json('btc.context')] });
    expect(packet.tokens.count).toBeLessThan(ASK.spec.data.maxPacketTokens!);
  });

  it('answers from the JSON briefings with citations, and every check passes', async () => {
    const result = await runOperation({
      operation: ASK,
      question: 'Where does Bitcoin stand?',
      blocks: [json('btc.pulse'), json('btc.context')],
      model: new ScriptedModel([JSON.stringify(ANSWER)]),
    });
    expect(result.outcome).toBe('passed');
    expect(result.checks.every((c) => c.failures.length === 0)).toBe(true);
    const text = renderMarkdown(ASK.render!, answerView(result)!);
    expect(text).toBe(
      [
        `**${ANSWER.answer}**`,
        '',
        'Bitcoin is at $84,512.32, up 10.6% over 7 days [1]. The hash rate is 933.46 EH/s, up 4.2% over 7 days [2]. Net liquidity is stable at $5.77T [3].',
        '',
        `✓ 5 of 5 checks: answer format · claims cite their lines · figures match the lines cited · direction words cite a change · no advice words · ${result.packet.tokens.count.toLocaleString('en-US')} tokens read`,
        '',
        '[1] btc.context, line 2 · [2] btc.context, line 3 · [3] btc.context, line 5',
        '',
        'PR · btc.pulse, btc.context · generated 09:05 UTC · written by your model, not investment advice',
        '',
      ].join('\n'),
    );
  });

  it('repairs a rounded figure on the second turn', async () => {
    const rounded = { ...ANSWER, answer: 'Bitcoin is near $84,500.', claims: [{ ...ANSWER.claims[0]!, text: 'Bitcoin is near $84,500.' }] };
    const model = new ScriptedModel([JSON.stringify(rounded), JSON.stringify(ANSWER)]);
    const result = await runOperation({ operation: ASK, question: 'Where does Bitcoin stand?', blocks: [json('btc.context')], model });
    expect(result.outcome).toBe('passed');
    expect(result.attempts).toBe(2);
    expect(model.calls[1]?.repair?.map((f) => f.check)).toContain('grounded_numbers');
  });

  it('sends a misquoted line back for repair', async () => {
    const misquoted = { ...ANSWER, claims: [{ ...ANSWER.claims[0]!, citations: [cite(2, 'BTC at $85,000, up 10.6% over 7d.')] }, ...ANSWER.claims.slice(1)] };
    const model = new ScriptedModel([JSON.stringify(misquoted), JSON.stringify(ANSWER)]);
    const result = await runOperation({ operation: ASK, question: 'Where does Bitcoin stand?', blocks: [json('btc.context')], model });
    expect(result.outcome).toBe('passed');
    expect(result.attempts).toBe(2);
    expect(model.calls[1]?.repair?.map((f) => f.check)).toContain('citations');
  });

  it('fails an answer that tells the reader what to do, even after the repair turn', async () => {
    const advice = JSON.stringify({ ...ANSWER, action: 'buy' });
    const result = await runOperation({ operation: ASK, question: 'Should I buy?', blocks: [json('btc.context')], model: new ScriptedModel([advice, advice]) });
    expect(result.outcome).toBe('failed');
    expect(result.response).toBeNull();
    // The ask's schema holds no action, so the answer fails on its format, and no other check
    // runs on an answer in the wrong shape.
    expect(result.checks).toEqual([{ id: 'schema', failures: [expect.objectContaining({ reason: 'format', message: 'the response holds a field its format does not allow: action' })] }]);
    expect(result.reason).toBe('the response holds a field its format does not allow: action');
    // An operation whose schema lets the field through has scope refuse it.
    const open = { ...ASK, schema: { type: 'object' } };
    const scoped = await runOperation({ operation: open, question: 'Should I buy?', blocks: [json('btc.context')], model: new ScriptedModel([advice, advice]) });
    expect(scoped.outcome).toBe('failed');
    expect(scoped.checks.find((c) => c.id === 'scope')?.failures[0]?.message).toBe('a research operation may not return action');
  });

  it('answers each free briefing in the demo, with no model and no key', async () => {
    for (const id of ['btc.pulse', 'btc.context', 'macro.snapshot', 'cross.correlations', 'btc.grid-stress']) {
      const result = await runOperation({ operation: ASK, question: 'What does this briefing say?', blocks: [md(id)], model: new ExtractiveModel('markdown') });
      expect(result.outcome, id).toBe('passed');
      expect(result.response?.claims.length, id).toBeGreaterThan(0);
      for (const claim of result.response!.claims) expect(claim.citations[0]?.block).toBe(id);
    }
  });
});
