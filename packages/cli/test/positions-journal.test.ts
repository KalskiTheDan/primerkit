import { execFile } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { Journal, recordLiveIntent } from '@primerkit/core';
import { sampleJournal } from '../../core/test/sample-journal';

const BIN = fileURLToPath(new URL('../bin/primerkit.js', import.meta.url));

// The command as a script runs it, with its own homes, its input a pipe, and no key.
function run(args: string[], home: string): Promise<{ code: number; out: string; err: string }> {
  return new Promise((resolve) => {
    execFile(process.execPath, [BIN, ...args], { env: { ...process.env, HOME: home, USERPROFILE: home, PRIMERKIT_HOME: join(home, '.primerkit'), PREREASON_API_KEY: '' }, timeout: 90_000 }, (error, out, err) =>
      resolve({ code: error ? Number((error as NodeJS.ErrnoException).code ?? 1) : 0, out, err }),
    );
  });
}

describe('a journal you can find things in, and positions you can read, from the command line (sample data)', { timeout: 300_000 }, () => {
  it('filters, searches, sums and opens runs, and lists every intent with nothing sent', async () => {
    const home = mkdtempSync(join(tmpdir(), 'pk-cli-find-'));
    const root = join(home, '.primerkit', 'journal');
    sampleJournal(root);
    recordLiveIntent(new Journal(root), { symbol: 'AAPL', side: 'buy', quantity: 2, source: 'typed' }, new Date());

    const failed = JSON.parse((await run(['journal', '--json', '--operation', 'ask', '--outcome', 'failed'], home)).out);
    expect(failed).toMatchObject({ ok: true, query: { operation: 'ask', outcome: 'failed' }, runs: [{ run_id: '20261016T100000Z-bbbbbb', question: 'Is the dollar strengthening?', briefings: ['fx.liquidity'] }] });
    const found = JSON.parse((await run(['journal', '--json', '--search', 'treasury yields'], home)).out);
    expect(found.runs.map((r: { run_id: string }) => r.run_id)).toEqual(['20261016T090000Z-aaaaaa']);
    const byBriefing = JSON.parse((await run(['journal', '--json', '--briefing', 'btc.context'], home)).out);
    expect(byBriefing.runs.map((r: { operation: string }) => r.operation)).toEqual(['routine.btc-rules']);
    const summed = JSON.parse((await run(['journal', '--json', '--summary', '--operation', 'ask'], home)).out);
    expect(summed.days).toEqual([expect.objectContaining({ day: '2026-10-16', runs: 2, outcomes: { passed: 1, failed: 1 } })]);

    const opened = JSON.parse((await run(['journal', '--json', '--run', '20261015T120000Z-cccccc'], home)).out);
    expect(opened.run).toMatchObject({ label: 'enter', reason: 'The hash ribbon reads 1.016, above 1.' });
    expect(opened.run.claims[0].citations[1]).toEqual({ block: 'btc.context', line: 2, quote: '"value_formatted":"1.016"', line_text: '{"metric":"hash-ribbon","value_formatted":"1.016"}' });
    expect(opened.run).not.toHaveProperty('view');
    const text = await run(['journal', '--run', '20261016T090000Z-aaaaaa'], home);
    expect(text.out).toContain('Question: Where do Treasury yields stand?');
    expect(text.out).toContain('  [macro.snapshot L3] {"metric":"treasury-10y","value_formatted":"4.02%"}');
    const missing = await run(['journal', '--json', '--run', '20261016T000000Z-000000'], home);
    expect(missing.code).toBe(1);
    expect(JSON.parse(missing.out)).toMatchObject({ ok: false, error: { code: 'not_found' } });
    const badDay = await run(['journal', '--json', '--day', '16-10-2026'], home);
    expect(JSON.parse(badDay.out)).toMatchObject({ ok: false, error: { code: 'bad_input' } });

    // No broker set: the paper account is not read, and the intents are listed all the same.
    const positions = JSON.parse((await run(['positions', '--json'], home)).out);
    expect(positions).toMatchObject({ ok: true, holdings: { kind: 'note', text: expect.stringContaining('off.') }, intents: [{ symbol: 'AAPL', side: 'buy', quantity: '2', broker: 'Robinhood live', from: 'an order you typed', state: 'pending', approved_at: null }] });
    const shown = await run(['positions'], home);
    expect(shown.out).toContain('Alpaca paper: off.');
    expect(shown.out).toMatch(/AAPL +buy +2 +Robinhood live +pending +an order you typed/);
    expect(shown.out).toContain('Nothing here sends an order.');
  });
});
