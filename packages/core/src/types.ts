// The shapes the environment is built from.

export type OperationKind = 'research' | 'strategy';
export type PacketFormat = 'json' | 'markdown';

export interface InputSpec {
  name: string;
  type: 'string' | 'string[]';
  required: boolean;
}

export type DataSource =
  | { connector: 'prereason'; briefing: string | { from: 'input' | 'catalog' }; format: PacketFormat; date?: string }
  | { connector: 'prereason'; metric: string; format: PacketFormat }
  | { connector: 'file'; path: string };

export interface DataPlan {
  sources: DataSource[];
  maxPacketTokens?: number; // the executor refuses a packet above this
}

export interface OperationSpec {
  id: string; // "ask", or the user's own, such as "my.flows-watch"
  version: string; // recorded with every run
  kind: OperationKind; // only strategy operations may return a label
  title: string;
  inputs: InputSpec[];
  data: DataPlan;
  output: { schema: string; forbiddenFields: string[] };
  checks: string[]; // built in check ids
  render?: string;
}

// An operation as loaded from its folder: the spec and the files it names.
export interface Operation {
  spec: OperationSpec;
  dir: string;
  primer: string;
  schema: Record<string, unknown>;
  render: string | null;
  // A routine's labels that keep what is held, such as watch: the cites_data check lets
  // one stand on the data alone, with no rule cited. Every other label moves the account.
  holdLabels?: string[];
}

export interface DataBlock {
  id: string; // "btc.pulse"
  source: string; // "prereason"
  format: PacketFormat;
  fetchedAt: string;
  generatedAt?: string; // the briefing's own Generated time
  lines: string[]; // rendered as [btc.pulse L12], counting from 1
  // When a block holds only some of a briefing's lines, the number of each, so a
  // citation keeps the briefing's own numbering.
  numbers?: number[];
  raw?: string; // the body as served, for snapshots and the digest; never in a packet
  // What the packet calls a block that is not a briefing, such as a routine's rules or
  // its price table: "The person's rules (block rules)".
  heading?: string;
}

export interface Packet {
  runId: string;
  operation: { id: string; version: string };
  question: string;
  primer: string;
  blocks: DataBlock[];
  schema: Record<string, unknown>;
  notes: string[]; // what was left out to fit the model's context, said to the model too
  asOf?: string; // the past day every block was read for, YYYY-MM-DD; absent when read as it stands now
  text: string; // the packet as the model reads it
  cachePrefix?: number; // where the question starts, when it comes last: text before it is the same for every question, so a provider may cache it
  hash: string; // sha256 of the canonical packet
  tokens: { label: string; count: number }; // the tokenizer's own label, a proxy
}

export interface Citation {
  block: string;
  line: number;
  quote: string;
}

export interface Claim {
  text: string;
  citations: Citation[];
}

// The answer an ask returns.
export interface AskResponse {
  answer: string;
  claims: Claim[];
  not_in_data: string[];
  data_as_of?: string;
  // Sentences from the model's general knowledge, for a question that reaches past the
  // lines: no number and no advice, and shown apart from what the data says.
  background?: string[];
}

// Which way a check failed, where it can fail in more than one, so the checks line names
// what failed: a reply that is not JSON or not in its shape, which no other check runs
// past, or scope's field, advice words, background advice, background past its four
// sentences, or an equities briefing that names no company.
export type FailureReason = 'format' | 'field' | 'advice' | 'background_advice' | 'background_length' | 'equities' | 'news_move';

export interface CheckFailure {
  check: string;
  message: string;
  claim?: number; // the claim's index, when the failure belongs to one claim
  background?: number; // the background sentence's index, when the failure belongs to one
  soft?: boolean; // a failure that does not stop the run: the run shows what it missed
  fix?: string; // what the model is told to do instead, on its repair turn alone; never shown to the person
  reason?: FailureReason;
}

export interface Check {
  id: string;
  run(packet: Packet, response: unknown, operation: Operation): CheckFailure[];
}

export interface ModelCapabilities {
  local: boolean; // the model runs on this machine, so packets never leave it
  schemaConstraint: boolean; // the runtime can hold output to a JSON schema
  contextTokens: number | null; // what a request gets now: reported, or the config value; null when unknown
  canRaiseContext: boolean; // Ollama: num_ctx per request; servers: fixed at start
  maxContextTokens?: number | null; // how far the context can be raised: the model's own limit within the user's cap
  format: PacketFormat; // the packet format for this model
}

// What a model returned, with what the runtime reported about the call.
export interface ModelReply {
  text: string;
  modelReported?: string;
  usage?: { inputTokens?: number; outputTokens?: number; cacheReadTokens?: number; cacheWriteTokens?: number };
}

// A hosted model's list price, in dollars a million tokens, where primerkit knows it.
export interface TokenPrice {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

// The tokens a run's calls read and wrote, as the runtime reported them, summed over its
// turns; reported is false where the runtime reported none, and the counts are then zero.
export interface RunUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  reported: boolean;
}

// What a run cost: at the model's list price, or nothing for a model on this machine. Absent
// where neither is known.
export interface RunCost {
  usd: number;
  basis: 'list price' | 'local';
}

export interface ModelAdapter {
  id: string; // "ollama:<model>", "local:<base url>:<model>", "anthropic:<model>"
  label: string; // "qwen2.5:7b, local, 8k", for the top line
  price?: TokenPrice | null; // its list price, where primerkit knows it
  capabilities(): Promise<ModelCapabilities>;
  complete(packet: Packet, repair?: CheckFailure[], signal?: AbortSignal): Promise<ModelReply>;
}

export interface DataConnector {
  id: string;
  // history: a company briefing's numbers block with its statement history, as it stands today.
  fetch(source: { briefing: string; format: PacketFormat; date?: string; history?: boolean }): Promise<DataBlock>;
}
