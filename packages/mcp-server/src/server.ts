import { createInterface } from 'node:readline';
import type { Readable, Writable } from 'node:stream';
import { LiveIntentError, type JournalQuery } from '@primerkit/core';
import { CodedError, errorJson } from './codes';
import type { HostRuns } from './runs';

// The local MCP server an AI app starts as `primerkit mcp`: JSON-RPC 2.0, one message a
// line on stdin and stdout. Nothing else may be written to stdout.

export const TOOLS = [
  {
    name: 'list_operations',
    description: 'Lists the operations primerkit can prepare: their ids, titles and inputs.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'prepare_operation',
    description:
      "Prepares an operation's packet from PreReason briefings and metrics: its primer, the lines numbered like [btc.pulse L12] or [treasury-10y L2], and the answer's schema. For ask without briefings or metrics it returns the catalog to pick from instead; call it again with up to three ids in all. For a question about one past day, pass that day as date.",
    inputSchema: {
      type: 'object',
      properties: {
        operation: { type: 'string', enum: ['ask', 'digest'] },
        question: { type: 'string', description: 'The question, for ask.' },
        briefings: { type: 'array', items: { type: 'string' }, maxItems: 3, description: 'Briefing ids from the catalog, for ask.' },
        metrics: { type: 'array', items: { type: 'string' }, maxItems: 3, description: 'Metric ids from the catalog, for ask. A metric is read as it stands now. At most three briefings and metrics together.' },
        date: {
          type: 'string',
          description:
            'For ask: the one past day the question asks about, as YYYY-MM-DD, worked out by you from words such as "last Friday". The briefings are read as they stood that day. Leave it out for today or for a span of days. A day the question writes out itself, such as 2026-08-15, comes first.',
        },
      },
      required: ['operation'],
      additionalProperties: false,
    },
  },
  {
    name: 'submit_response',
    description: "Submits the JSON answer to a prepared packet. primerkit checks its schema, citations, numbers and scope; if a check fails it returns the failures once for a repair; then it keeps the run in the journal and returns the view to show the person.",
    inputSchema: {
      type: 'object',
      properties: {
        run_id: { type: 'string' },
        response: { description: 'The JSON answer, as an object or as its text.' },
      },
      required: ['run_id', 'response'],
      additionalProperties: false,
    },
  },
  {
    name: 'journal_read',
    description: 'Lists the latest runs in the journal on this machine, or the runs that match its filters, or reads one run by its id: its question, answer, the lines it cites, its checks, tokens and cost. It changes nothing.',
    inputSchema: {
      type: 'object',
      properties: {
        run_id: { type: 'string' },
        limit: { type: 'integer', minimum: 1, maximum: 50 },
        operation: { type: 'string', description: 'ask, digest, bench, backtest, routine, compare or model-check.' },
        briefing: { type: 'string', description: 'A briefing or metric id the run read.' },
        outcome: { type: 'string', enum: ['passed', 'partial', 'failed', 'refused', 'pending'] },
        day: { type: 'string', description: 'YYYY-MM-DD.' },
        search: { type: 'string', description: 'Words in a question or an answer.' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'status',
    description:
      "Reads what primerkit stands on, changing nothing: the model that answers, PreReason's connection and tier, each broker's connection and mode (Alpaca on its paper account; Robinhood live through Robinhood's own server, where it was added), and the journal's counts for today with tokens and cost. With intent_id it reads that live intent's state: pending, approved or expired.",
    inputSchema: {
      type: 'object',
      properties: { intent_id: { type: 'string', description: 'A live intent id from intent_record, to read its state.' } },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'catalog',
    description: "Lists or searches the briefings this key reads and PreReason's metrics, by words in their ids, names and descriptions, changing nothing. Pass the ids it returns to prepare_operation.",
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Words to search for, such as "treasury yields"; leave it out to list everything.' },
        kind: { type: 'string', enum: ['briefings', 'metrics', 'all'], description: 'all by default.' },
        limit: { type: 'integer', minimum: 1, maximum: 200, description: 'Most of each kind returned, 50 by default.' },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'intent_record',
    description:
      "Keeps one live order intent for Robinhood in primerkit's journal, as pending, and sends nothing to any broker. Record an order the person typed, or one from rules the person wrote, and name which; never one you propose. The person approves it with primerkit intent approve <id>, typed at a terminal; read its state with status. Place nothing until it reads approved.",
    inputSchema: {
      type: 'object',
      properties: {
        symbol: { type: 'string', description: 'The ticker, such as AAPL.' },
        side: { type: 'string', enum: ['buy', 'sell'] },
        quantity: { type: 'number', exclusiveMinimum: 0, description: 'Shares, to at most six decimals.' },
        order_type: { type: 'string', enum: ['market', 'limit'], description: 'market by default.' },
        limit_price: { type: 'number', exclusiveMinimum: 0, description: 'For a limit order; leave it out for a market order.' },
        source: { type: 'string', enum: ['typed', 'rules'], description: 'typed: the person typed this order. rules: it comes from rules the person wrote.' },
        rules: { type: 'string', description: 'For source rules: the name of the rules it came from.' },
      },
      required: ['symbol', 'side', 'quantity', 'source'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
  },
  {
    name: 'bench_next',
    description:
      "Hands out the comprehension benchmark's next packet: a reading test on one frozen briefing, as markdown, as JSON or with no data. Answer each in a fresh context with the model pinned, then record the reply with bench_record. When every packet is recorded it returns the result.",
    inputSchema: {
      type: 'object',
      properties: {
        model: { type: 'string', description: 'The model that answers the packets, as the host names it. Recorded as declared.' },
        runs: { type: 'integer', minimum: 1, maximum: 5, description: 'Runs of each packet, 3 by default. Read when a benchmark starts.' },
        restart: { type: 'boolean', description: 'Start over, dropping the answers recorded so far.' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'bench_record',
    description: "Records the reply to one benchmark packet, exactly as the model gave it, and scores it by code. A recorded reply is never replaced.",
    inputSchema: {
      type: 'object',
      properties: { key: { type: 'string' }, response: { description: 'The reply: the answers object, or its text.' } },
      required: ['key', 'response'],
      additionalProperties: false,
    },
  },
  {
    name: 'backtest_next',
    description:
      "Starts a backtest of one of the person's routines over a past window, or carries a run on, and hands out its next packet: the person's rules and the data as it stood on one tick, in one arm. Answer each in a fresh context with the model pinned, then record the reply with backtest_record. When every tick is recorded it returns the report.",
    inputSchema: {
      type: 'object',
      properties: {
        routine: { type: 'string', description: 'The routine, by its name.' },
        from: { type: 'string', description: 'The first day of the window, such as 2026-06-01, to start a run.' },
        to: { type: 'string', description: 'The last day of the window, yesterday at the latest.' },
        every: { type: 'string', enum: ['day', 'week'], description: "How often it runs in the window; the routine's own otherwise." },
        reps: { type: 'integer', minimum: 1, maximum: 5, description: 'Each arm run this many times over, 1 by default.' },
        model: { type: 'string', description: 'The model that answers the packets, as the host names it. Recorded as declared.' },
        run: { type: 'string', description: 'A run to carry on, as backtest_next named it.' },
        cutoff: { type: 'string', description: "The model's training cutoff as a month, such as 2025-07, from its model card, where primerkit does not know it and the person gives it. Kept for next time. Without it, the memory check decides." },
        inside_training: { type: 'boolean', description: "The person's yes to a window inside the model's training, or one it remembers. Every result then says so." },
      },
      required: ['routine'],
      additionalProperties: false,
    },
  },
  {
    name: 'backtest_record',
    description:
      "Records the reply to one backtest packet, exactly as the model gave it. primerkit checks it as it checks every answer, and returns the failures once for a repair; then the label moves the simulated account and the tick is kept. A recorded tick is never replaced.",
    inputSchema: {
      type: 'object',
      properties: {
        run: { type: 'string' },
        key: { type: 'string' },
        response: { description: 'The JSON reply, as an object or as its text.' },
      },
      required: ['run', 'key', 'response'],
      additionalProperties: false,
    },
  },
] as const;

export const ASK_STEPS = [
  '1. Call prepare_operation with operation "ask" and the question. If it returns a catalog instead of a packet, pick up to three briefings or metrics that fit and call it again with them. If the question asks about one past day, pass that day as date (YYYY-MM-DD).',
  "2. Read the packet's primer, then its lines. Answer by the primer's rules only.",
  '3. Call submit_response with the run id and your JSON. If it returns failures, fix them once and submit again.',
  '4. Show the rendered answer it returns, footnotes included.',
].join('\n');

export const DIGEST_STEPS = [
  '1. Call prepare_operation with operation "digest". If it returns the finished digest, show it.',
  '2. Otherwise write one change for each item in the packet\'s diff block, by the primer\'s rules.',
  '3. Call submit_response with the run id and your JSON. If it returns failures, fix them once and submit again.',
  '4. Show the digest it returns.',
].join('\n');

export const BENCH_STEPS = [
  '1. Call bench_next with the model id you will pin. It returns one packet and its key.',
  '2. Answer each packet in a fresh context: start a subagent with that model pinned, give it the packet text as it is, and ask for its reply only. Never answer a packet yourself in this conversation, and never pass it anything but the packet.',
  "3. Call bench_record with the key and the subagent's reply, exactly as it came.",
  '4. Repeat until bench_next returns the result, then show it. Up to five subagents may run at once.',
].join('\n');

export const BACKTEST_STEPS = [
  '1. Call backtest_next with the routine, the window (from and to, ending yesterday at the latest) and the model id you will pin. It returns the run, one packet and its key, or the plan\'s problems, which you show and stop. A model whose training cutoff primerkit does not know runs all the same: the memory check decides, and the report says so. Give cutoff only when the person gives it, from the model card; never guess it.',
  '2. Answer each packet in a fresh context: start a subagent with that model pinned, give it the packet text as it is, and ask for its JSON reply only. Never answer a packet yourself in this conversation, and never pass it anything but the packet. The first packets ask the model three prices with no data; answer them the same way.',
  "3. Call backtest_record with the run, the key and the subagent's reply, exactly as it came. If it returns failures, start one more subagent with the packet and that note, and record its reply.",
  '4. Call backtest_next with the run for the next packet, until it returns the report, then show it as it is. Up to three subagents may run at once, since the ticks of one arm run in order. If it stops because the window is inside the model\'s training, or the model remembers it, ask the person, and go on only with their yes (inside_training: true).',
].join('\n');

export const PROMPTS = [
  { name: 'ask', description: 'Answer a market question from PreReason briefings, every claim cited to a numbered line.', arguments: [{ name: 'question', description: 'The question', required: true }] },
  { name: 'digest', description: 'What changed in your PreReason watchlist since the last digest, cited line by line.', arguments: [] },
  { name: 'bench', description: "The comprehension benchmark on this app's model: frozen briefings as markdown, as JSON and with no data, scored by code.", arguments: [] },
  { name: 'backtest', description: 'Backtest one of your routines over a past window, in three arms, through a simulated account.', arguments: [{ name: 'routine', description: 'The routine, by its name', required: true }, { name: 'from', description: 'The first day of the window', required: true }, { name: 'to', description: 'The last day, yesterday at the latest', required: true }] },
];

interface Message {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
}

// A result's text, for the person, and beside it the same result as JSON, as a second text
// block. Never as structuredContent: an app that finds it hands its model that alone, and
// Claude Code did so, so its model saw a packet's ids and counts but not its numbered lines,
// its primer or its schema, and could not answer.
type ToolResult = { content: Array<{ type: string; text: string }>; isError?: boolean };
const text = (t: string, json?: Record<string, unknown>, isError = false): ToolResult => ({
  content: [{ type: 'text', text: t }, ...(json ? [{ type: 'text', text: JSON.stringify(json) }] : [])],
  ...(isError ? { isError: true } : {}),
});

export async function callTool(runs: HostRuns, name: string, args: Record<string, unknown>): Promise<ToolResult> {
  try {
    switch (name) {
      case 'list_operations':
        return text(JSON.stringify(runs.listOperations(), null, 2), { operations: runs.listOperations() });
      case 'prepare_operation': {
        const prepared = await runs.prepare({
          operation: String(args.operation ?? ''),
          ...(typeof args.question === 'string' ? { question: args.question } : {}),
          ...(Array.isArray(args.briefings) ? { briefings: args.briefings.map(String) } : {}),
          ...(Array.isArray(args.metrics) ? { metrics: args.metrics.map(String) } : {}),
          ...(typeof args.date === 'string' ? { date: args.date } : {}),
        });
        if (prepared.kind === 'catalog') {
          const line = (b: { id: string; name: string; description: string }) => `${b.id}: ${b.name}. ${b.description}`;
          // Metrics by id and name only: with every description the list ran past what an app
          // takes in one result (Claude Code set it aside in a file). The catalog tool searches them.
          const metrics = prepared.metrics.length ? `\n\nMetrics, each read as it stands now (pass as metrics; the catalog tool searches their descriptions):\n${prepared.metrics.map((m) => `${m.id}: ${m.name}`).join('\n')}` : '';
          // On a Free key a metric read on its own is its latest reading alone, so a question about
          // a change is answered from the briefing that carries it.
          const free = prepared.latestOnly ? '\nOn a Free key, a metric read on its own gives its latest reading alone; a briefing gives its metrics with their changes, so read a briefing for a question about a change.' : '';
          const day = prepared.date ? `\nThe question names ${prepared.date}: the briefings are read as they stood that day, and metrics cannot be.` : '\nIf the question asks about one past day, pass it as date, YYYY-MM-DD.';
          return text(`Pick up to three briefings or metrics that answer the question, then call prepare_operation again with their ids.${day}\nCode would pick: ${prepared.suggested.join(', ') || 'none'}.${free}\n\nBriefings (pass as briefings):\n${prepared.briefings.map(line).join('\n')}${metrics}`, { kind: 'catalog', date: prepared.date, suggested: prepared.suggested, briefings: prepared.briefings.map((b) => b.id), metrics: prepared.metrics.map((m) => m.id) });
        }
        if (prepared.kind === 'done') return text(prepared.render, { kind: 'done' });
        return text(`run_id: ${prepared.runId}\nAnswer by the rules at the top of this packet, then call submit_response with this run_id and your JSON.\n\n${prepared.packet}`, { kind: 'packet', ...prepared.json });
      }
      case 'submit_response': {
        const submitted = runs.submit({ runId: String(args.run_id ?? ''), response: args.response });
        if (submitted.kind === 'repair') return text(`The answer failed these checks. Fix them and call submit_response once more with the same run_id:\n${submitted.failures.map((f) => `- ${f}`).join('\n')}`, submitted.json);
        return text(submitted.render, submitted.json);
      }
      case 'journal_read': {
        const query: JournalQuery = {
          ...(typeof args.operation === 'string' && args.operation.trim() ? { operation: args.operation.trim().toLowerCase() } : {}),
          ...(typeof args.briefing === 'string' && args.briefing.trim() ? { briefing: args.briefing.trim().toLowerCase() } : {}),
          ...(typeof args.outcome === 'string' && args.outcome.trim() ? { outcome: args.outcome.trim().toLowerCase() } : {}),
          ...(typeof args.day === 'string' && args.day.trim() ? { day: args.day.trim() } : {}),
          ...(typeof args.search === 'string' && args.search.trim() ? { text: args.search.trim() } : {}),
        };
        const filters = Object.keys(query).length ? { query } : {};
        const limit = typeof args.limit === 'number' ? { limit: args.limit } : {};
        if (typeof args.run_id === 'string') {
          const run = runs.journalRunJson(args.run_id);
          return text(runs.journalRead({ runId: args.run_id }), run ?? undefined);
        }
        return text(runs.journalRead({ ...limit, ...filters }), runs.journalJson({ ...limit, ...filters }));
      }
      case 'status': {
        const status = runs.status(typeof args.intent_id === 'string' ? { intentId: args.intent_id } : {});
        return text(status.text, status.json);
      }
      case 'catalog': {
        const found = await runs.catalogSearch({
          ...(typeof args.query === 'string' ? { query: args.query } : {}),
          ...(args.kind === 'briefings' || args.kind === 'metrics' || args.kind === 'all' ? { kind: args.kind } : {}),
          ...(typeof args.limit === 'number' ? { limit: args.limit } : {}),
        });
        return text(found.text, found.json);
      }
      case 'intent_record': {
        const kept = runs.intentRecord({ symbol: args.symbol, side: args.side, quantity: args.quantity, order_type: args.order_type, limit_price: args.limit_price, source: args.source, rules: args.rules });
        return text(kept.text, kept.json);
      }
      case 'bench_next': {
        const next = runs.benchNext({
          ...(typeof args.model === 'string' ? { model: args.model } : {}),
          ...(typeof args.runs === 'number' ? { runs: args.runs } : {}),
          ...(args.restart === true ? { restart: true } : {}),
        });
        if (next.kind === 'done') return text(next.render);
        return text(`key: ${next.key}\n${next.done} of ${next.total} recorded. Give this packet, exactly as it is between the lines, to a fresh subagent with the model pinned:\n\n----\n${next.packet}----`);
      }
      case 'backtest_next': {
        const next = await runs.backtestNext({
          routine: String(args.routine ?? ''),
          ...(typeof args.from === 'string' ? { from: args.from } : {}),
          ...(typeof args.to === 'string' ? { to: args.to } : {}),
          ...(args.every === 'day' || args.every === 'week' ? { every: args.every } : {}),
          ...(typeof args.reps === 'number' ? { reps: args.reps } : {}),
          ...(typeof args.model === 'string' ? { model: args.model } : {}),
          ...(typeof args.run === 'string' ? { run: args.run } : {}),
          ...(typeof args.cutoff === 'string' ? { cutoff: args.cutoff } : {}),
          ...(args.inside_training === true ? { insideTraining: true } : {}),
        });
        if (next.kind === 'done') return text(next.render);
        if (next.kind === 'blocked') return text(`run: ${next.run}\nStopped before the first tick: ${next.reason}.\nAsk the person. With their yes, call backtest_next with this run and inside_training: true, and every result will say it is inside the model's training window.`);
        if (next.kind === 'wait') return text(`run: ${next.run}\n${next.handed.length} ${next.handed.length === 1 ? 'packet is' : 'packets are'} out for answers (${next.handed.join(', ')}). Record ${next.handed.length === 1 ? 'it' : 'them'} with backtest_record, then call backtest_next again.`);
        if (next.key.startsWith('memory/')) return text(`run: ${next.run}\nkey: ${next.key}\nThe memory check, before the first tick: this packet asks the model one price with no data. Give it, exactly as it is, to a fresh subagent with the model pinned, then call backtest_record with this run, this key and the reply.\n\n${next.packet}`);
        return text(`run: ${next.run}\nkey: ${next.key}\n${next.done} of ${next.total} ticks done.\nAnswer by the rules at the top of this packet, in a fresh context with the model pinned, then call backtest_record with this run, this key and the reply.\n\n${next.packet}`);
      }
      case 'backtest_record': {
        const recorded = runs.backtestRecord({ run: String(args.run ?? ''), key: String(args.key ?? ''), response: args.response });
        if (recorded.kind === 'repair') return text(`The reply failed these checks. Start one more subagent with the packet and this note, and record its reply with the same run and key:\n${recorded.failures.map((f) => `- ${f}`).join('\n')}`);
        return text(`${recorded.line}\n${recorded.done} of ${recorded.total} ticks done. Call backtest_next with the run for the next packet.`);
      }
      case 'bench_record': {
        const recorded = runs.benchRecord({ key: String(args.key ?? ''), response: args.response });
        return text(`Recorded: ${recorded.score}. ${recorded.done} of ${recorded.total} recorded. Call bench_next for the next packet.`);
      }
      default:
        return text(`There is no tool ${name}.`, { ok: false, error: { code: 'not_found', message: `There is no tool ${name}.` } }, true);
    }
  } catch (error) {
    // A refusal of primerkit's own is said as it is; anything else says primerkit could not do it.
    const coded = errorJson(error);
    const words = error instanceof CodedError || error instanceof LiveIntentError ? coded.error.message : `primerkit could not do that: ${(error as Error).message}`;
    return text(words, { ...coded, error: { ...coded.error, message: words } }, true);
  }
}

export function serveMcp(runs: HostRuns, io: { input: Readable; output: Writable }, info: { version: string }): Promise<void> {
  const send = (message: object) => io.output.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);
  const rl = createInterface({ input: io.input });
  rl.on('line', (line) => {
    if (!line.trim()) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      send({ id: null, error: { code: -32700, message: 'Parse error' } });
      return;
    }
    // A request that is not an object with a method's name gets JSON-RPC's own error, and
    // anything that goes wrong in a handler is answered too: the server never stops on a
    // line an app sends.
    const obj = typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? (parsed as Message) : null;
    if (!obj || typeof obj.method !== 'string') {
      const id = obj && (typeof obj.id === 'string' || typeof obj.id === 'number') ? obj.id : null;
      send({ id, error: { code: -32600, message: 'Invalid Request' } });
      return;
    }
    const msg = obj;
    handle(msg).then(
      (result) => {
        if (msg.id === undefined || msg.id === null) return; // a notification takes no reply
        if (result === undefined) send({ id: msg.id, error: { code: -32601, message: `Method not found: ${msg.method}` } });
        else send({ id: msg.id, result });
      },
      (error: unknown) => {
        if (msg.id === undefined || msg.id === null) return;
        send({ id: msg.id, error: { code: -32603, message: `Internal error: ${(error as Error)?.message ?? String(error)}` } });
      },
    );
  });

  async function handle(msg: Message): Promise<unknown> {
    const params = msg.params ?? {};
    switch (msg.method) {
      case 'initialize':
        return {
          protocolVersion: typeof params.protocolVersion === 'string' ? params.protocolVersion : '2025-06-18',
          capabilities: { tools: { listChanged: false }, prompts: { listChanged: false } },
          serverInfo: { name: 'primerkit', version: info.version },
          instructions: 'primerkit prepares packets of PreReason briefings with every line numbered, checks the answer you write, and keeps each run in a journal on this machine.',
        };
      case 'ping':
        return {};
      case 'tools/list':
        return { tools: TOOLS };
      case 'tools/call':
        return callTool(runs, String(params.name ?? ''), (params.arguments ?? {}) as Record<string, unknown>);
      case 'prompts/list':
        return { prompts: PROMPTS };
      case 'prompts/get': {
        const name = String(params.name ?? '');
        const args = (params.arguments ?? {}) as Record<string, unknown>;
        if (name === 'ask') return { messages: [{ role: 'user', content: { type: 'text', text: `${ASK_STEPS}\n\nThe question: ${String(args.question ?? '')}` } }] };
        if (name === 'digest') return { messages: [{ role: 'user', content: { type: 'text', text: DIGEST_STEPS } }] };
        if (name === 'bench') return { messages: [{ role: 'user', content: { type: 'text', text: BENCH_STEPS } }] };
        if (name === 'backtest') return { messages: [{ role: 'user', content: { type: 'text', text: `${BACKTEST_STEPS}\n\nThe routine: ${String(args.routine ?? '')}. The window: ${String(args.from ?? '')} to ${String(args.to ?? '')}.` } }] };
        return undefined;
      }
      default:
        return msg.method?.startsWith('notifications/') ? {} : undefined;
    }
  }

  return new Promise((resolve) => rl.on('close', () => resolve()));
}
