import { describe, expect, it } from 'vitest';
import { COMPANY_FAMILY, companyBriefing, companyOf, equitiesRefusal, refusedEquities, scopeCheck, seriesAsked, type Operation, type Packet } from '../src/index';

describe('a company briefing', () => {
  it('names its company by a code PreReason reads it by, in lower case, and nothing else', () => {
    for (const code of ['nvda', '7203', '005930', 'ine018a01030', 'brk-b', '0000320193']) expect(companyBriefing(`${COMPANY_FAMILY}/${code}`)).toBe(`${COMPANY_FAMILY}/${code}`);
    expect(companyBriefing('equities.company/NVDA')).toBe('equities.company/nvda');
    expect(companyOf('equities.company/7203')).toBe('7203');
    // Words never pass as a company: no spaces, no long runs, no second slash.
    for (const id of ['equities.company', 'equities.company/', 'equities.company/my position', 'equities.company/sell-everything-now', 'equities.company/nvda/x', 'equities.company/abcdefghijklmn']) {
      expect(companyBriefing(id), id).toBeNull();
    }
  });

  it('refuses every other equities briefing, and the family alone, each in words that say what to name', () => {
    expect(refusedEquities('equities.company/nvda')).toBe(false);
    expect(refusedEquities('btc.context')).toBe(false);
    expect(refusedEquities('equities.company')).toBe(true);
    expect(refusedEquities('equities.nvda')).toBe(true);
    expect(equitiesRefusal('equities.company')).toBe('equities.company names no company: name it in the id, such as equities.company/nvda, equities.company/7203 or equities.company/005930');
    expect(equitiesRefusal('equities.nvda')).toBe('equities.nvda is refused: of the equities briefings, primerkit reads equities.company/<company> only');
  });

  it('knows a question about figures over several periods from one about a single period', () => {
    // Questions about a company's figures asked in testing (2026-10-08), as the person typed them.
    for (const q of [
      "What was JPMorgan Chase's net income in each of its last eight quarters, and its total assets at the end of each of those quarters?",
      "What were Realty Income's total revenue and net income in each of its last five fiscal years?",
      "What were Nintendo's net sales and operating income in each of its last five fiscal years, in yen?",
      "What were Hyundai Motor's revenue and operating profit in its latest reported quarter, and in the same quarter a year earlier, in won?",
      'How has Apple revenue grown year over year?',
      'Show me the history of Toyota operating income.',
    ]) expect(seriesAsked(q), q).toBe(true);
    for (const q of [
      "What was Apple's revenue in the quarter that ended in December 2009?",
      'What did Apple report last quarter?',
      'Is Mastercard expensive?',
      'Why did Samsung Electronics shares move so much over the last month?',
    ]) expect(seriesAsked(q), q).toBe(false);
  });

  it('passes the scope check with its company named, and fails it without', () => {
    const operation = { spec: { kind: 'research', output: { forbiddenFields: [] } } } as unknown as Operation;
    const packet = (id: string) => ({ blocks: [{ id }] }) as unknown as Packet;
    expect(scopeCheck.run(packet('equities.company/nvda'), {}, operation)).toEqual([]);
    expect(scopeCheck.run(packet('equities.nvda'), {}, operation)).toEqual([{ check: 'scope', reason: 'equities', message: equitiesRefusal('equities.nvda') }]);
  });
});
