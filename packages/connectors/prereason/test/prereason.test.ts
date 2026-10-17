import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  BRIDGE,
  CLAIM_LINK,
  FixtureConnector,
  PreReasonClient,
  PreReasonError,
  RefusedRequest,
  claimLaunch,
  connectPreReason,
  contextUrl,
  coverage,
  endTree,
  fetchCatalog,
  fetchMetricCatalog,
  keptFor,
  idsShown,
  moreByArea,
  parseCatalog,
  briefingsByArea,
  pickBriefings,
  readableBy,
  smallestFree,
  resolveKey,
  spawnBridge,
  tierOf,
  wordsOf,
  type ClaimEvent,
  type ClaimProcess,
} from '../src/index';

const here = dirname(fileURLToPath(import.meta.url));
const CATALOG = JSON.parse(readFileSync(join(here, 'fixtures', 'catalog-2026-09-26.json'), 'utf8')) as unknown;
const BRIEFINGS = join(here, '..', '..', '..', '..', 'operations', 'bench-comprehension', 'briefings-2026-09-25');
const BASE = 'https://api.prereason.com';

// Keys are built here, never written out, and are not real keys.
const fakeKey = (tag: string) => `pr_test_${tag.repeat(20)}`;

// A fetch that records every request and answers from a table.
function recorder(answer: (url: URL) => Response) {
  const seen: Array<{ url: URL; headers: Record<string, string> }> = [];
  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    seen.push({ url, headers: Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>)) });
    return answer(url);
  }) as typeof fetch;
  return { seen, impl };
}

describe('the identifier allowlist', () => {
  it('builds a request from a briefing id, a format and a date only', () => {
    expect(contextUrl(BASE, { briefing: 'btc.pulse', format: 'json' })).toBe(`${BASE}/api/context?briefing=btc.pulse&format=json`);
    expect(contextUrl(BASE, { briefing: 'macro.snapshot', format: 'markdown', date: '2026-09-25' })).toBe(
      `${BASE}/api/context?briefing=macro.snapshot&format=markdown&date=2026-09-25`,
    );
  });

  it("reads a company's statement history at its own door, as it stands today, and for a company only", () => {
    expect(contextUrl(BASE, { briefing: 'equities.company/jpm', format: 'markdown', history: true })).toBe(`${BASE}/api/companies/jpm/numbers?history=true&format=markdown`);
    expect(() => contextUrl(BASE, { briefing: 'macro.snapshot', format: 'markdown', history: true })).toThrow('macro.snapshot: statement history is read for a company briefing only');
    expect(() => contextUrl(BASE, { briefing: 'equities.company/jpm', format: 'markdown', date: '2026-09-25', history: true })).toThrow('statement history is served as it stands today, with no date');
  });

  it('refuses free text, an equities briefing, an unknown format and a malformed date', () => {
    expect(() => contextUrl(BASE, { briefing: 'where does bitcoin stand?', format: 'json' })).toThrow(RefusedRequest);
    expect(() => contextUrl(BASE, { briefing: 'btc.pulse&question=hi', format: 'json' })).toThrow(RefusedRequest);
    expect(() => contextUrl(BASE, { briefing: 'equities.nvda', format: 'json' })).toThrow(/of the equities briefings, primerkit reads equities\.company\/<company> only/);
    expect(() => contextUrl(BASE, { briefing: 'btc.pulse', format: 'html' as 'json' })).toThrow(RefusedRequest);
    expect(() => contextUrl(BASE, { briefing: 'btc.pulse', format: 'json', date: 'yesterday' })).toThrow(RefusedRequest);
  });
});

describe('what reaches PreReason', () => {
  it('sends only the allowed hosts, paths, parameters and headers, and never the question', async () => {
    const question = 'Is my 3 BTC position safe to hold?';
    const net = recorder((url) =>
      url.pathname === '/api/context/briefings'
        ? new Response(JSON.stringify(CATALOG), { status: 200 })
        : new Response(readFileSync(join(BRIEFINGS, 'btc.pulse.json'), 'utf8'), {
            status: 200,
            headers: { 'x-prereason-tier': 'free', 'x-ratelimit-limit-day': '500', 'x-ratelimit-remaining-day': '466' },
          }),
    );
    const catalog = await fetchCatalog('0.1.0', { fetch: net.impl });
    const picked = pickBriefings(question, readableBy(catalog, 'free'));
    const client = new PreReasonClient({ key: fakeKey('a'), version: '0.1.0', fetch: net.impl });
    for (const id of picked.ids) await client.fetch({ briefing: id, format: 'json' });

    expect(net.seen.length).toBe(1 + picked.ids.length);
    for (const { url, headers } of net.seen) {
      expect(url.origin).toBe(BASE);
      expect(['/api/context', '/api/context/briefings']).toContain(url.pathname);
      for (const key of url.searchParams.keys()) expect(['briefing', 'format', 'date']).toContain(key);
      expect(Object.keys(headers).sort()).toEqual(
        url.pathname === '/api/context' ? ['Accept', 'Authorization', 'User-Agent', 'X-PreReason-Client'] : ['Accept', 'User-Agent', 'X-PreReason-Client'],
      );
      expect(headers['User-Agent']).toBe('primerkit/0.1.0');
      expect(headers['X-PreReason-Client']).toBe('primerkit');
      const sent = `${url.toString()} ${Object.values(headers).join(' ')}`.toLowerCase();
      for (const word of ['position', 'safe', 'hold', 'my 3']) expect(sent).not.toContain(word);
    }
    expect(client.budget).toEqual({ limit: 500, remaining: 466 });
    expect(client.tier).toBe('free');
  });

  it('turns a tier refusal into a plain sentence the session can show', async () => {
    const net = recorder(
      () =>
        new Response(JSON.stringify({ error: 'BRIEFING_RESTRICTED', message: "Briefing 'btc.full' requires pro tier" }), {
          status: 403,
        }),
    );
    const client = new PreReasonClient({ key: fakeKey('b'), version: '0.1.0', fetch: net.impl });
    const err = await client.fetch({ briefing: 'btc.full', format: 'json' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PreReasonError);
    expect((err as PreReasonError).tierRefusal).toBe(true);
    expect((err as PreReasonError).message).toBe("not available on this key's tier");
  });

  it('keeps the wait a rate limit asks for', async () => {
    const net = recorder(() => new Response(JSON.stringify({ code: 'RATE_LIMIT_EXCEEDED', message: 'Daily limit reached' }), { status: 429, headers: { 'retry-after': '120' } }));
    const client = new PreReasonClient({ key: fakeKey('c'), version: '0.1.0', fetch: net.impl });
    const err = (await client.fetch({ briefing: 'btc.pulse', format: 'json' }).catch((e: unknown) => e)) as PreReasonError;
    expect(err.status).toBe(429);
    expect(err.retryAfterSeconds).toBe(120);
  });

  it('takes the tier PreReason names on each answer, keeps it where one does not, and never reads it off the daily limit', async () => {
    const answers = [
      // A refusal names the tier too.
      new Response(JSON.stringify({ error: 'BRIEFING_RESTRICTED', message: 'requires pro' }), { status: 403, headers: { 'X-PreReason-Tier': 'Basic', 'x-ratelimit-limit-day': '2000', 'x-ratelimit-remaining-day': '1990' } }),
      new Response(readFileSync(join(BRIEFINGS, 'btc.pulse.json'), 'utf8'), { status: 200, headers: { 'x-prereason-tier': 'enterprise', 'x-ratelimit-limit-day': '100000', 'x-ratelimit-remaining-day': '99657' } }),
      // Served as free when PreReason could not read the plan: no header, and a limit of 500.
      new Response(readFileSync(join(BRIEFINGS, 'btc.pulse.json'), 'utf8'), { status: 200, headers: { 'x-ratelimit-limit-day': '500', 'x-ratelimit-remaining-day': '499' } }),
    ];
    const client = new PreReasonClient({ key: fakeKey('t'), version: '0.1.0', fetch: recorder(() => answers.shift()!).impl });
    expect(client.tier).toBeNull();
    await client.fetch({ briefing: 'btc.full', format: 'json' }).catch(() => null);
    expect(client.tier).toBe('basic');
    await client.fetch({ briefing: 'btc.pulse', format: 'json' });
    expect(client.tier).toBe('enterprise');
    await client.fetch({ briefing: 'btc.pulse', format: 'json' });
    expect(client.tier).toBe('enterprise');
    expect(client.budget).toEqual({ limit: 500, remaining: 499 });
    // CONTROL: a first answer without the header, whatever its limit, names no tier.
    const fresh = new PreReasonClient({ key: fakeKey('u'), version: '0.1.0', fetch: recorder(() => new Response('{}', { status: 200, headers: { 'x-ratelimit-limit-day': '500', 'x-ratelimit-remaining-day': '499' } })).impl });
    await fresh.fetch({ briefing: 'btc.pulse', format: 'json' });
    expect(fresh.tier).toBeNull();
    expect(tierOf(new Headers({ 'X-PreReason-Tier': 'platinum' }))).toBeNull();
    expect(tierOf(new Headers({ 'X-PreReason-Tier': ' PRO ' }))).toBe('pro');
  });
});

describe('the catalog', () => {
  const entries = parseCatalog(CATALOG);

  it('reads the live roster and cuts it to what a tier may read', () => {
    expect(entries.length).toBe(18);
    expect(readableBy(entries, 'free').map((b) => b.id)).toEqual([
      'btc.quick-check',
      'btc.context',
      'macro.snapshot',
      'cross.correlations',
      'btc.pulse',
      'btc.grid-stress',
    ]);
    expect(readableBy(entries, 'basic').length).toBe(12);
    expect(readableBy(entries, 'pro').length).toBe(18);
  });

  it('refuses an equities briefing even when the catalog lists one', () => {
    const withEquities = { briefings: [...(CATALOG as { briefings: object[] }).briefings, { id: 'equities.nvda', name: 'NVIDIA', description: '', tier: 'free' }] };
    expect(parseCatalog(withEquities).some((b) => b.id.startsWith('equities.'))).toBe(false);
  });

  it('says what the free briefings cover', () => {
    expect(coverage(readableBy(entries, 'free'))).toBe('Bitcoin, macro and correlations');
  });

  it('names the free briefing with the fewest metrics, the least a tier probe can read', () => {
    expect(smallestFree(entries)?.id).toBe('btc.quick-check');
    expect(entries.find((b) => b.id === 'macro.snapshot')?.metrics).toBe(15);
  });
});

describe('the key', () => {
  const home = mkdtempSync(join(tmpdir(), 'primerkit-key-'));

  it('takes PREREASON_API_KEY first, then the bridge credentials file', () => {
    const file = join(home, 'credentials.json');
    writeFileSync(file, JSON.stringify({ version: 1, api_key: fakeKey('f') }));
    const env = { PREREASON_CREDENTIALS_FILE: file };
    expect(resolveKey({ ...env, PREREASON_API_KEY: fakeKey('e') }, home)).toEqual({ key: fakeKey('e'), source: 'env' });
    expect(resolveKey(env, home)).toEqual({ key: fakeKey('f'), source: 'file' });
  });

  it('reads a malformed key, or none, as no key', () => {
    const file = join(home, 'bad.json');
    writeFileSync(file, JSON.stringify({ api_key: 'not-a-key' }));
    expect(resolveKey({ PREREASON_API_KEY: 'nope', PREREASON_CREDENTIALS_FILE: file }, home)).toBeNull();
    expect(resolveKey({ PREREASON_CREDENTIALS_FILE: join(home, 'missing.json') }, home)).toBeNull();
  });
});

describe('connecting through the bridge', () => {
  function fakeBridge(lines: string[], code: number) {
    const calls: Array<{ command: string; args: string[]; client: string | undefined }> = [];
    const spawn = (command: string, args: string[], env: Record<string, string | undefined>): ClaimProcess => {
      calls.push({ command, args, client: env.PREREASON_CLIENT });
      let onLine: (line: string) => void = () => {};
      return {
        onLine: (l) => {
          onLine = l;
        },
        onExit: (l) => {
          queueMicrotask(() => {
            for (const line of lines) onLine(line);
            l(code);
          });
        },
        kill: () => {},
      };
    };
    return { calls, spawn };
  }

  it('runs the bridge login as primerkit and reports the link, then the approval', async () => {
    const bridge = fakeBridge(
      [
        'PreReason: no API key found. Open https://www.prereason.com/claim/PR-ABCD-2345 to approve access (link expires in 15 min).',
        'PreReason: access approved. Key "Agent key" saved to /home/x/.prereason/credentials.json; get_context and get_metric work from the next call.',
      ],
      0,
    );
    const events: ClaimEvent[] = [];
    await new Promise<void>((done) => {
      connectPreReason(
        (e) => {
          events.push(e);
          if (e.kind === 'ended') done();
        },
        { env: {}, spawn: bridge.spawn },
      );
    });
    expect(bridge.calls).toEqual([{ command: 'npx', args: ['-y', '@prereason/mcp@^0.9.0', '--login'], client: 'primerkit' }]);
    expect(events[0]).toEqual({ kind: 'link', url: 'https://www.prereason.com/claim/PR-ABCD-2345' });
    expect(events.at(-1)).toMatchObject({ kind: 'ended', approved: true });
  });

  it('starts the bridge by its name, and on Windows through cmd.exe by its full path with the version range kept whole', () => {
    const args = ['-y', BRIDGE, '--login'];
    expect(BRIDGE).toBe('@prereason/mcp@^0.9.0');
    expect(claimLaunch('npx', args, 'linux', {})).toEqual({ command: 'npx', args, verbatim: false });
    expect(claimLaunch('npx', args, 'darwin', {})).toEqual({ command: 'npx', args, verbatim: false });
    expect(claimLaunch('npx', args, 'win32', { SystemRoot: 'C:\\Windows', ComSpec: 'C:\\elsewhere\\cmd.exe' })).toEqual({ command: join('C:\\Windows', 'System32', 'cmd.exe'), args: ['/d', '/s', '/c', '"npx -y "@prereason/mcp@^0.9.0" --login"'], verbatim: true });
  });

  it('reports a claim that was not granted', async () => {
    const bridge = fakeBridge(['PreReason: access was not granted (the link expired before it was approved).'], 1);
    const events: ClaimEvent[] = [];
    await new Promise<void>((done) => connectPreReason((e) => (events.push(e), e.kind === 'ended' && done()), { env: {}, spawn: bridge.spawn }));
    expect(events.at(-1)).toMatchObject({ kind: 'ended', approved: false, message: expect.stringContaining('not granted') });
  });

  // An old bridge in npx's cache has no --login: it starts its relay, finds no input and
  // exits 0 at once. That is not an approval.
  it('does not take a clean exit without a claim for an approval', async () => {
    const bridge = fakeBridge([], 0);
    const events: ClaimEvent[] = [];
    await new Promise<void>((done) => connectPreReason((e) => (events.push(e), e.kind === 'ended' && done()), { env: {}, spawn: bridge.spawn }));
    expect(events).toEqual([{ kind: 'ended', approved: false, message: 'the bridge ended without starting a claim (exit 0)' }]);
  });

  it('matches only a claim link', () => {
    expect(CLAIM_LINK.test('https://www.prereason.com/claim/PR-ABCD-2345')).toBe(true);
    expect(CLAIM_LINK.test('https://www.prereason.com/settings')).toBe(false);
  });

  // B15: on Windows the bridge runs under cmd.exe, and ending cmd.exe alone left the bridge
  // waiting, free to save a key after a quit.
  it('ends the whole tree on Windows, by taskkill, and the program alone elsewhere', () => {
    const child = (over: { exitCode?: number | null } = {}) => {
      const c = { pid: 4242, exitCode: null as number | null, signalCode: null, killed: 0, kill: () => ((c.killed += 1), true), ...over };
      return c;
    };
    const ran: string[][] = [];
    const run = (status: number | null) => (command: string, args: string[]) => (ran.push([command, ...args]), { status });
    const win = child();
    endTree(win, 'win32', { SystemRoot: 'C:\\Windows' }, run(0));
    expect(ran).toEqual([[join('C:\\Windows', 'System32', 'taskkill.exe'), '/pid', '4242', '/T', '/F']]);
    expect(win.killed).toBe(0);
    // taskkill could not end it: the program itself is ended still.
    const refused = child();
    endTree(refused, 'win32', { SystemRoot: 'C:\\Windows' }, run(1));
    expect(refused.killed).toBe(1);
    ran.length = 0;
    const posix = child();
    endTree(posix, 'linux', {}, run(0));
    expect(ran).toEqual([]);
    expect(posix.killed).toBe(1);
    // One that has ended already is left alone: its number may be another program's by now.
    const gone = child({ exitCode: 0 });
    endTree(gone, 'win32', { SystemRoot: 'C:\\Windows' }, run(0));
    expect(ran).toEqual([]);
    expect(gone.killed).toBe(0);
  });

  it('leaves nothing of the bridge running once the claim is cancelled, so no key is saved after a quit', async () => {
    // A stand in for the bridge, started the way the bridge is (through cmd.exe on Windows):
    // it prints a claim link, then saves a "key" a moment later, as the bridge does once the
    // link is approved. Test data: the link is not PreReason's.
    const dir = mkdtempSync(join(tmpdir(), 'pk-claim-'));
    const saved = join(dir, 'credentials.json');
    const script = join(dir, 'bridge.cjs');
    writeFileSync(script, "process.stderr.write('PreReason: Open https://claim.example/claim/PR-TEST-0000 to approve access.\\n');\nsetTimeout(() => require('node:fs').writeFileSync(process.argv[2], 'a key'), 2500);\n");
    const events: ClaimEvent[] = [];
    await new Promise<void>((done) => {
      const claim = connectPreReason(
        (e) => {
          events.push(e);
          if (e.kind === 'link') claim.cancel();
          if (e.kind === 'ended') done();
        },
        { env: process.env, spawn: (_command, _args, env) => spawnBridge(process.execPath, [script, saved], env) },
      );
    });
    expect(events[0]).toMatchObject({ kind: 'link' });
    // Past the moment the stand in would have saved its key.
    await new Promise((r) => setTimeout(r, 4000));
    expect(existsSync(saved)).toBe(false);
  }, 30_000);
});

describe('picking briefings for a local model', () => {
  const free = readableBy(parseCatalog(CATALOG), 'free');

  it('matches the question to titles and descriptions', () => {
    expect(pickBriefings('What is the Treasury yield curve doing?', free).ids).toEqual(['macro.snapshot']);
    expect(pickBriefings('Is the next difficulty adjustment up or down?', free).ids).toEqual(['btc.grid-stress']);
    expect(pickBriefings('How is Bitcoin moving with stocks and the dollar?', free).ids[0]).toBe('cross.correlations');
  });

  it('reads the briefings the question names, and beside them only the ones that match it closely', () => {
    const picked = pickBriefings('btc.pulse: what is dominance doing next to net liquidity?', free);
    expect(picked).toEqual({ ids: ['btc.pulse', 'btc.quick-check', 'macro.snapshot'], named: ['btc.pulse'], added: ['btc.quick-check', 'macro.snapshot'] });
    // One shared word is not close enough.
    expect(pickBriefings('btc.grid-stress: and what about liquidity?', free)).toEqual({ ids: ['btc.grid-stress'], named: ['btc.grid-stress'], added: [] });
  });

  it('matches no briefing on a span of time, and keeps a maturity', () => {
    // As the 10-12 storyboard asked it: two volatility metrics were read beside macro.snapshot
    // on "over" and "days", words that name no subject.
    const vol = [
      { id: 'macro.snapshot', name: 'Macro Snapshot', description: 'Fed balance sheet, Treasury yields and the dollar' },
      { id: 'btc-realized-vol-7d', name: 'BTC realized volatility, 7 days', description: 'Bitcoin realized volatility over the last 7 days' },
      { id: 'oil-wti-realized-vol-30d', name: 'WTI realized volatility, 30 days', description: 'Oil realized volatility over the past 30 days' },
    ];
    expect(pickBriefings('macro.snapshot: which series moved most over 7 days?', vol)).toEqual({ ids: ['macro.snapshot'], named: ['macro.snapshot'], added: [] });
    // A subject still joins: realized volatility named in the question reads both volatility
    // series, Bitcoin's first (three words shared against two).
    expect(pickBriefings('macro.snapshot: and how is bitcoin realized volatility?', vol).added).toEqual(['btc-realized-vol-7d', 'oil-wti-realized-vol-30d']);
    // A span of time is taken out whole, and the words of time alone name nothing.
    expect([...wordsOf('Which series rose over the last 7 days, or in the past 3 months?')]).toEqual(['series', 'rose']);
    expect([...wordsOf('What has the dollar done since last week, or a month ago?')]).toEqual(['dollar', 'done', 'week', 'month']);
    // A number with no such words is kept: "10 year" names a maturity.
    expect([...wordsOf('Where is the 10 year yield?')]).toEqual(['10', 'year', 'yield']);
  });

  it('reads a fact from its own series, one read for each fact, and a subject from the briefing that wires it', () => {
    // PreReason's own lines (10-12), shortened: four entries hold "net liquidity".
    const catalog = [
      { id: 'btc.quick-check', name: 'Quick Check', description: 'Quick directional read on Bitcoin price and net liquidity with their 30-day correlation' },
      { id: 'macro.snapshot', name: 'Macro Snapshot', description: 'Fed balance sheet, Treasury yields, dollar strength, and composite net liquidity' },
      { id: 'btc.momentum', name: 'BTC Momentum', description: 'Multi-timeframe BTC momentum, dollar strength and the net-liquidity backdrop' },
      { id: 'macro.liquidity', name: 'Liquidity Momentum', description: "One state of US dollar liquidity, from net liquidity's 30 day change, with its drivers" },
      { id: 'cross.correlations', name: 'Correlation Check', description: 'How Bitcoin correlates with equities, volatility, and the dollar' },
      { id: 'net-liquidity', name: 'Net Liquidity', description: 'Net liquidity proxy - Fed balance sheet minus reverse repo and Treasury account balances' },
      { id: 'treasury-10y', name: '10-Year Treasury Yield', description: 'The 10 year US Treasury constant maturity yield' },
    ];
    // As the storyboard asked it, which read the first three of the four (11,049 tokens): the
    // fact from its own series alone, and the briefing that holds its drivers named.
    expect(pickBriefings('Is net liquidity rising or falling this week?', catalog)).toEqual({ ids: ['net-liquidity'], named: [], added: [], drivers: 'macro.liquidity' });
    // Two facts: one read for each, each from its own series.
    expect(pickBriefings('Net liquidity and the 10 year yield?', catalog).ids).toEqual(['treasury-10y', 'net-liquidity']);
    // Subjects wired together: the one briefing that holds them all, and no pointer.
    expect(pickBriefings('How is Bitcoin moving with stocks and the dollar?', catalog)).toEqual({ ids: ['cross.correlations'], named: [], added: [] });
    // CONTROL: an entry that adds no subject is not read beside one that covers them.
    expect(pickBriefings('Is net liquidity rising or falling this week?', catalog).ids).not.toContain('btc.quick-check');
    // A word of time alone adds no read: a storyboard run once read a 26 week percentile
    // beside net liquidity on "this week". A number with it still counts ("10 year").
    const weekly = [...catalog, { id: 'cot-spx-noncomm-net-percentile-26w', name: 'S&P 500 Noncommercial Net, 26 Week Percentile', description: "Where this week's S&P 500 e-mini noncommercial net position ranks among the prior 26 weekly CFTC reports" }];
    expect(pickBriefings('Is net liquidity rising or falling this week?', weekly).ids).toEqual(['net-liquidity']);
    expect(pickBriefings('Where is the 10 year yield?', weekly).ids).toEqual(['treasury-10y']);
  });

  it('picks nothing when no word matches', () => {
    expect(pickBriefings('Tell me a joke', free).ids).toEqual([]);
  });
});

describe('the fixture connector', () => {
  it('answers from saved briefings like the live connector', async () => {
    const fixtures = new FixtureConnector(BRIEFINGS);
    const block = await fixtures.fetch({ briefing: 'btc.pulse', format: 'markdown' });
    expect(block.id).toBe('btc.pulse');
    expect(block.lines[0]).toBe('# BTC Pulse');
    await expect(fixtures.fetch({ briefing: 'equities.nvda', format: 'json' })).rejects.toThrow(RefusedRequest);
  });

  it("stamps each block with the time its folder's saved-at.txt holds, or the benchmark's morning where it holds none", async () => {
    const demo = join(here, '..', '..', '..', '..', 'operations', 'demo', 'briefings-2026-10-16');
    expect((await new FixtureConnector(demo).fetch({ briefing: 'macro.snapshot', format: 'json' })).fetchedAt).toBe('2026-10-16T09:28:56.000Z');
    expect((await new FixtureConnector(BRIEFINGS).fetch({ briefing: 'macro.snapshot', format: 'json' })).fetchedAt).toBe('2026-09-25T09:06:00.000Z');
  });
});

describe("Bitcoin's price history", () => {
  it("keeps each close's own source and its notice, and never the answer's one line for the whole series", async () => {
    const { PreReasonClient } = await import('../src/index');
    const answer = {
      source: 'Sample Exchange, Example Prices',
      attribution: 'Sources: Sample Exchange, Example Prices. Powered by Example Prices.',
      sources: [
        { name: 'Sample Exchange', points: 1, first_date: '2026-09-29', last_date: '2026-09-29' },
        { name: 'Example Prices', points: 1, first_date: '2026-09-28', last_date: '2026-09-28', notice: 'Powered by Example Prices.' },
      ],
      data: [
        { date: '2026-09-29', price: 84_100, source: 'Sample Exchange' },
        { date: '2026-09-28', price: 83_900, source: 'Example Prices' },
        { date: '2026-09-27', price: 83_500 },
        { date: '2026-09-26', price: 83_100, source: 'Unknown' },
      ],
    };
    const fake = (async () => new Response(JSON.stringify(answer), { status: 200 })) as typeof fetch;
    const client = new PreReasonClient({ key: 'pr_test_x', version: '0.1.0', fetch: fake });
    expect(await client.bitcoinHistory({ from: '2026-09-26', to: '2026-09-29' })).toEqual([
      // "Unknown" is what PreReason writes where a row names no source: no source is kept for it.
      { date: '2026-09-26', price: 83_100 },
      { date: '2026-09-27', price: 83_500 },
      { date: '2026-09-28', price: 83_900, source: 'Example Prices', notice: 'Powered by Example Prices.' },
      { date: '2026-09-29', price: 84_100, source: 'Sample Exchange' },
    ]);
  });

  it('reads a range of more than 1,000 days in parts, and asks for nothing before the first day', async () => {
    const day = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
    const asked: Array<{ from: string; to: string }> = [];
    // A server that keeps to its limit: the oldest rows of a range, up to the limit.
    const fake = (async (url: string) => {
      const q = new URL(url).searchParams;
      const from = q.get('from') as string;
      const to = q.get('to') as string;
      asked.push({ from, to });
      const data: Array<{ date: string; price: number }> = [];
      for (let d = from; d <= to && data.length < Number(q.get('limit')); d = day(d, 1)) data.push({ date: d, price: 1 });
      return new Response(JSON.stringify({ data }), { status: 200 });
    }) as typeof fetch;
    const client = new PreReasonClient({ key: 'pr_test_x', version: '0.1.0', fetch: fake });
    const points = await client.bitcoinHistory({ from: '2022-12-03', to: '2025-12-31' });
    expect(points).toHaveLength(1125);
    expect(new Set(points.map((p) => p.date)).size).toBe(1125);
    expect([points[0]?.date, points.at(-1)?.date]).toEqual(['2022-12-03', '2025-12-31']);
    expect(asked).toHaveLength(2);
    for (const a of asked) expect((Date.parse(a.to) - Date.parse(a.from)) / 86_400_000 + 1).toBeLessThanOrEqual(1000);
    // A range of 1,000 days is one call; one that starts before the history is asked from its first day.
    asked.length = 0;
    expect(await client.bitcoinHistory({ from: '2024-01-01', to: day('2024-01-01', 999) })).toHaveLength(1000);
    expect(asked).toHaveLength(1);
    asked.length = 0;
    expect((await client.bitcoinHistory({ from: '0001-01-01', to: '2013-05-01' })).map((p) => p.date)).toEqual(['2013-04-28', '2013-04-29', '2013-04-30', '2013-05-01']);
    expect(asked).toEqual([{ from: '2013-04-28', to: '2013-05-01' }]);
  });
});

describe('a metric on its own', () => {
  it('asks for JSON alone, and reads the level only from the sentence that states it', async () => {
    const { PreReasonClient, levelInSentence } = await import('../src/index');
    const seen: Array<Record<string, string>> = [];
    const fake = (async (_url: string, init?: RequestInit) => {
      seen.push(init?.headers as Record<string, string>);
      return new Response(JSON.stringify({ display_name: '3-Month Treasury Yield', timestamp: '2026-09-24T00:00:00+00:00', context: '3M Treasury yield at 4.24%; 7d +2.9% (rising)', trend: { change_30d: 9.84, change_unit: 'percent' } }), { status: 200 });
    }) as typeof fetch;
    const client = new PreReasonClient({ key: 'pr_test_x', version: '0.1.0', fetch: fake });
    const m = await client.metric('treasury-3mo');
    expect(seen[0]?.Accept).toBe('application/json');
    expect(m).toMatchObject({ name: 'treasury-3mo', display: '3-Month Treasury Yield', level: 4.24, trend: { change_30d: 9.84 } });
    expect(levelInSentence('Net liquidity at $5.77T; 7d -1.7%')).toBeNull();
    expect(levelInSentence('5Y Treasury yield at 5.03%; 7d +5.2%')).toBe(5.03);
    expect(levelInSentence('no level here')).toBeNull();
    await expect(client.metric('../x')).rejects.toThrow('is not a metric id');
  });

  it('keeps the value as the answer writes it, the source it names, and the answer as served', async () => {
    const { PreReasonClient, readingInSentence } = await import('../src/index');
    const served: Record<string, object> = {
      'etf-spy': { display_name: 'SPY (S&P 500 ETF)', timestamp: '2026-10-13T13:45:00.000Z', context: 'SPY at $671.20; 7d +1.2%.', trend: { change_7d: 1.2, change_unit: 'percent' }, source: 'Acme' },
      'cot-spx-noncomm-net': { context: 'S&P 500 e-mini non-commercial net position at -48,213 contracts; 7d +6,120.', source: 'Unknown' },
      // A key below the metric's tier: the latest reading alone, with no changes.
      'etf-gld': { display_name: 'GLD (Gold ETF)', timestamp: '2026-10-13T13:45:00.000Z', reading: '$377.80', source: 'Acme', access: { served: 'latest_reading' } },
    };
    const fake = (async (url: string) => new Response(JSON.stringify(served[new URL(url).pathname.split('/').pop()!]), { status: 200 })) as typeof fetch;
    const client = new PreReasonClient({ key: null, version: '0.1.0', fetch: fake });
    const spy = await client.metric('etf-spy');
    expect(spy).toMatchObject({ reading: '$671.20', source: 'Acme', level: null, trend: { change_7d: 1.2 } });
    expect(spy.readingOnly).toBeUndefined();
    expect(JSON.parse(spy.raw!)).toEqual(served['etf-spy']);
    // "Unknown" is no source.
    expect(await client.metric('cot-spx-noncomm-net')).toMatchObject({ reading: '-48,213 contracts', source: null });
    expect(await client.metric('etf-gld')).toMatchObject({ reading: '$377.80', readingOnly: true, trend: {} });
    expect(readingInSentence('S&P 500 e-mini noncommercial net position at percentile 61.5 of the prior 26 weekly reports (100 is the most net long); 7d +11.5.')).toBe(
      'percentile 61.5 of the prior 26 weekly reports (100 is the most net long)',
    );
    expect(readingInSentence('no value here; 7d +1%')).toBeNull();
  });

  it('keeps the notices the answer serves with the value, each as served, and none where it serves none', async () => {
    const { PreReasonClient } = await import('../src/index');
    const served: Record<string, object> = {
      'oil-wti': { context: 'WTI crude at $58.23/bbl; 7d -2.4%.', source: 'Sample', notices: ['Source: Sample Energy Office.'] },
      // A figure PreReason calculates: its own notice, then its publisher's, both kept.
      'cot-spx-noncomm-net-percentile-26w': {
        context: 'S&P 500 e-mini noncommercial net position at percentile 61.5 of the prior 26 weekly reports (100 is the most net long); 7d +11.5.',
        notices: ["PreReason's calculation from the Sample Positions Office Commitments of Traders.", 'Source: Sample Positions Office Commitments of Traders.'],
      },
      // Only text is a notice; a blank one, or one that is not text, is not.
      'etf-spy': { context: 'SPY at $671.20; 7d +1.2%.', notices: ['  Powered by Acme.  ', '', 42, null] },
      'etf-qqq': { context: 'QQQ at $598.41; 7d +2.0%.' },
      'etf-gld': { reading: '$377.80', access: { served: 'latest_reading' }, notices: [] },
    };
    const fake = (async (url: string) => new Response(JSON.stringify(served[new URL(url).pathname.split('/').pop()!]), { status: 200 })) as typeof fetch;
    const client = new PreReasonClient({ key: null, version: '0.1.0', fetch: fake });
    expect((await client.metric('oil-wti')).notices).toEqual(['Source: Sample Energy Office.']);
    expect((await client.metric('cot-spx-noncomm-net-percentile-26w')).notices).toEqual([
      "PreReason's calculation from the Sample Positions Office Commitments of Traders.",
      'Source: Sample Positions Office Commitments of Traders.',
    ]);
    expect((await client.metric('etf-spy')).notices).toEqual(['Powered by Acme.']);
    expect(await client.metric('etf-qqq')).not.toHaveProperty('notices');
    expect(await client.metric('etf-gld')).not.toHaveProperty('notices');
  });
});

describe('the ask gaps: metrics, one past day, the short note', () => {
  it('reads the keyless metric list as JSON, with no key, and keeps only metric ids', async () => {
    const { fetchMetricCatalog, parseMetricCatalog } = await import('../src/index');
    const { seen, impl } = recorder(() => new Response(JSON.stringify({ metrics: [{ name: 'treasury-10y', display_name: '10-Year Treasury Yield', description: 'The 10 year yield', category: 'macro' }, { name: '../x' }, { name: 'btc.pulse' }, { display_name: 'no id' }] }), { status: 200 }));
    expect(await fetchMetricCatalog('0.1.0', { base: BASE, fetch: impl })).toEqual([{ id: 'treasury-10y', name: '10-Year Treasury Yield', description: 'The 10 year yield', category: 'macro' }]);
    expect(seen[0]?.url.pathname).toBe('/api/metrics');
    expect(seen[0]?.headers.Accept).toBe('application/json');
    expect(seen[0]?.headers.Authorization).toBeUndefined();
    expect(parseMetricCatalog(null)).toEqual([]);
  });

  it("reads PreReason's marks for a futures, swap or options market from the catalogue, and only from it", async () => {
    const { derivativesMarks, parseMetricCatalog } = await import('../src/index');
    const metrics = parseMetricCatalog({
      metrics: [
        { name: 'cot-btc-net', display_name: 'COT BTC net', category: 'bitcoin', instrument: 'futures' },
        { name: 'okx-btc-funding', display_name: 'OKX funding', category: 'bitcoin', instrument: 'swap' },
        { name: 'deribit-btc-skew', display_name: 'Deribit skew', category: 'bitcoin', instrument: 'options' },
        { name: 'treasury-10y', display_name: '10Y', category: 'macro' },
        { name: 'etf-uup', display_name: 'UUP', category: 'macro', instrument: 'a fund' },
      ],
    });
    expect(metrics.map((m) => [m.id, m.instrument ?? null])).toEqual([['cot-btc-net', 'futures'], ['okx-btc-funding', 'swap'], ['deribit-btc-skew', 'options'], ['treasury-10y', null], ['etf-uup', null]]);
    const briefings = parseCatalog({
      briefings: [
        { id: 'btc.momentum', name: 'Momentum', tier: 'basic', derivatives: true },
        { id: 'macro.snapshot', name: 'Macro Snapshot', tier: 'free' },
        { id: 'btc.pulse', name: 'Pulse', tier: 'free', derivatives: 'yes' },
      ],
    });
    expect(briefings.map((b) => [b.id, b.derivatives ?? null])).toEqual([['btc.momentum', true], ['macro.snapshot', null], ['btc.pulse', null]]);
    const marks = derivativesMarks(briefings, metrics);
    expect([...marks.marked].sort()).toEqual(['btc.momentum', 'cot-btc-net', 'deribit-btc-skew', 'okx-btc-funding']);
    // Every id either list holds, marked or not, so an id neither lists is known as unlisted.
    expect([...marks.listed].sort()).toEqual(['btc.momentum', 'btc.pulse', 'cot-btc-net', 'deribit-btc-skew', 'etf-uup', 'macro.snapshot', 'okx-btc-funding', 'treasury-10y']);
    // The live catalogue's own fixture marks nothing yet, and nothing is marked by name.
    expect(derivativesMarks(parseCatalog(CATALOG), []).marked.size).toBe(0);
  });

  it('reads one metric as markdown lines, with the key, and refuses an id that is not one before any request', async () => {
    const { seen, impl } = recorder(() => new Response('# 10-Year Treasury Yield\n\n**Latest reading:** 4.12%\n', { status: 200 }));
    const client = new PreReasonClient({ key: fakeKey('a'), version: '0.1.0', base: BASE, fetch: impl });
    const block = await client.metricBlock('treasury-10y');
    expect(block).toMatchObject({ id: 'treasury-10y', format: 'markdown', lines: ['# 10-Year Treasury Yield', '**Latest reading:** 4.12%'] });
    expect(seen[0]?.url.pathname).toBe('/api/metrics/treasury-10y');
    expect(seen[0]?.headers.Accept).toBe('text/markdown');
    expect(seen[0]?.headers.Authorization).toMatch(/^Bearer pr_test_/);
    await expect(client.metricBlock('btc.pulse')).rejects.toThrow(RefusedRequest);
    await expect(client.metricBlock('../x')).rejects.toThrow('is not a metric id');
    expect(seen).toHaveLength(1);
    expect(client.readsDates).toBe(true);
  });

  it("keeps PreReason's own words, with the window, for a refused day; an early access metric is a tier refusal", async () => {
    const body = { error: 'DATE_RESTRICTED', message: "Date '2026-08-15' is outside your tier's access range", details: { tier_access: 'Free: the last 30 days' } };
    const { impl } = recorder((url) =>
      url.pathname.startsWith('/api/metrics/')
        ? new Response(JSON.stringify({ error: 'EARLY_ACCESS_RESTRICTED', message: 'early access' }), { status: 403 })
        : new Response(JSON.stringify(body), { status: 403 }),
    );
    const client = new PreReasonClient({ key: fakeKey('b'), version: '0.1.0', base: BASE, fetch: impl });
    const dated = await client.fetch({ briefing: 'macro.snapshot', format: 'json', date: '2026-08-15' }).catch((e: PreReasonError) => e);
    expect(dated).toMatchObject({ code: 'DATE_RESTRICTED', message: "Date '2026-08-15' is outside your tier's access range (Free: the last 30 days)", tierRefusal: true });
    const early = await client.metricBlock('treasury-10y').catch((e: PreReasonError) => e);
    expect(early).toMatchObject({ code: 'EARLY_ACCESS_RESTRICTED', message: "not available on this key's tier", tierRefusal: true });
  });

  it('reads only exact dates: ISO, and a month by its name with its day, with or without the year', async () => {
    const { daysIn, dayOfQuestion, checkedDay } = await import('../src/index');
    const today = '2026-10-03';
    expect(daysIn('as of 2026-08-15', today).days).toEqual(['2026-08-15']);
    expect(daysIn('on Aug 15, 2026 and on 15 August 2026', today).days).toEqual(['2026-08-15']);
    expect(daysIn('on August 15', today).days).toEqual(['2026-08-15']);
    expect(daysIn('on Dec 24', today).days).toEqual(['2025-12-24']);
    expect(daysIn('on May 5', today).days).toEqual(['2026-05-05']);
    expect(daysIn('it may 2x, or may 5 percent', today).days).toEqual([]);
    expect(daysIn('last Friday, yesterday, three days ago', today).days).toEqual([]);
    expect(daysIn('the 2026-08-15T00:00 print and 1990-01-01', today).days).toEqual(['2026-08-15', '1990-01-01']);
    expect(daysIn('2026-02-30', today)).toEqual({ days: [], periods: [], unreal: ['2026-02-30'], written: ['2026-02-30'] });
    expect(daysIn('Feb 29, 2028', today).days).toEqual(['2028-02-29']);
    expect(dayOfQuestion('no day here', today)).toEqual({ kind: 'none' });
    expect(dayOfQuestion('as of 2026-10-03', today)).toEqual({ kind: 'now' });
    expect(dayOfQuestion('as of 2026-08-15', today)).toEqual({ kind: 'day', day: '2026-08-15' });
    expect(dayOfQuestion('2026-08-01 to 2026-09-01', today, 'primerkit chart')).toMatchObject({ kind: 'refused', why: expect.stringContaining('primerkit chart draws a series') });
    expect(checkedDay('2026-10-04', today)).toMatchObject({ kind: 'refused', why: expect.stringContaining('has not come yet') });
    expect(checkedDay('last friday', today)).toMatchObject({ kind: 'refused', why: expect.stringContaining('is not a day on the calendar') });
  });

  it("takes a reporting period's dates as the period, never as a day to read on", async () => {
    const { daysIn, dayOfQuestion } = await import('../src/index');
    const today = '2026-10-12';
    // As the value check asked them: a period's end, and a period from its start to its end.
    expect(daysIn("What was Old Dominion's revenue for the quarter ended June 30, 2026?", today)).toMatchObject({ days: [], periods: ['2026-06-30'] });
    expect(daysIn('net sales for the first half of 2026 (the six months to June 30, 2026)?', today)).toMatchObject({ days: [], periods: ['2026-06-30'] });
    const nine = daysIn('profit for the nine months from April 1 to December 31, 2022, the transition period', today);
    expect(nine.days).toEqual([]);
    expect(nine.periods).toHaveLength(2);
    expect(nine.periods).toContain('2022-12-31');
    expect(daysIn('its 13-month fiscal period from January 1, 2023 to January 31, 2024?', today)).toMatchObject({ days: [], periods: ['2023-01-01', '2024-01-31'] });
    expect(daysIn('the fiscal year ending on 31 March 2026', today).periods).toEqual(['2026-03-31']);
    expect(dayOfQuestion('revenue for the quarter ended June 30, 2026', today)).toEqual({ kind: 'period', days: ['2026-06-30'] });
    // The date's words are still set aside, so they pick nothing.
    expect(daysIn('the quarter ended June 30, 2026', today).written).toEqual(['June 30, 2026']);
    // CONTROL: a day to read on stays one, "10 year" is no period, and two days with no
    // period between them are still refused as a span.
    expect(daysIn('net liquidity as of Aug 15, 2026', today)).toMatchObject({ days: ['2026-08-15'], periods: [] });
    expect(daysIn('the 10 year yield on Aug 15, 2026', today)).toMatchObject({ days: ['2026-08-15'], periods: [] });
    expect(daysIn("Wipro's shares at June 30, 2026", today)).toMatchObject({ days: ['2026-06-30'], periods: [] });
    expect(dayOfQuestion('from Aug 1 to Aug 15', today)).toMatchObject({ kind: 'refused' });
  });

  it('names an id only as a word of its own, metrics and briefings alike, and picks across both', () => {
    const entries = [
      { id: 'btc.pulse', name: 'BTC Pulse', description: 'Bitcoin price and dominance' },
      { id: 'gold', name: 'Gold', description: 'The gold price' },
      { id: 'treasury-10y', name: '10-Year Treasury Yield', description: 'The 10 year yield' },
    ];
    expect(pickBriefings('Is the golden cross near?', entries).named).toEqual([]);
    expect(pickBriefings('gold: and btc.pulse?', entries).named).toEqual(['gold', 'btc.pulse']);
    expect(pickBriefings('treasury-10y.', entries).named).toEqual(['treasury-10y']);
    expect(pickBriefings('Where is the 10 year treasury yield?', entries).ids[0]).toBe('treasury-10y');
  });

  it('finds the few nearest by words that begin alike, and none where none is near', async () => {
    const { closest } = await import('../src/index');
    const entries = parseCatalog(CATALOG);
    expect(closest('Liquidities?', entries).length).toBeGreaterThan(0);
    expect(closest('Liquidities?', entries).length).toBeLessThanOrEqual(5);
    expect(closest('What is a good pasta recipe?', entries)).toEqual([]);
  });
});

describe('a busy PreReason, and the catalog kept a few minutes', () => {
  it('names a 429 as PreReason asking to wait, with its own retry time, for the catalog and the list of metrics', async () => {
    const busy = recorder(() => new Response('{}', { status: 429, headers: { 'retry-after': '30' } }));
    const catalog = (await fetchCatalog('0.1.0', { fetch: busy.impl }).catch((error: unknown) => error)) as PreReasonError;
    expect(catalog).toBeInstanceOf(PreReasonError);
    expect([catalog.status, catalog.retryAfterSeconds]).toEqual([429, 30]);
    expect(catalog.message).toMatch(/PreReason asked primerkit to wait: its list of briefings/);
    const metrics = (await fetchMetricCatalog('0.1.0', { fetch: busy.impl }).catch((error: unknown) => error)) as PreReasonError;
    expect(metrics).toBeInstanceOf(PreReasonError);
    expect(metrics.message).toMatch(/its list of metrics/);
    const other = await fetchCatalog('0.1.0', { fetch: recorder(() => new Response('{}', { status: 503 })).impl }).catch((error: unknown) => error);
    expect(other).not.toBeInstanceOf(PreReasonError);
  });

  it('reads the catalog once for a burst of commands, again after five minutes, and keeps no failed read', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pk-kept-'));
    const file = join(dir, 'cache', 'catalog.json');
    let t = 1_000_000;
    let loads = 0;
    const load = async () => {
      loads += 1;
      return [{ id: 'btc.context', read: loads }];
    };
    expect(await keptFor(file, 5, load, () => t)).toEqual([{ id: 'btc.context', read: 1 }]);
    t += 4 * 60_000;
    expect(await keptFor(file, 5, load, () => t)).toEqual([{ id: 'btc.context', read: 1 }]);
    t += 2 * 60_000;
    expect(await keptFor(file, 5, load, () => t)).toEqual([{ id: 'btc.context', read: 2 }]);
    writeFileSync(file, 'not json');
    expect(await keptFor(file, 5, load, () => t)).toEqual([{ id: 'btc.context', read: 3 }]);
    writeFileSync(file, JSON.stringify({ at: t }));
    expect(await keptFor(file, 5, load, () => t)).toEqual([{ id: 'btc.context', read: 4 }]);
    await expect(keptFor(join(dir, 'cache', 'metrics.json'), 5, async () => { throw new Error('the list of metrics answered 503'); }, () => t)).rejects.toThrow(/503/);
    expect(await keptFor(join(dir, 'cache', 'metrics.json'), 5, load, () => t)).toEqual([{ id: 'btc.context', read: 5 }]);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('a list of ids a person reads', () => {
  it('shows the first eight of an area and counts the rest, or every one when asked', () => {
    const ids = Array.from({ length: 12 }, (_, i) => `m-${i + 1}`);
    expect(idsShown(ids)).toBe('m-1, m-2, m-3, m-4, m-5, m-6, m-7, m-8 and 4 more');
    expect(idsShown(ids, true)).toBe(ids.join(', '));
    expect(idsShown(ids.slice(0, 8))).toBe(ids.slice(0, 8).join(', '));
  });
});

describe('what a key would add', () => {
  it('names what plans above the key read, by area, the company family with them and no other equities briefing, and nothing when the key reads all', () => {
    const all = [
      ...parseCatalog(CATALOG),
      { id: 'equities.company', name: 'Company', description: 'one company', tier: 'basic' as const },
      { id: 'equities.screener', name: 'Screener', description: 'not read by primerkit', tier: 'basic' as const },
    ];
    expect(moreByArea(all, readableBy(all, 'free'))).toEqual({ count: 12, areas: 'Bitcoin 8, macro 1, cross asset 2, currencies 1', companies: true });
    expect(moreByArea(all, readableBy(all, 'basic'))?.count).toBe(6);
    expect(moreByArea(all, readableBy(all, 'pro'))).toBeNull();
  });
});

describe('company briefings', () => {
  const family = { id: 'equities.company', name: 'Company briefing', description: 'Request as equities.company/<company>.', tier: 'basic' as const };
  it('asks PreReason for a company by its code in the id, and for nothing else of the equities briefings', () => {
    const url = new URL(contextUrl(BASE, { briefing: 'equities.company/005930', format: 'json' }));
    expect(url.searchParams.get('briefing')).toBe('equities.company/005930');
    expect(() => contextUrl(BASE, { briefing: 'equities.company', format: 'json' })).toThrow(RefusedRequest);
    expect(() => contextUrl(BASE, { briefing: 'equities.company/my position', format: 'json' })).toThrow(/names no company/);
    expect(() => contextUrl(BASE, { briefing: 'equities.nvda', format: 'json' })).toThrow(/primerkit reads equities\.company\/<company> only/);
  });

  it('lists the family where the key reads it, as it is read, and picks the company a question names', () => {
    const all = [...parseCatalog(CATALOG), family];
    expect(readableBy(all, 'free').map((b) => b.id)).not.toContain('equities.company');
    expect(readableBy(all, 'basic').map((b) => b.id)).toContain('equities.company');
    expect(briefingsByArea(readableBy(all, 'basic')).find((a) => a.area === 'companies')?.ids).toEqual(['equities.company/<company>']);
    expect(pickBriefings('What did equities.company/NVDA report last quarter?', readableBy(all, 'basic')).named).toEqual(['equities.company/nvda']);
  });
});

describe('the company family in the catalog PreReason serves', () => {
  it('keeps the company family as the live catalog lists it, and drops every other equities briefing', () => {
    const body = JSON.parse(JSON.stringify(CATALOG)) as { briefings: unknown[] };
    body.briefings.push(
      { id: 'equities.company', name: 'Company briefing', description: 'Request as equities.company/<company>.', tier: 'basic', metrics_count: 0 },
      { id: 'equities.screener', name: 'Screener', description: 'not read by primerkit', tier: 'basic' },
    );
    const ids = parseCatalog(body).map((b) => b.id);
    expect(ids).toContain('equities.company');
    expect(ids).not.toContain('equities.screener');
    expect(readableBy(parseCatalog(body), 'pro').map((b) => b.id)).toContain('equities.company');
  });
});

describe('the company family alone', () => {
  // PreReason's own words for the family, as its live catalog served them on 2026-10-07.
  const family = {
    id: 'equities.company',
    name: 'Company briefing',
    description: 'A company briefing for one listed company: its latest reported figures, what changed, and how it is valued, each figure dated and sourced. Request as equities.company/<company>.',
    tier: 'basic' as const,
  };
  const entries = [{ id: 'btc.context', name: 'BTC Context', description: 'Bitcoin price and trend', tier: 'free' as const }, family];

  it('is never read by its words beside a company the question names, nor in place of one', () => {
    expect(pickBriefings('equities.company/nvda: what changed in the latest quarter?', entries).ids).toEqual(['equities.company/nvda']);
    expect(pickBriefings('What changed in the latest reported figures?', entries).ids).not.toContain('equities.company');
  });

  it('reads a company named at the end of a sentence, and both of two companies named', () => {
    expect(pickBriefings('Summarize equities.company/nvda.', entries).ids).toEqual(['equities.company/nvda']);
    expect(pickBriefings('Compare equities.company/nvda and equities.company/amd.', entries).ids).toEqual(['equities.company/nvda', 'equities.company/amd']);
    // The same company twice is read once.
    expect(pickBriefings('equities.company/nvda, then equities.company/nvda again', entries).ids).toEqual(['equities.company/nvda']);
  });

  it('adds nothing by words beside a company the question names', () => {
    // As the value check replay asked it (10-12): the words of the company's figures read a
    // Treasury holders briefing and two TIC metrics beside it.
    const near = [
      ...entries,
      { id: 'bonds.context', name: 'US Treasury Holders: Short Form', description: "Who holds Treasuries: foreign investors' net purchases and total holdings", tier: 'free' as const },
      { id: 'tic-net-foreign-purchases-long-term', name: 'TIC Net Foreign Purchases, Long Term', description: 'Net foreign purchases of long term US securities, with total holdings', tier: 'free' as const },
    ];
    expect(pickBriefings("equities.company/4927: What were POLA ORBIS HOLDINGS' net sales for the first half of 2026?", near)).toEqual({ ids: ['equities.company/4927'], named: ['equities.company/4927'], added: [] });
    // CONTROL: the same words with no company named still read what they match (the series
    // whose name holds them, which covers them all), and a briefing named with the company
    // is read beside it.
    expect(pickBriefings('What were total net holdings and purchases?', near).ids).toEqual(['tic-net-foreign-purchases-long-term']);
    expect(pickBriefings('equities.company/4927 and bonds.context: net sales and holdings?', near).ids).toEqual(['equities.company/4927', 'bonds.context']);
  });
});
