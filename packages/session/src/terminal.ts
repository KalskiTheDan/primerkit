import { emitKeypressEvents } from 'node:readline';
import { maker, renderLine, type ColorMode, type Line } from '@primerkit/ui';
import { wrapIn } from './fit';
import { screen } from './screens';
import type { Session } from './session';
import { MIN_SIZE, type Key } from './state';

interface KeyInfo {
  name?: string;
  ctrl?: boolean;
  meta?: boolean;
  sequence?: string;
}

export function toKey(str: string | undefined, key: KeyInfo | undefined): Key | null {
  if (key?.ctrl && key.name === 'c') return { name: 'ctrl-c' };
  if (key?.ctrl && key.name === 'd') return { name: 'ctrl-d' };
  // readline reports a lone Esc with meta set, having waited to see whether it starts a
  // longer sequence, so Esc is read before a key held with Alt or Ctrl is set aside.
  if (key?.name === 'escape') return { name: 'escape' };
  if (key?.ctrl || key?.meta) return null;
  switch (key?.name) {
    case 'return':
    case 'enter':
      return { name: 'enter' };
    case 'up':
      return { name: 'up' };
    case 'down':
      return { name: 'down' };
    case 'left':
      return { name: 'left' };
    case 'right':
      return { name: 'right' };
    case 'backspace':
      return { name: 'backspace' };
    case 'tab':
      return { name: 'tab' };
  }
  // One character, which an emoji is though it takes two UTF-16 units.
  if (str && Array.from(str).length === 1 && str >= ' ' && str !== '\x7f') return { name: 'char', char: str };
  return null;
}

// The session is drawn in the window's size, down to MIN_SIZE. In a smaller window its
// lines would wrap and scroll into each other, so one message says so instead, and the
// session is drawn again as soon as the window is large enough. Null when it fits.
export const SESSION_COLUMNS = MIN_SIZE.width + 1; // the smallest width, and the last column left empty
export function tooSmall(columns: number, rows: number, ascii: boolean): Line[] | null {
  if (columns >= SESSION_COLUMNS && rows >= MIN_SIZE.height) return null;
  const t = maker(ascii);
  const width = Math.max(12, columns - 2);
  const para = (role: string, text: string): Line[] => wrapIn(t, role, text, width).map((l): Line => [t(role, ' '), ...l]);
  return [
    [],
    ...para('fg', `primerkit needs a window at least ${SESSION_COLUMNS} columns wide and ${MIN_SIZE.height} rows tall, and this one is ${columns} by ${rows}.`),
    [],
    ...para('muted', 'Make it larger and the session comes back as it was. primerkit ask, brief and chart print once, and fit any window.'),
    [],
    ...para('dim', 'Ctrl+D leaves.'),
  ];
}

// Draws the session in the terminal's alternate screen and feeds it keys. The
// screens are drawn whole, at most ten times a second while something runs. `signals`
// is the process, whose SIGHUP says the window was closed.
export function runInTerminal(session: Session, mode: ColorMode, ascii: boolean, input: NodeJS.ReadStream = process.stdin, output: NodeJS.WriteStream = process.stdout, signals: NodeJS.EventEmitter = process): Promise<void> {
  const plain = ascii || mode === 'plain';
  let last = '';
  // The session draws in the window's size; a terminal that does not say its size is
  // taken to have the grid's.
  const sized = (): void => {
    if (output.columns && output.rows) session.resize(output.columns, output.rows);
  };
  const draw = (): void => {
    const small = output.columns && output.rows ? tooSmall(output.columns, output.rows, plain) : null;
    const frame = (small ?? screen(session.state, plain))
      .map((line) => `${renderLine(line, mode)}\x1b[K`)
      .join('\r\n');
    if (frame === last) return;
    last = frame;
    output.write(`\x1b[H${frame}\x1b[J`);
  };

  return new Promise((resolve, reject) => {
    // Anything that throws while the session runs gives the terminal back first (its own
    // screen, the cursor, cooked mode), so the message that follows can be read.
    const guarded = (run: () => void): void => {
      try {
        run();
      } catch (error) {
        finish(error ?? new Error('the session stopped'));
      }
    };
    const onKey = (str: string | undefined, key: KeyInfo | undefined): void => {
      const k = toKey(str, key);
      if (k) guarded(() => session.key(k));
    };
    const onResize = (): void => {
      last = '';
      sized();
      draw();
    };
    // A window closed under the session (SIGHUP, which Windows sends too as its console
    // closes) leaves as Ctrl+D does, so what the session started ends with it: the
    // PreReason bridge cannot then save a key after the person has gone.
    const onHangup = (): void => guarded(() => session.quit());
    const timer = setInterval(() => session.tick(), 100);
    let finished = false;
    const finish = (error?: unknown): void => {
      if (finished) return;
      finished = true;
      clearInterval(timer);
      input.off('keypress', onKey);
      output.off('resize', onResize);
      signals.off('SIGHUP', onHangup);
      if (input.isTTY) input.setRawMode(false);
      input.pause();
      output.write('\x1b[?25h\x1b[?1049l'); // show the cursor, leave the alternate screen
      if (error === undefined) resolve();
      else reject(error);
    };
    emitKeypressEvents(input);
    if (input.isTTY) input.setRawMode(true);
    input.resume();
    output.write('\x1b[?1049h\x1b[?25l'); // the alternate screen, cursor hidden
    input.on('keypress', onKey);
    output.on('resize', onResize);
    signals.once('SIGHUP', onHangup);
    // Once the terminal is given back, nothing more is drawn: work still running in the
    // background would draw over what was said.
    session.onChange(() => (finished ? undefined : session.state.done ? finish() : draw()));
    guarded(() => {
      sized();
      session.start();
      draw();
    });
  });
}
