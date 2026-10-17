import { describe, expect, it } from 'vitest';
import {
  blockFromJson,
  blockFromMarkdown,
  cutoffOf,
  dayNumber,
  judgeMemory,
  lastDayOf,
  maskBlock,
  maskLine,
  memoryDates,
  memoryPacket,
  memoryVerdict,
  runMemoryCheck,
  sampleOf,
  stampRead,
  type Close,
  type ModelAdapter,
  type ModelCapabilities,
  type Packet,
} from '../src/index';

describe('the cutoff', () => {
  it("knows a model's cutoff from its maker, or bounds it by its release", () => {
    expect(cutoffOf('claude-opus-5-5')).toMatchObject({ cutoff: '2026-06', basis: 'stated' });
    expect(cutoffOf('claude-haiku-4-5-20251001')).toMatchObject({ cutoff: '2025-07', basis: 'stated' });
    expect(cutoffOf('llama3.1:8b')).toMatchObject({ cutoff: '2023-12', basis: 'stated' });
    expect(cutoffOf('qwen2.5:7b')).toMatchObject({ cutoff: '2024-09', basis: 'release' });
    expect(cutoffOf('qwen2.5:7b')?.source).toContain('states no cutoff');
    // A model it does not know, and one whose name only starts like one it does.
    expect(cutoffOf('mistral-small')).toBeNull();
    expect(cutoffOf('claude-opus-5-50')).toBeNull();
  });

  it('takes the cutoff the person gave over the table, and ignores one that is not a month', () => {
    expect(cutoffOf('qwen2.5:7b', { 'qwen2.5:7b': '2024-06' })).toEqual({ cutoff: '2024-06', source: 'given by you for this model', basis: 'person' });
    expect(cutoffOf('mistral-small', { 'mistral-small': '2025-3' })).toBeNull();
  });

  it('puts a window after the last day of the cutoff month out of sample, and one on it inside', () => {
    const cutoff = { cutoff: '2024-02', source: 'test', basis: 'person' as const };
    expect(lastDayOf('2024-02')).toBe('2024-02-29');
    expect(lastDayOf('2025-12')).toBe('2025-12-31');
    expect(sampleOf('2024-03-01', cutoff).kind).toBe('out');
    expect(sampleOf('2024-02-29', cutoff).kind).toBe('inside');
    expect(sampleOf('2023-06-01', cutoff).kind).toBe('inside');
    expect(sampleOf('2024-03-01', null).kind).toBe('unknown');
  });
});

describe('the memory check', () => {
  it("asks about the window's first day, its middle one and its last, ticks or not", () => {
    expect(memoryDates('2026-09-01', '2026-09-10')).toEqual(['2026-09-01', '2026-09-05', '2026-09-10']);
    // A weekly window is asked as much: its middle day need not be a tick.
    expect(memoryDates('2026-06-01', '2026-08-31')).toEqual(['2026-06-01', '2026-07-16', '2026-08-31']);
    expect(memoryDates('2026-09-01', '2026-09-03')).toEqual(['2026-09-01', '2026-09-02', '2026-09-03']);
    expect(memoryDates('2026-09-01', '2026-09-02')).toEqual(['2026-09-01', '2026-09-02']);
    expect(memoryDates('2026-09-01', '2026-09-01')).toEqual(['2026-09-01']);
    expect(memoryDates('2026-09-02', '2026-09-01')).toEqual([]);
  });

  it('asks with no data at all', () => {
    const packet = memoryPacket('2026-09-01');
    expect(packet.question).toBe("What was Bitcoin's closing price in US dollars on 2026-09-01?");
    expect(packet.blocks).toEqual([]);
    expect(packet.operation.id).toBe('memory-check');
    expect(packet.text).toContain('Guessing is not recalling: say null rather than guess.');
    expect(packet.text).not.toMatch(/\[[a-z.]+ L\d+\]/);
  });

  it('counts an answer within 5% of the close as remembered, and anything but a price as not known', () => {
    expect(judgeMemory('2026-09-01', 100_000, '{"price": 105000}')).toEqual({ date: '2026-09-01', truth: 100_000, price: 105_000, within: true });
    expect(judgeMemory('2026-09-01', 100_000, '{"price": 94999}').within).toBe(false);
    expect(judgeMemory('2026-09-01', 100_000, '```json\n{"price": 99000}\n```')).toMatchObject({ price: 99_000, within: true });
    for (const text of ['{"price": null}', '{"price": "100000"}', '{"price": 0}', '{"price": -5}', 'about a hundred thousand', '']) {
      expect(judgeMemory('2026-09-01', 100_000, text)).toMatchObject({ price: null, within: false });
    }
  });

  it('marks the window remembered at two answers within 5%, and not at one', () => {
    const at = (within: boolean) => ({ date: 'd', truth: 1, price: 1, within });
    expect(memoryVerdict([at(true), at(true), at(false)]).remembered).toBe(true);
    expect(memoryVerdict([at(true), at(false), at(false)]).remembered).toBe(false);
    expect(memoryVerdict([]).remembered).toBe(false);
    // A window too short for three questions needs every one it asked.
    expect(memoryVerdict([at(true)]).remembered).toBe(true);
    expect(memoryVerdict([at(true), at(false)]).remembered).toBe(false);
    expect(memoryVerdict([at(true), at(true)]).remembered).toBe(true);
  });

  it('catches a model that remembers prices, and passes one that says it does not know', async () => {
    const closes: Close[] = [
      { date: '2026-09-01', price: 104_300 },
      { date: '2026-09-02', price: 104_400 },
      { date: '2026-09-03', price: 104_500 },
    ];
    // A scripted model that recalls each close to within 1%, from the question alone.
    const remembers = scripted((p) => ({ price: (closes.find((c) => p.question.includes(c.date))?.price ?? 0) * 0.99 }));
    const check = await runMemoryCheck(remembers.model, '2026-09-01', '2026-09-03', closes);
    expect(check.remembered).toBe(true);
    expect(check.answers.map((a) => a.within)).toEqual([true, true, true]);
    expect(remembers.packets.every((p) => p.blocks.length === 0)).toBe(true);
    expect((await runMemoryCheck(scripted(() => ({ price: null })).model, '2026-09-01', '2026-09-03', closes)).remembered).toBe(false);
    // A model that guesses round numbers is caught only when the guess lands within 5%.
    expect((await runMemoryCheck(scripted(() => ({ price: 50_000 })).model, '2026-09-01', '2026-09-03', closes)).remembered).toBe(false);
  });
});

describe('the masking', () => {
  const ORIGIN = '2026-09-01';

  it("writes a date as a day number from the window's first day, which is day 1", () => {
    expect(dayNumber(ORIGIN, '2026-09-01')).toBe('day 1');
    expect(dayNumber(ORIGIN, '2026-09-25')).toBe('day 25');
    expect(dayNumber(ORIGIN, '2026-08-31')).toBe('day 0');
    expect(dayNumber(ORIGIN, '2026-08-02')).toBe('day -29');
  });

  it('masks ISO days and times, written dates, and a month with its year', () => {
    expect(maskLine('2026-09-01 $104,300', ORIGIN)).toBe('day 1 $104,300');
    expect(maskLine("Bitcoin's daily price in US dollars, from 2026-08-02 to 2026-09-01, oldest first", ORIGIN)).toBe("Bitcoin's daily price in US dollars, from day -29 to day 1, oldest first");
    expect(maskLine('*Generated: Sep 25, 2026 09:05 UTC*', ORIGIN)).toBe('*Generated: day 25 09:05 UTC*');
    expect(maskLine('as of 2026-09-25T09:05:00.000Z', ORIGIN)).toBe('as of day 25');
    expect(maskLine('as of 2026-09-25T09:05+02:00', ORIGIN)).toBe('as of day 25');
    expect(maskLine('on 25 September 2026', ORIGIN)).toBe('on day 25');
    expect(maskLine('August 2026 payrolls', ORIGIN)).toBe('the month of day -30 payrolls');
    expect(maskLine('from Sept. 3, 2026', ORIGIN)).toBe('from day 3');
  });

  it('leaves prices, shares and what is not a date as they are', () => {
    for (const line of ['change over 7 days: +0.7%, from $103,600', 'BTC dominance at 58.5%, falling.', 'held 12 days', '2026-13-45 is no day', 'Today 5 of them, Monday 6']) {
      expect(maskLine(line, ORIGIN)).toBe(line);
    }
  });

  it("writes a briefing's own day count as a count, so a day number in a packet is always a date", () => {
    // PreReason's Hash Ribbon line, as a dated read served it on 2026-09-28.
    expect(maskLine('Hash Ribbon at 1.0043 (bullish, day 26); 7d +0.00245 points (flat, within ±0.00587 points)', ORIGIN)).toBe(
      'Hash Ribbon at 1.0043 (bullish, 26th day); 7d +0.00245 points (flat, within ±0.00587 points)',
    );
    const counts = ['day 1', 'day 2', 'day 3', 'Day 4', 'day 11', 'day 12', 'day 13', 'day 21', 'day 22', 'day 23', 'day 111'];
    expect(counts.map((l) => maskLine(l, ORIGIN))).toEqual(['1st day', '2nd day', '3rd day', '4th day', '11th day', '12th day', '13th day', '21st day', '22nd day', '23rd day', '111th day']);
    // A date beside a count: each keeps its own meaning.
    expect(maskLine('bullish, day 3, since 2026-08-30', ORIGIN)).toBe('bullish, 3rd day, since day -1');
  });

  it('stamps a dated read with the day it stands for, in markdown and in JSON, and leaves the data its own dates', () => {
    // As PreReason serves a past day: built when it is read, its data as of that day.
    const md = blockFromMarkdown('btc.context', '# BTC Context\n*Generated: Sep 28, 2026 22:09 UTC*\n*Data as of: Apr 25, 2026 23:57 UTC*\n', '2026-09-28T22:10:00.000Z');
    const stamped = stampRead(md, '2026-04-25');
    expect(stamped.lines).toEqual(['# BTC Context', '*Generated: 2026-04-25*', '*Data as of: Apr 25, 2026 23:57 UTC*']);
    expect(stamped.generatedAt).toBe('2026-04-25');
    // Dated from the day it stands for, it reads as that day's briefing.
    expect(maskBlock(stamped, '2026-04-25').lines).toEqual(['# BTC Context', '*Generated: day 1*', '*Data as of: day 1 23:57 UTC*']);
    const json = blockFromJson('btc.context', { briefing_used: 'btc.context', date: '2026-04-25', generated_at: '2026-09-28T20:17:13.324Z', metrics: { 'hash-ribbon': { value: 0.9974, timestamp: '2026-04-25T23:57:12+00:00' } } }, '2026-09-28T22:10:00.000Z');
    const read = stampRead(json, '2026-04-25');
    expect(JSON.parse(read.lines[0] as string)).toEqual({ briefing: 'btc.context', date: '2026-04-25', generated_at: '2026-04-25' });
    expect(read.lines.slice(1)).toEqual(json.lines.slice(1));
    expect(read.generatedAt).toBe('2026-04-25');
  });

  it("masks a block's lines and the time it was generated, and keeps the rest", () => {
    const block = { id: 'btc.pulse', source: 'prereason', format: 'markdown' as const, fetchedAt: '2026-09-28T12:00:00.000Z', lines: ['# Pulse', '*Generated: Sep 25, 2026 09:05 UTC*'], generatedAt: 'Sep 25, 2026 09:05 UTC' };
    expect(maskBlock(block, ORIGIN)).toEqual({ ...block, lines: ['# Pulse', '*Generated: day 25 09:05 UTC*'], generatedAt: 'day 25 09:05 UTC' });
  });
});

// A model that answers from a function of the packet, keeping every packet it was given.
function scripted(answer: (packet: Packet) => unknown): { model: ModelAdapter; packets: Packet[] } {
  const packets: Packet[] = [];
  const model: ModelAdapter = {
    id: 'scripted',
    label: 'scripted, local',
    async capabilities(): Promise<ModelCapabilities> {
      return { local: true, schemaConstraint: false, contextTokens: null, canRaiseContext: false, format: 'markdown' };
    },
    async complete(packet: Packet) {
      packets.push(packet);
      return { text: JSON.stringify(answer(packet)) };
    },
  };
  return { model, packets };
}
