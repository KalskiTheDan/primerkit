import { join } from 'node:path';
import { approveLiveIntent, findLiveIntent, listLiveIntents, liveIntentLines, primerkitHome, readConfig, readLiveIntent, writeConfig, type Config } from '@primerkit/core';
import { HOST_NAMES, ROBINHOOD_HOSTS, ROBINHOOD_SERVER, ROBINHOOD_URL, applyInstall, describePlan, describeRemoval, planRobinhood, removeInstall, systemRunner, type Host, type InstallOptions, type InstallPlan, type Runner } from '@primerkit/mcp-server';
import { marked, type Io } from './broker';

// Robinhood live trading, through Robinhood's own hosted server. primerkit adds that server
// and the trade skill to the person's AI app, on a yes typed at a terminal, and sends no order
// to Robinhood itself. The trade skill asks the person's yes twice for each order: on its intent
// in primerkit and in the chat; Robinhood's trade approvals ask again in its app.

const noTerminal = (lead: string) => `${lead} at a terminal, and this run has none: its input or its output is a pipe or a file. Run it in a terminal yourself. Nothing was changed.`;

export const NO_ADVICE = 'Nothing here is investment advice, and the model never proposes a strategy.';

// The words shown before the yes.
export function robinhoodLines(host: Host, plan: InstallPlan): string[] {
  const app = HOST_NAMES[host];
  return [
    "Robinhood live trading, through Robinhood's own hosted server.",
    '',
    'This is real money: an order placed through it is a real order, and its losses are real.',
    NO_ADVICE,
    '',
    `- The server is Robinhood's own, at ${ROBINHOOD_URL}. primerkit runs none of it and passes it nothing.`,
    `- Signing in opens a separate agent account at Robinhood. You sign in inside ${app}, with /mcp. No key or password is typed into primerkit, and primerkit keeps none.`,
    "- The trade skill asks your yes twice for each order: you approve its intent in primerkit (primerkit intent approve <id>, typed at a terminal), and you say yes in the chat before it calls Robinhood's order tool. Robinhood's trade approvals, once you turn them on, ask a third time in Robinhood's app.",
    '- The trade skill records orders you typed, or orders from rules you wrote, and never proposes one.',
    "- primerkit's yes is asked by the trade skill. Robinhood's server sits beside primerkit, not behind it, so primerkit cannot stop an AI app that calls Robinhood's order tool without it. Keep Robinhood's trade approvals on, and keep your AI app's own question before an order tool.",
    '',
    `Adding it to ${app} makes these changes:`,
    ...describePlan(plan).map((l) => `  ${l}`),
    '',
  ];
}

// After the change: signing in, and the trade approvals switch.
export function robinhoodNext(host: Host): string[] {
  const app = HOST_NAMES[host];
  return [
    '',
    `Next, in ${app}:`,
    `  1. Type /mcp, choose ${ROBINHOOD_SERVER}, and sign in with Robinhood. That opens its separate agent account.`,
    "  2. In the agent's settings at Robinhood, under Safety Controls, turn Trade approvals on. Robinhood's page says they are off by default for outside agents. Turn them on before you put money in that account.",
  ];
}

function hostOf(io: Io, value: string | undefined): Host | null {
  if (value && (ROBINHOOD_HOSTS as readonly string[]).includes(value)) return value as Host;
  io.fail(`Say which app: ${ROBINHOOD_HOSTS.map((h) => `--host ${h}`).join(' or ')}. For any other app, follow Robinhood's own page.`);
  return null;
}

const robinhoodOf = (config: Config) => config.brokers?.robinhood ?? {};

function keep(home: string, change: (r: NonNullable<NonNullable<Config['brokers']>['robinhood']>) => NonNullable<NonNullable<Config['brokers']>['robinhood']> | null): void {
  const config = readConfig(home);
  const next = change({ ...robinhoodOf(config) });
  const brokers = { ...config.brokers };
  if (next) brokers.robinhood = next;
  else delete brokers.robinhood;
  writeConfig(home, { ...config, brokers });
}

export interface RobinhoodOptions {
  host?: string;
  remove: boolean;
  yes: boolean; // --yes: for taking it out only; adding it always asks at a terminal
  install: InstallOptions;
  runner?: Runner;
  home?: string;
  now?: () => Date;
}

export async function connectRobinhood(io: Io, o: RobinhoodOptions): Promise<number> {
  const host = hostOf(io, o.host);
  if (!host) return 1;
  const home = o.home ?? primerkitHome();
  const run = o.runner ?? systemRunner;
  const full = planRobinhood(host, o.install);
  const added = robinhoodOf(readConfig(home)).added ?? [];
  if (o.remove) {
    // The server goes only where primerkit added it; the skill is primerkit's own.
    const plan = { ...full, steps: full.steps.filter((s) => s.kind === 'file' || added.includes(host)) };
    io.print(marked(io, [`Taking Robinhood out of ${plan.name} makes these changes, each where primerkit's part is found:`, ...describeRemoval(plan).map((l) => `  ${l}`), ...(added.includes(host) ? [] : [`  (primerkit did not add Robinhood's server to ${plan.name}, so it stays.)`]), '']));
    if (!o.yes) {
      if (!io.terminal) return io.fail('Nothing was changed. Run the same command with --yes to make them.');
      if ((await io.ask('Make them? Type yes to make them: ')).trim().toLowerCase() !== 'yes') {
        io.print(['Nothing was changed.']);
        return 0;
      }
    }
    try {
      const done = await removeInstall(plan, run);
      keep(home, (r) => {
        const hosts = (r.hosts ?? []).filter((h) => h !== host);
        const still = (r.added ?? []).filter((h) => h !== host);
        return hosts.length ? { ...r, hosts, added: still } : null;
      });
      io.print([...done.map((d) => `${d}.`), done.length ? 'Done.' : 'Nothing of primerkit\'s was there.']);
      return 0;
    } catch (error) {
      return io.fail((error as Error).message);
    }
  }
  io.print(marked(io, robinhoodLines(host, full)));
  // Live money: the yes is typed by a person at a terminal, and no flag stands in for it.
  if (!io.terminal) return io.fail(noTerminal('The yes for adding Robinhood is typed'));
  if ((await io.ask('Make them? Type yes to make them: ')).trim().toLowerCase() !== 'yes') {
    io.print(['Nothing was changed.']);
    return 0;
  }
  let done: string[];
  try {
    done = await applyInstall(full, run);
  } catch (error) {
    return io.fail((error as Error).message);
  }
  const ranAdd = done.some((d) => d.startsWith("added Robinhood's server") || d.startsWith('edited '));
  keep(home, (r) => ({ ...r, hosts: [...new Set([...(r.hosts ?? []), host])], added: ranAdd ? [...new Set([...(r.added ?? []), host])] : (r.added ?? []) }));
  io.print([...done.map((d) => `${d}.`), ...robinhoodNext(host), '']);
  const on = (await io.ask('Are Trade approvals on? Type yes once you have turned them on: ')).trim().toLowerCase() === 'yes';
  if (on) keep(home, (r) => ({ ...r, approvals_confirmed_at: (o.now?.() ?? new Date()).toISOString() }));
  io.print([
    on
      ? 'Noted. On /connect, Robinhood reads: live agent account, real money.'
      : `Turn them on before you put money in that account. Until you say they are on, /connect says so beside Robinhood. primerkit connect robinhood --host ${host} asks again.`,
    'To take it out: primerkit connect robinhood --host ' + host + ' --remove.',
  ]);
  return 0;
}

// primerkit intent approve: the live intents waiting for a yes, or one approved on a yes typed
// at a terminal.
export async function approveCommand(io: Io, id: string | undefined, now: () => Date = () => new Date(), home = primerkitHome()): Promise<number> {
  const root = join(home, 'journal');
  if (!id) {
    const waiting = listLiveIntents(root, now()).filter((r) => r.state === 'pending');
    io.print(waiting.length ? ['Live intents waiting for your yes, newest at the top:', ...waiting.map((r) => `  ${r.intent.intent_id}  ${r.intent.side} ${r.intent.quantity} ${r.intent.symbol}`), '', 'primerkit intent approve <id> shows one and asks your yes.'] : ['No live intent is waiting for your yes.']);
    return 0;
  }
  const dir = findLiveIntent(root, id);
  if (!dir) return io.fail(`There is no live intent ${id} in the journal. primerkit intent approve lists those waiting.`);
  const record = readLiveIntent(dir, now());
  io.print([...liveIntentLines(record), '']);
  if (record.state !== 'pending') return io.fail(record.state === 'approved' ? 'It is approved already.' : 'It has expired. Record the order again.');
  if (!io.terminal) return io.fail(noTerminal('The yes for a live intent is typed'));
  io.print(["Approving it lets your AI app place this one order through Robinhood's server, where Robinhood's trade approvals, if you turned them on, ask again in its app. It is real money.", NO_ADVICE, '']);
  if ((await io.ask('Approve this intent? Type yes to approve it: ')).trim().toLowerCase() !== 'yes') {
    io.print(['Not approved. Nothing was changed.']);
    return 0;
  }
  try {
    const approved = approveLiveIntent(dir, now());
    io.print([`Approved. Your AI app reads this with primerkit's status tool. It expires ${approved.intent.expires_at.slice(11, 16)} UTC.`]);
    return 0;
  } catch (error) {
    return io.fail((error as Error).message);
  }
}

