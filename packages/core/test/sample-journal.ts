import { Journal } from '../src/index';

// A scripted journal, sample data: two asks and a routine's tick, kept as runOperation keeps
// them (packet.json with its numbered lines, the reply, checks.json, render.md and meta.json).
export function sampleJournal(root: string): Journal {
  const journal = new Journal(root);
  const run = (op: string, id: string, at: string, files: { question: string; blocks: Array<{ id: string; lines: string[] }>; reply: object; outcome: string; failures?: string[]; render: string; usage?: object; cost?: object | null }) => {
    const r = journal.open(op, id, new Date(at));
    r.write('packet.json', { runId: id, operation: { id: op, version: '1' }, question: files.question, hash: 'h', tokens: { label: 'o200k', count: 1200 }, notes: [], blocks: files.blocks.map((b) => ({ ...b, source: 'prereason', format: 'json', fetchedAt: at })) });
    r.write('response.json', { attempt: 1, text: JSON.stringify(files.reply) });
    r.write('checks.json', [{ id: 'schema', failures: [] }, { id: 'citations', failures: (files.failures ?? []).map((message) => ({ check: 'citations', message })) }]);
    r.write('render.md', files.render);
    r.write('meta.json', { runId: id, operation: { id: op, version: '1' }, model: 'anthropic:claude-haiku-5-5', outcome: files.outcome, attempts: 1, dropped: 0, tokens: { label: 'o200k', count: 1200 }, usage: files.usage ?? null, cost: files.cost ?? null });
  };
  run('ask', '20261016T090000Z-aaaaaa', '2026-10-16T09:00:00Z', {
    question: 'Where do Treasury yields stand?',
    blocks: [{ id: 'macro.snapshot', lines: ['{"briefing":"macro.snapshot"}', '{"metric":"treasury-2y","value_formatted":"3.48%"}', '{"metric":"treasury-10y","value_formatted":"4.02%"}'] }],
    reply: { answer: 'The 10-year yield is 4.02%.', claims: [{ text: 'The 10-year yield is 4.02%.', citations: [{ block: 'macro.snapshot', line: 3, quote: '"value_formatted":"4.02%"' }] }], not_in_data: [] },
    outcome: 'passed',
    render: '**The 10-year yield is 4.02%.**\n',
    usage: { inputTokens: 1300, outputTokens: 90, cacheReadTokens: 0, cacheWriteTokens: 0, reported: true },
    cost: { usd: 0.000175, basis: 'list price' },
  });
  run('ask', '20261016T100000Z-bbbbbb', '2026-10-16T10:00:00Z', {
    question: 'Is the dollar strengthening?',
    blocks: [{ id: 'fx.liquidity', lines: ['{"briefing":"fx.liquidity"}', '{"metric":"dxy","value_formatted":"27.10"}'] }],
    reply: { answer: 'The dollar fund is at 27.10.', claims: [{ text: 'The dollar fund is at 27.10.', citations: [{ block: 'fx.liquidity', line: 2, quote: 'not there' }] }], not_in_data: [] },
    outcome: 'failed',
    failures: ['the quote is not in the line'],
    render: 'The answer did not pass its checks.\n',
  });
  run('routine.btc-rules', '20261015T120000Z-cccccc', '2026-10-15T12:00:00Z', {
    question: 'Apply the rules to the data.',
    blocks: [
      { id: 'rules', lines: ['# my rules', 'enter when the hash ribbon is above 1'] },
      { id: 'btc.context', lines: ['{"briefing":"btc.context"}', '{"metric":"hash-ribbon","value_formatted":"1.016"}'] },
    ],
    reply: { label: 'enter', reason: 'The hash ribbon reads 1.016, above 1.', claims: [{ text: 'The hash ribbon is 1.016.', citations: [{ block: 'rules', line: 2, quote: 'enter when the hash ribbon is above 1' }, { block: 'btc.context', line: 2, quote: '"value_formatted":"1.016"' }] }], not_in_data: [] },
    outcome: 'passed',
    render: '**enter**\n',
  });
  return journal;
}
