import type { Line } from '@primerkit/ui';
import { screen } from './screens';
import { Session, type SessionDeps } from './session';
import type { Key } from './state';

// The first run walked with keys, screen by screen: the demo's --walk and the tests
// use it. After each key the walk waits for the work the key started, except where a
// step asks to see the screen while the work runs.

export interface WalkStep {
  title: string;
  keys: Key[];
  wait?: boolean; // default true
}

const enter: Key = { name: 'enter' };
const type = (text: string): Key[] => Array.from(text, (char): Key => ({ name: 'char', char }));

export const FIRST_RUN_WALK: WalkStep[] = [
  { title: '1. Welcome', keys: [] },
  { title: '2. Step 1: where the model runs', keys: [enter] },
  { title: '4. Step 2: connect PreReason', keys: [enter] },
  { title: '5. Step 3: the first question', keys: [enter] },
  { title: 'Step 3 while the answer runs', keys: [enter], wait: false },
  { title: '6. Step 3: the answer arrives', keys: [] },
  { title: '7. Step 4: a morning digest', keys: [enter] },
  { title: '8. Step 4: the entry, before it is added', keys: [enter] },
  { title: '9. Home', keys: [enter] },
  { title: '10. A question while it runs', keys: [...type('Is net liquidity rising or falling?'), enter], wait: false },
  { title: '11. The same question, answered', keys: [] },
];

export interface WalkedScreen {
  title: string;
  lines: Line[];
}

// Walked in a terminal window `columns` by `rows` where one is given, and on the grid
// where none is.
export async function walk(deps: SessionDeps, steps: WalkStep[], plain: boolean, window?: { columns: number; rows: number }): Promise<WalkedScreen[]> {
  const session = new Session(deps);
  if (window) session.resize(window.columns, window.rows);
  session.start();
  const out: WalkedScreen[] = [];
  for (const step of steps) {
    for (const k of step.keys) session.key(k);
    if (step.wait !== false) await session.idle();
    out.push({ title: step.title, lines: screen(session.state, plain) });
  }
  await session.idle();
  return out;
}
