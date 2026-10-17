import { describe, expect, it } from 'vitest';
import type { MachineCheck } from '@primerkit/models';
import { widthOf, type Line } from '@primerkit/ui';
import { DEMO_DATE, FIRST_QUESTIONS, FIRST_RUN_WALK, FUNCTIONS, NO_ADVICE, ONBOARDING, Session, demoDeps, functionOf, screen, statusParts, titleOf, walk, type Key, type SessionDeps } from '../src/index';

const MACHINE: MachineCheck = { apps: ['Claude Code'], keys: [], local: [{ runtime: 'ollama', baseUrl: 'http://127.0.0.1:11434', name: 'qwen2.5:7b' }], ollama: 'running' };
const demo = (): SessionDeps => ({ ...demoDeps({ version: '0.1.0' }), checkMachine: async () => MACHINE });
const text = (lines: Line[]): string => lines.map((l) => l.map(([, s]) => s).join('')).join('\n');
const typed = (words: string): Key[] => Array.from(words, (char): Key => ({ name: 'char', char }));
const enter: Key = { name: 'enter' };
const tab: Key = { name: 'tab' };
const esc: Key = { name: 'escape' };

// The demo walked through its first run to home.
async function home(window?: { columns: number; rows: number }): Promise<Session> {
  const s = new Session(demo());
  if (window) s.resize(window.columns, window.rows);
  s.start();
  for (const step of FIRST_RUN_WALK.slice(0, 9)) {
    for (const k of step.keys) s.key(k);
    await s.idle();
  }
  expect(s.state.step.name).toBe('home');
  return s;
}

describe('the panel on every screen', () => {
  it('heads each screen with a title bar and ends it with the status strip, in every window', async () => {
    for (const [columns, rows] of [[49, 16], [77, 22], [121, 36]] as const) {
      for (const shot of await walk(demo(), FIRST_RUN_WALK, true, { columns, rows })) {
        const first = text([shot.lines[0]!]);
        const last = text([shot.lines.at(-1)!]);
        expect(first, `${columns}x${rows} ${shot.title}`).toMatch(/^\[(PRIMERKIT|SETUP|ASK)\] /);
        expect(last, `${columns}x${rows} ${shot.title}`).toMatch(/^ model /);
        // The bars run across the panel: the grid's 76, or the window's width above 100 columns.
        const band = columns - 1 >= 100 ? columns - 1 : Math.min(76, columns - 1);
        expect(widthOf(shot.lines[0]!)).toBe(band);
        expect(widthOf(shot.lines.at(-1)!)).toBe(band);
      }
    }
  }, 60_000);

  it('names each setup step in its title bar, and the demo on the right', async () => {
    const shots = await walk(demo(), FIRST_RUN_WALK, true);
    const titles = shots.map((s) => text([s.lines[0]!]).trimEnd());
    expect(titles[0]).toMatch(/^\[PRIMERKIT\] before you start +demo \| nothing is sent or kept$/);
    expect(titles[1]).toMatch(new RegExp(`^\\[SETUP\\] Model \\| step 1 of 4 +demo \\| saved ${DEMO_DATE}$`));
    expect(titles[2]).toMatch(/^\[SETUP\] PreReason \| step 2 of 4 /);
    expect(titles[3]).toMatch(/^\[SETUP\] First question \| step 3 of 4 /);
    expect(titles[6]).toMatch(/^\[SETUP\] Digest \| step 4 of 4 /);
  });

  it('shows each setup step as what you do and what the agent does', async () => {
    const shots = await walk(demo(), FIRST_RUN_WALK, true);
    const words = (i: number) => text(shots[i]!.lines).replace(/\s+/g, ' ');
    expect(words(1)).toContain(`YOU DO ${ONBOARDING[0]!.you}`);
    expect(words(1)).toContain(`AGENT DOES ${ONBOARDING[0]!.agent}`);
    expect(words(2)).toContain(`YOU DO ${ONBOARDING[1]!.you}`);
    expect(words(3)).toContain(`AGENT DOES ${ONBOARDING[2]!.agent}`);
    // The welcome keeps every point agreed to, the no-advice point among them.
    expect(words(0)).toContain('Nothing here is investment advice.');
  });

  it('keeps the model, PreReason, the data day and the tokens read in the status strip', async () => {
    const s = await home();
    // The demo's stand in runs on this machine, so its run records a cost of nothing.
    expect(statusParts(s.state)).toEqual([['model', 'demo'], ['PreReason', 'saved briefings'], ['data', DEMO_DATE], ['tokens', expect.stringMatching(/^\d[\d,]*$/)], ['cost', '$0.00']]);
    expect(titleOf(s.state)).toEqual({ code: 'ASK', subject: FIRST_QUESTIONS[0]!.question, right: `demo · saved ${DEMO_DATE}` });
  });
});

describe('the launchpad', () => {
  it('lists the connections, the no-advice line and every function by its code, beside the mini PK', async () => {
    const s = await home({ columns: 101, rows: 36 });
    s.key({ name: 'char', char: '/' });
    for (const k of [...typed('clear'), esc, enter]) s.key(k);
    expect(s.state.feed).toEqual([]);
    const colour = screen(s.state, false);
    expect(colour.filter((l) => l.some(([role]) => role.startsWith('pk'))).length).toBe(6);
    const out = text(screen(s.state, true));
    expect(out).toMatch(/^\[PRIMERKIT\] launchpad /);
    expect(out).toContain('CONNECTIONS');
    expect(out).toMatch(/\* model +demo, no model/);
    expect(out).toMatch(new RegExp(`\\* PreReason +briefings saved on ${DEMO_DATE}`));
    expect(out).toMatch(/\. brokers +off until you turn one on: \/connect/);
    expect(out).toContain(NO_ADVICE);
    for (const f of FUNCTIONS) expect(out).toMatch(new RegExp(`${f.code} +\\${f.command} +${f.about}`));
    // Green and red stay for a change the data states: a connection that is on is sandstone.
    expect(colour.flat().some(([role, s]) => role === 'up' && s.includes('●'))).toBe(false);
  });

  it('runs a function by its code, in either case, and puts one that takes more in the input', async () => {
    const s = await home();
    for (const k of [...typed('ct'), enter]) s.key(k);
    await s.idle();
    expect(s.state.feed.at(-1)).toMatchObject({ kind: 'catalog', question: '/catalog' });
    for (const k of [...typed('BR'), enter]) s.key(k);
    expect(s.state.input).toBe('/brief ');
    expect(functionOf(' md ')?.command).toBe('/model');
    // CONTROL: a question that is not a code is asked.
    expect(functionOf('dgx')).toBeNull();
  });
});

describe('switching the model', () => {
  it('opens the picker with one key from home, Tab on an empty input, and goes back with Esc', async () => {
    const s = await home();
    s.key(tab);
    await s.idle();
    expect(s.state.step.name).toBe('model');
    const out = text(screen(s.state, true));
    expect(out).toMatch(/^\[MODEL\] switch the model /);
    expect(out).toContain('Esc goes back');
    s.key(esc);
    expect(s.state.step.name).toBe('home');
    // CONTROL: with something typed, Tab completes it and opens no picker.
    for (const k of [...typed('/dig'), tab]) s.key(k);
    expect(s.state.step.name).toBe('home');
    expect(s.state.input).toBe('/digest');
  });

  it('opens the picker on /model, where it once showed a notice', async () => {
    const s = await home();
    for (const k of [...typed('/model'), esc, enter]) s.key(k);
    await s.idle();
    expect(s.state.step.name).toBe('model');
    expect(s.state.notice).toBeNull();
  });
});

describe('the wide launchpad', () => {
  it('shows the newest runs the journal holds under the functions, in a window 101 columns or wider', async () => {
    const rows = [
      { day: '16 Oct', time: '09:41', operation: 'ask', title: 'What is the Treasury yield curve doing?', outcome: '', dir: 'a' },
      { day: '16 Oct', time: '08:00', operation: 'digest', title: '2 changes since your last digest', outcome: '', dir: 'b' },
    ];
    const s = new Session({ ...demo(), journalRows: () => rows });
    s.resize(121, 40);
    s.start();
    for (const step of FIRST_RUN_WALK.slice(0, 9)) {
      for (const k of step.keys) s.key(k);
      await s.idle();
    }
    for (const k of [...typed('/clear'), esc, enter]) s.key(k);
    // The demo's own first run reads no journal; a later start does, as here.
    s.state.recent = rows;
    const out = text(screen(s.state, true));
    expect(out).toContain('RECENT RUNS  JR /journal opens them');
    expect(out).toMatch(/16 Oct 09:41 +ask +What is the Treasury yield curve doing\?/);
    expect(out).toMatch(/16 Oct 08:00 +digest +2 changes since your last digest/);
    for (const line of screen(s.state, false)) expect(widthOf(line)).toBeLessThanOrEqual(120);
    // CONTROL: on the grid's 76 columns the panel is left out.
    s.resize(77, 40);
    expect(text(screen(s.state, true))).not.toContain('RECENT RUNS');
  });
});

describe('the cost in the status strip', () => {
  it('shows the cost when every answer on screen recorded one, and nothing where any did not', async () => {
    const s = await home();
    const found = s.state.feed.find((e) => e.kind === 'answer');
    if (!found || found.kind !== 'answer') throw new Error('no answer');
    // The demo's stand in runs on this machine: its run records a cost of nothing.
    expect(found.cost).toBe(0);
    expect(statusParts(s.state)).toContainEqual(['cost', '$0.00']);
    const { cost: _kept, ...answer } = found;
    const costed = { ...s.state, feed: [{ ...answer!, cost: 0.0123 }] as typeof s.state.feed };
    expect(statusParts(costed)).toContainEqual(['cost', '$0.01']);
    const small = { ...s.state, feed: [{ ...answer!, cost: 0.0004 }] as typeof s.state.feed };
    expect(statusParts(small)).toContainEqual(['cost', '$0.0004']);
    // CONTROL: one answer without a cost leaves the sum unsaid.
    const mixed = { ...s.state, feed: [{ ...answer!, cost: 0.02 }, answer!] as typeof s.state.feed };
    expect(statusParts(mixed).map(([label]) => label)).not.toContain('cost');
  });
});
