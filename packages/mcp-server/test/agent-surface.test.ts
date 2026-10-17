import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { Journal, Snapshots, approveLiveIntent, findLiveIntent, loadOperation, writeConfig } from '@primerkit/core';
import { FixtureConnector, PreReasonError, parseCatalog } from '@primerkit/connector-prereason';
import { ASK_DIR, BENCH_BRIEFINGS, DEMO_CATALOG, DIGEST_DIR } from '@primerkit/session';
import { HostRuns, ROBINHOOD_URL, TOOLS, callTool, codeOf, serveMcp, type HostDeps } from '../src/index';

const ask = loadOperation(ASK_DIR);
const digest = loadOperation(DIGEST_DIR);
const catalog = parseCatalog(JSON.parse(readFileSync(DEMO_CATALOG, 'utf8')));
const NOW = new Date('2026-09-26T14:00:00.000Z');
const GOOD = {
  answer: 'Bitcoin is at $84,512.32.',
  claims: [{ text: 'Bitcoin is at $84,512.32.', citations: [{ block: 'btc.pulse', line: 2, quote: '"value_formatted":"$84,512.32"' }] }],
  not_in_data: [],
};

function setup(over: Partial<HostDeps> = {}): { runs: HostRuns; home: string } {
  const home = mkdtempSync(join(tmpdir(), 'pk-agent-'));
  const deps: HostDeps = {
    ask,
    digest,
    data: () => new FixtureConnector(BENCH_BRIEFINGS),
    catalog: async () => catalog,
    metrics: async () => [{ id: 'treasury-10y', name: '10-Year Treasury yield', description: 'The 10-year yield, daily.', category: 'rates' }],
    tier: () => 'free',
    watchlist: async () => ['btc.context'],
    snapshots: new Snapshots(join(home, 'snapshots')),
    journal: new Journal(join(home, 'journal')),
    home,
    bench: null,
    routine: null,
    now: () => NOW,
    ...over,
  };
  return { runs: new HostRuns(deps), home };
}

type Result = Awaited<ReturnType<typeof callTool>>;
// The JSON block beside the text, as the second text block, and never as structuredContent,
// which an app would hand its model in place of the text.
function jsonOf(result: Result | Record<string, unknown>): Record<string, unknown> {
  expect(result).not.toHaveProperty('structuredContent');
  const content = (result as Result).content;
  return JSON.parse(content[1]?.text ?? 'null') as Record<string, unknown>;
}

describe('the agent surface of the MCP server', () => {
  it('gives every ask step a JSON block beside its text: the packet, the repair and the checked answer', async () => {
    const { runs } = setup();
    const prepared = await callTool(runs, 'prepare_operation', { operation: 'ask', question: 'Where does Bitcoin stand?', briefings: ['btc.pulse'] });
    const packet = jsonOf(prepared);
    expect(packet).toMatchObject({ kind: 'packet', operation: 'ask', question: 'Where does Bitcoin stand?', as_of: null, skipped: [] });
    expect(packet.blocks).toEqual([expect.objectContaining({ id: 'btc.pulse', source: expect.any(String), lines: expect.any(Number) })]);
    expect((packet.tokens as { packet: number }).packet).toBeGreaterThan(0);
    const runId = packet.run_id as string;
    expect(prepared.content[0]!.text).toContain(`run_id: ${runId}`);

    const repair = await callTool(runs, 'submit_response', { run_id: runId, response: { ...GOOD, claims: [{ ...GOOD.claims[0]!, citations: [{ block: 'btc.pulse', line: 2, quote: 'nowhere' }] }] } });
    const failed = jsonOf(repair);
    expect(failed).toMatchObject({ run_id: runId, outcome: 'repair' });
    expect((failed.failures as Array<{ check: string }>).map((f) => f.check)).toContain('citations');

    const done = jsonOf(await callTool(runs, 'submit_response', { run_id: runId, response: GOOD }));
    expect(done).toMatchObject({ run_id: runId, operation: 'ask', outcome: 'passed', answer: GOOD.answer, not_in_data: [], dropped: [], cost: null, model: 'the model of the AI app (declared)' });
    expect(done.claims).toEqual([{ text: GOOD.claims[0]!.text, citations: [{ block: 'btc.pulse', line: 2, quote: '"value_formatted":"$84,512.32"' }] }]);
    const checks = done.checks as Array<{ id: string; passed: boolean }>;
    expect(checks.length).toBeGreaterThan(0);
    expect(checks.every((c) => c.passed)).toBe(true);

    // The run is in the journal's JSON, and in today's counts.
    const journal = jsonOf(await callTool(runs, 'journal_read', {}));
    expect(journal).toMatchObject({ kept: true, runs: [expect.objectContaining({ run_id: runId, operation: 'ask', outcome: 'passed', host: true })] });
    const status = jsonOf(await callTool(runs, 'status', {}));
    expect(status).toMatchObject({ journal: { today: { day: '2026-09-26', runs: 1, outcomes: { passed: 1 } } } });
  });

  it("reads its status: the app's model, PreReason, Alpaca on paper, and Robinhood off until it is added", async () => {
    const { runs, home } = setup();
    const off = await callTool(runs, 'status', {});
    expect(jsonOf(off)).toMatchObject({ model: { answering: 'the model of this AI app', terminal: null }, prereason: { connected: true, tier: 'free', demo: false }, brokers: { alpaca: { mode: 'off', account: 'paper' }, robinhood: { mode: 'off' } } });
    expect(off.content[0]!.text).toContain('Robinhood: off.');
    writeConfig(home, { model: { kind: 'hosted', provider: 'anthropic', name: 'claude-sonnet-5-5' }, brokers: { alpaca: { mode: 'paper' }, robinhood: { hosts: ['claude-code'], added: ['claude-code'], approvals_confirmed_at: '2026-09-26T13:00:00.000Z' } } });
    const on = await callTool(runs, 'status', {});
    expect(jsonOf(on)).toMatchObject({
      model: { terminal: 'claude-sonnet-5-5 on anthropic' },
      brokers: { alpaca: { mode: 'paper' }, robinhood: { mode: 'live', server: ROBINHOOD_URL, hosts: ['claude-code'], approvals_confirmed_at: '2026-09-26T13:00:00.000Z', primerkit_sends_orders: false } },
    });
    expect(on.content[0]!.text).toContain('Robinhood: live agent account, real money; added to claude-code.');
    expect(TOOLS.find((t) => t.name === 'status')?.annotations).toEqual({ readOnlyHint: true });
    expect(TOOLS.find((t) => t.name === 'catalog')?.annotations).toEqual({ readOnlyHint: true });
  });

  it('searches the catalog by words, the briefings this key reads and the metrics', async () => {
    const { runs } = setup();
    const all = jsonOf(await callTool(runs, 'catalog', {}));
    expect((all.counts as { briefings: number }).briefings).toBeGreaterThan(1);
    const btc = jsonOf(await callTool(runs, 'catalog', { query: 'bitcoin', kind: 'briefings' }));
    const hits = btc.briefings as Array<{ id: string; name: string; description: string }>;
    expect(hits.map((b) => b.id)).toContain('btc.context');
    // Every hit holds the word in its id, name or description, and nothing else is listed.
    expect(hits.every((b) => `${b.id} ${b.name} ${b.description}`.toLowerCase().includes('bitcoin'))).toBe(true);
    expect(hits.length).toBeLessThan((all.counts as { briefings: number }).briefings);
    expect(btc.metrics).toEqual([]);
    const rates = jsonOf(await callTool(runs, 'catalog', { query: 'treasury', kind: 'metrics' }));
    expect(rates).toMatchObject({ briefings: [], metrics: [{ id: 'treasury-10y', category: 'rates' }] });
    expect(jsonOf(await callTool(runs, 'catalog', { query: 'zzz-none' }))).toMatchObject({ counts: { briefings: 0, metrics: 0 } });
  });

  it('keeps a live intent as pending, reads its state, and refuses one with problems', async () => {
    const { runs, home } = setup();
    const kept = await callTool(runs, 'intent_record', { symbol: 'AAPL', side: 'buy', quantity: 2, source: 'typed' });
    const intent = jsonOf(kept);
    expect(intent).toMatchObject({ symbol: 'AAPL', side: 'buy', quantity: 2, order_type: 'market', state: 'pending', broker: 'robinhood' });
    const id = intent.intent_id as string;
    expect(intent.approve_with).toBe(`primerkit intent approve ${id}`);
    expect(kept.content[0]!.text).toContain('Nothing was sent.');
    expect(jsonOf(await callTool(runs, 'status', { intent_id: id }))).toMatchObject({ intent: { intent_id: id, state: 'pending', approved_at: null }, journal: { live_intents: { pending: 1, approved: 0 } } });
    approveLiveIntent(findLiveIntent(join(home, 'journal'), id)!, new Date(NOW.getTime() + 60_000));
    expect(jsonOf(await callTool(runs, 'status', { intent_id: id }))).toMatchObject({ intent: { state: 'approved' } });

    const bad = await callTool(runs, 'intent_record', { symbol: 'AAPL', side: 'buy', quantity: 2, source: 'model' });
    expect(bad.isError).toBe(true);
    expect(jsonOf(bad)).toMatchObject({ ok: false, error: { code: 'bad_input' } });
    expect(bad.content[0]!.text).toMatch(/^The intent was not kept: source: typed/);
    const missing = await callTool(runs, 'status', { intent_id: '20260926T140000Z-000000' });
    expect(jsonOf(missing)).toMatchObject({ error: { code: 'not_found' } });
    // The demo keeps no intent.
    const demo = setup({ savedOn: '2026-09-25' });
    expect(jsonOf(await callTool(demo.runs, 'intent_record', { symbol: 'AAPL', side: 'buy', quantity: 1, source: 'typed' }))).toMatchObject({ error: { code: 'bad_input' } });
  });

  it('types its errors: no key, the tier, the rate window, and a tool that is not there', async () => {
    const { runs } = setup({ data: () => null });
    const none = await callTool(runs, 'prepare_operation', { operation: 'ask', question: 'Where does Bitcoin stand?', briefings: ['btc.pulse'] });
    expect(none.isError).toBe(true);
    expect(jsonOf(none)).toMatchObject({ ok: false, error: { code: 'no_key', message: expect.stringContaining('PreReason is not connected') } });
    expect(jsonOf(await callTool(runs, 'no_such_tool', {}))).toMatchObject({ error: { code: 'not_found' } });
    expect(codeOf(new PreReasonError('over the limit', 429, 'RATE_LIMITED', 30))).toBe('rate_window');
    expect(codeOf(new PreReasonError('a paid plan reads it', 403, 'TIER_RESTRICTED'))).toBe('tier_refused');
    expect(codeOf(new Error('anything'))).toBe('failed');
  });
});

describe('the MCP server over stdio, as an AI app drives it', () => {
  it('lists the new tools and answers status, catalog and intent_record with JSON', async () => {
    const { runs } = setup();
    const input = new PassThrough();
    const output = new PassThrough();
    const lines: string[] = [];
    output.on('data', (d: Buffer) => lines.push(...d.toString().split('\n').filter(Boolean)));
    const served = serveMcp(runs, { input, output }, { version: '0.1.0-test' });
    const send = (id: number, method: string, params: object = {}) => input.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    send(1, 'initialize', { protocolVersion: '2025-06-18' });
    send(2, 'tools/list');
    send(3, 'tools/call', { name: 'status', arguments: {} });
    send(4, 'tools/call', { name: 'catalog', arguments: { query: 'bitcoin' } });
    send(5, 'tools/call', { name: 'intent_record', arguments: { symbol: 'NVDA', side: 'buy', quantity: 1, source: 'rules', rules: 'my-trend-rules' } });
    send(6, 'tools/call', { name: 'intent_record', arguments: { symbol: 'NVDA', side: 'buy', quantity: 1 } });
    await new Promise((r) => setTimeout(r, 300));
    input.end();
    await served;
    const byId = new Map(lines.map((l) => JSON.parse(l) as { id: number; result: Record<string, unknown> }).map((m) => [m.id, m.result]));
    expect((byId.get(2)!.tools as Array<{ name: string }>).map((t) => t.name)).toEqual(expect.arrayContaining(['status', 'catalog', 'intent_record']));
    expect(jsonOf(byId.get(3)!)).toMatchObject({ prereason: { connected: true }, brokers: { robinhood: { mode: 'off' } } });
    expect(jsonOf(byId.get(4)!)).toMatchObject({ tier: 'free', query: 'bitcoin' });
    expect(jsonOf(byId.get(5)!)).toMatchObject({ symbol: 'NVDA', state: 'pending', source: { kind: 'rules', rules: 'my-trend-rules' } });
    expect(byId.get(6)).toMatchObject({ isError: true });
    expect(jsonOf(byId.get(6)!)).toMatchObject({ error: { code: 'bad_input' } });
  });
});
