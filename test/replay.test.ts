import { describe, expect, it } from 'vitest';
import type { Entry } from '@primerkit/session';
import { recordOf, replayReadme } from '../scripts/replay';

const asked = { id: 'J6-named', question: 'equities.company/fxmp: What were its net sales?', pass: 49 };
const answer: Entry = {
  kind: 'answer',
  question: asked.question,
  view: {
    headline: '',
    sentences: [{ text: 'Net sales were ¥1.07T [1].', refs: [1] }],
    sources: [{ n: 1, block: 'equities.company/fxmp', line: 12 }],
    background: ['Fictional Group moved its year end to February.'],
    dropped: [{ text: 'Profit rose 9%.', reasons: ['not in the data'] }],
    checks: { passed: 3, total: 4 },
    tokens: 2_100,
    seconds: 6.4,
    briefings: ['equities.company/fxmp'],
    generated: null,
    asOf: null,
    partial: true,
  },
  skipped: [],
  notes: [],
  added: [],
};

describe('the replay', () => {
  it('records what an answer read, said, dropped and cost, and keeps the set\'s own fields', () => {
    const r = recordOf(asked, answer, 0.0412, '01-j6-named.svg');
    expect(r).toMatchObject({ id: 'J6-named', pass: 49, outcome: 'partial', read: ['equities.company/fxmp'], answer: 'Net sales were ¥1.07T [1].', background: 'Fictional Group moved its year end to February.', dropped: ['Profit rose 9%.'], checks: '3 of 4', tokens: 2_100, seconds: 6.4, usd: 0.0412, file: '01-j6-named.svg' });
    // CONTROL: a whole answer is "answered", a note is "not answered", nothing is "failed".
    expect(recordOf(asked, { ...answer, view: { ...answer.view, partial: false } } as Entry, 0, null).outcome).toBe('answered');
    expect(recordOf(asked, { kind: 'note', question: asked.question, text: 'No briefing matched.' }, 0, null)).toMatchObject({ outcome: 'not answered', notes: ['No briefing matched.'] });
    expect(recordOf(asked, { kind: 'failed', question: asked.question, message: 'PreReason refused it.', detail: '429' }, 0, null)).toMatchObject({ outcome: 'failed', notes: ['PreReason refused it.', '429'] });
    expect(recordOf(asked, undefined, 0, null).outcome).toBe('failed');
  });

  it('writes a table of every question, then each answer in full with its screen', () => {
    const rows = [recordOf(asked, answer, 0.0412, '01-j6-named.svg'), { ...recordOf({ id: 'J7-asked', question: 'And Tadano?' }, undefined, 0, null), outcome: 'stopped' as const }];
    const md = replayReadme('Replay: value check', 'Asked through primerkit.', rows);
    expect(md).toContain('2 questions: 0 answered with every check passed, 1 partly answered, 0 not answered (no briefing matched, or none could be read), 0 failed, 1 not asked (the cap). Spent $0.0412 at list.');
    expect(md).toContain('| J6-named | partial | equities.company/fxmp | 3 of 4 | 2100 | 6.4 | $0.0412 |');
    expect(md).toContain('| J7-asked | stopped | - | - | - | - | $0.0000 |');
    expect(md).toContain('> equities.company/fxmp: What were its net sales?');
    expect(md).toContain('Background, not from the data: Fictional Group moved its year end to February.');
    expect(md).toContain('- Taken out: "Profit rose 9%."');
    expect(md).toContain('![J6-named](01-j6-named.svg)');
  });
});
