import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { Journal, Snapshots, loadOperation, readConfig, writeConfig, type ModelAdapter } from '@primerkit/core';
import { FixtureConnector, parseCatalog } from '@primerkit/connector-prereason';
import { maker, lineChart, type Line } from '@primerkit/ui';
import { ASK_DIR, BENCH_BRIEFINGS, DEMO_CATALOG, DIGEST_DIR, Session, runInTerminal, screen, toKey, type Key, type SessionDeps } from '../src/index';

// The session's edges, found reading the code (2026-10-09).
const text = (lines: Line[]): string => lines.map((l) => l.map(([, s]) => s).join('')).join('\n');
const shown = (s: Session): string => text(screen(s.state, true));
const press = (s: Session, ...keys: Key[]): void => keys.forEach((k) => s.key(k));
const typed = (t: string): Key[] => Array.from(t).map((char) => ({ name: 'char', char }));
const enter: Key = { name: 'enter' };
const down: Key = { name: 'down' };

const labelled = (label: string): ModelAdapter => ({
  id: label,
  label,
  capabilities: async () => ({ local: true, schemaConstraint: false, contextTokens: null, canRaiseContext: false, format: 'markdown' }),
  complete: async () => ({ text: '{}' }),
});

function deps(over: Partial<SessionDeps> = {}): SessionDeps & { home: string } {
  const home = mkdtempSync(join(tmpdir(), 'pk-round8-'));
  return {
    demo: null,
    env: {},
    platform: 'linux',
    config: { read: () => readConfig(home), write: (c) => writeConfig(home, c) },
    checkMachine: async () => ({ apps: [], keys: [], local: [], ollama: 'not running' }),
    catalog: async () => parseCatalog(JSON.parse(readFileSync(DEMO_CATALOG, 'utf8'))),
    resolveKey: () => ({ key: `pr_test_${'k'.repeat(20)}`, source: 'env' }),
    connect: () => ({ cancel: () => {} }),
    briefings: () => new FixtureConnector(BENCH_BRIEFINGS),
    model: (choice) => labelled(choice.kind === 'model' ? choice.spec.name : 'demo'),
    listModels: async () => [],
    pull: async (_name, onProgress) => onProgress({ status: 'success' }),
    fitness: async () => {
      throw new Error('not in these tests');
    },
    fitnessPlan: () => ({ calls: 5, tokens: 12_345 }),
    operation: loadOperation(ASK_DIR),
    digestOperation: loadOperation(DIGEST_DIR),
    journal: new Journal(join(home, 'journal')),
    snapshots: new Snapshots(join(home, 'snapshots')),
    latestDigest: () => null,
    journalRows: () => [],
    journalOpen: () => ({ title: '', text: '' }),
    openLink: () => true,
    copy: () => true,
    ...over,
    home,
  } as SessionDeps & { home: string };
}

function started(over: Partial<SessionDeps> = {}, model: object = { kind: 'ollama', base_url: 'http://127.0.0.1:11434', name: 'qwen2.5:7b' }) {
  const d = deps(over);
  writeConfig(d.home, { disclaimer_accepted_at: 'x', first_run_done_at: 'x', model, prereason: { tier: 'free' } } as ReturnType<typeof readConfig>);
  const s = new Session(d);
  s.start();
  return { s, d };
}

describe('the session at its edges', () => {
  it('chooses the model again, and says why, where the kept one cannot be used here', () => {
    const { s } = started({
      model: () => {
        throw new Error('ANTHROPIC_API_KEY is not set');
      },
    }, { kind: 'hosted', provider: 'anthropic', name: 'claude-test' });
    expect(s.state.step.name).toBe('model');
    expect(s.state.notice).toBe('claude-test cannot be used: ANTHROPIC_API_KEY is not set. Choose a model, or set its key and start again.');
    // Read again (2026-10-09): the key is taken up all the same, and the reason is still
    // there once the machine check has drawn the picker anew.
    expect(s.state.connected).toBe(true);
  });

  it('keeps the reason on the picker once the machine check has drawn it anew', async () => {
    const { s } = started({
      checkMachine: async () => ({ apps: [], keys: [], local: [{ runtime: 'ollama', baseUrl: 'http://127.0.0.1:11434', name: 'qwen2.5:7b' }], ollama: 'running' }),
      model: () => {
        throw new Error('ANTHROPIC_API_KEY is not set');
      },
    }, { kind: 'hosted', provider: 'anthropic', name: 'claude-test' });
    await s.idle();
    expect(s.state.step).toMatchObject({ name: 'model', check: { ollama: 'running' } });
    expect(s.state.notice).toMatch(/^claude-test cannot be used/);
    expect(shown(s)).toContain('claude-test cannot be used');
  });

  it('gives the terminal back before a failure is said, so it can be read', async () => {
    const setRawMode = vi.fn();
    const input = Object.assign(new PassThrough(), { isTTY: true, setRawMode }) as unknown as NodeJS.ReadStream;
    const written: string[] = [];
    const output = { write: (chunk: string) => (written.push(chunk), true), on: () => output, off: () => output } as unknown as NodeJS.WriteStream;
    const s = new Session(deps());
    s.start = () => {
      throw new Error('it stopped');
    };
    await expect(runInTerminal(s, 'plain', true, input, output)).rejects.toThrow('it stopped');
    expect(setRawMode.mock.calls.at(-1)).toEqual([false]);
    expect(written.at(-1)).toBe('\x1b[?25h\x1b[?1049l');
    // Nothing is drawn after that, over what was said.
    s.resize(100, 30);
    expect(written.at(-1)).toBe('\x1b[?25h\x1b[?1049l');
  });

  it('scrolls an opened run to its last wrapped line', () => {
    const long = `${Array.from({ length: 400 }, (_, i) => `word${i}`).join(' ')} END`;
    const row = { day: '9 Oct', time: '08:00', operation: 'ask', title: 'a long answer', outcome: 'passed', dir: 'x' };
    const { s } = started({ journalRows: () => [row], journalOpen: () => ({ title: 'ask, x', text: long }) });
    press(s, ...typed('/journal'), enter, enter);
    expect(shown(s)).not.toContain('END');
    for (let i = 0; i < 200; i += 1) press(s, down);
    expect(shown(s)).toContain('END');
    // No press is spent past the end: one up shows a line before the last again.
    press(s, { name: 'up' });
    expect(shown(s)).not.toContain('END');
  });

  it('stops /catalog on Ctrl+C, as its running line says', async () => {
    const { s } = started({ catalog: () => new Promise(() => {}) });
    press(s, ...typed('/catalog'), enter);
    expect(s.state.feed.some((e) => e.kind === 'running')).toBe(true);
    press(s, { name: 'ctrl-c' });
    await vi.waitFor(() => expect(s.state.notice).toBe('Stopped.'));
    expect(s.state.feed.some((e) => e.kind === 'running')).toBe(false);
  });

  it('goes back home from /connect prereason in a later session, not into the first run', () => {
    const { s } = started({ resolveKey: () => null });
    press(s, ...typed('/connect prereason'), enter);
    expect(s.state.step.name).toBe('connect');
    press(s, { name: 'escape' });
    expect(s.state.step.name).toBe('home');
  });

  it('takes an emoji typed, and takes it out whole on backspace', () => {
    expect(toKey('😀', { name: undefined, sequence: '😀' } as never)).toEqual({ name: 'char', char: '😀' });
    const { s } = started();
    press(s, ...typed('hi 😀'));
    expect(s.state.input).toBe('hi 😀');
    press(s, { name: 'backspace' });
    expect(s.state.input).toBe('hi ');
  });
});

describe('a line chart at its edges', () => {
  const base = { points: [], width: 20, height: 5, xRange: [0, 2] as [number, number], yLabel: (v: number) => v.toFixed(0), xTicks: [], plain: true };
  it('leaves out a point that is not a number, and draws a chart with none on a plain scale', () => {
    const drawn = lineChart(maker(true), { ...base, series: [{ points: [[0, 1], [1, Number.NaN], [2, 3]], style: 'main' }] });
    expect(drawn.length).toBeGreaterThan(0);
    expect(text(drawn)).not.toContain('NaN');
    expect(text(lineChart(maker(true), { ...base, series: [{ points: [], style: 'main' }] }))).not.toContain('NaN');
  });
});
