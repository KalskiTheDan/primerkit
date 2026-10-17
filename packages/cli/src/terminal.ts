import { createInterface } from 'node:readline';
import { Writable } from 'node:stream';

// A person is at a terminal only when the input and the output both are one: a pipe or a
// file on either side can answer a question, or hide it. This is the test a pipe cannot
// pass. A program that makes a terminal of its own and types into it still can, and no
// check made from inside can tell that from a person.
export interface Streams {
  stdin: { isTTY?: boolean };
  stdout: { isTTY?: boolean };
}

export const isTerminal = (streams: Streams = process): boolean => Boolean(streams.stdin.isTTY) && Boolean(streams.stdout.isTTY);

// A line of primerkit doctor: ok, x for what needs fixing, - for a step that is yours to
// take or leave, such as the digest's schedule.
export const doctorLine = (ok: boolean | null, text: string): string => `${ok === null ? '- ' : ok ? 'ok' : 'x '} ${text}`;

// Whether a runtime's model list names a model: Ollama's /api/tags or an OpenAI-compatible
// server's /models, by the whole name (qwen2.5:7b is not qwen2.5:7b-instruct), with
// Ollama's ":latest" read as the name without it.
export function runtimeLists(body: string, name: string): boolean {
  let names: string[];
  try {
    const parsed = JSON.parse(body) as { models?: Array<{ name?: unknown; model?: unknown }>; data?: Array<{ id?: unknown }> };
    names = [...(parsed.models ?? []).flatMap((m) => [m.name, m.model]), ...(parsed.data ?? []).map((m) => m.id)].filter((n): n is string => typeof n === 'string');
  } catch {
    return false;
  }
  const bare = (n: string) => n.replace(/:latest$/, '');
  return names.some((n) => bare(n) === bare(name));
}

// An answer is rendered as markdown. Printed to a terminal, its bold markers are dropped
// (the headline stands on a line of its own); written to a pipe or a file it stays markdown.
export function forTerminal(text: string, terminal: boolean): string {
  return terminal ? text.replace(/\*\*([^*\n]+)\*\*/g, '$1') : text;
}

// Questions on the terminal; a hidden one echoes nothing, for a secret.
export function askLine(question: string, hidden = false): Promise<string> {
  let muted = false;
  const output = new Writable({
    write(chunk: Buffer, _encoding, done) {
      if (!muted) process.stdout.write(chunk);
      done();
    },
  });
  const rl = createInterface({ input: process.stdin, output, terminal: Boolean(process.stdin.isTTY) });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      if (hidden) process.stdout.write('\n');
      rl.close();
      resolve(answer);
    });
    muted = hidden;
  });
}
