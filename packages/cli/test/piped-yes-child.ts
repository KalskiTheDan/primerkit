// A child for broker.test.ts: `primerkit broker ...` as the command wires it, with the
// command's own terminal rule and question function (src/terminal.ts), but with a keychain
// that lives in this process and a fake Alpaca on 127.0.0.1. However it goes wrong, it can
// reach neither the system's keychain nor Alpaca: it stops at once unless FAKE_BASE is an
// address on this machine, since with none the broker would use Alpaca's own paper address.
// The parent hands it "yes" on a pipe.
//   FAKE_BASE         the fake Alpaca's address, http://127.0.0.1:<port>
//   CHILD_COMMAND     order (the default) or enable
//   CHILD_AS_TERMINAL set by the control only: the rule is skipped, as if a person sat there
import type { Keychain } from '@primerkit/brokers';
import { brokerCommand } from '../src/broker';
import { askLine, isTerminal } from '../src/terminal';

const store = new Map<string, string>([
  ['alpaca-paper-key-id', 'PKPAPER'],
  ['alpaca-paper-secret', 'paper-secret'],
]);
const keychain: Keychain = { set: async (n, s) => void store.set(n, s), get: async (n) => store.get(n) ?? null, remove: async (n) => store.delete(n) };
const flags: Record<string, string> = { '--notional': '25' };
const enable = process.env.CHILD_COMMAND === 'enable';
const base = process.env.FAKE_BASE ?? '';
if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(base)) {
  process.stderr.write('piped-yes-child: FAKE_BASE is not an address on this machine, so nothing was run\n');
  process.exit(2);
}

process.stdout.write(`a terminal: ${isTerminal()}\n`);
process.exitCode = await brokerCommand(
  {
    print: (lines) => void process.stdout.write(`${lines.join('\n')}\n`),
    fail: (m) => (process.stderr.write(`${m}\n`), 1),
    ask: askLine,
    terminal: process.env.CHILD_AS_TERMINAL === '1' ? true : isTerminal(),
    keychain,
    base,
  },
  enable ? { sub: 'enable', rest: [], flag: () => undefined, has: () => false } : { sub: 'order', rest: ['btc/usd', 'buy'], flag: (n) => flags[n], has: (n) => n === '--paper' },
);
