import type { CheckFailure, ModelAdapter, ModelCapabilities, ModelReply, Packet, PacketFormat } from '@primerkit/core';

// A scripted answer: the text itself, or a function of the packet it answers.
export type Script = string | ((packet: Packet, repair?: CheckFailure[]) => string);

// Models for tests and for the demo. Neither is a language model, and each says so
// in its label.

// Returns its scripts in turn, the last one again once they run out, and records what
// it was asked.
export class ScriptedModel implements ModelAdapter {
  readonly id: string = 'scripted';
  readonly label: string = 'scripted test model';
  readonly calls: Array<{ packet: Packet; repair?: CheckFailure[] }> = [];
  private next = 0;

  constructor(private readonly texts: Script[], private readonly caps: Partial<ModelCapabilities> = {}) {}

  async capabilities(): Promise<ModelCapabilities> {
    return { local: true, schemaConstraint: true, contextTokens: null, canRaiseContext: false, format: 'markdown', ...this.caps };
  }

  async complete(packet: Packet, repair?: CheckFailure[]): Promise<ModelReply> {
    this.calls.push(repair ? { packet, repair } : { packet });
    const script = this.texts[Math.min(this.next, this.texts.length - 1)];
    this.next += 1;
    if (script === undefined) throw new Error('the scripted model has no answer');
    return { text: typeof script === 'function' ? script(packet, repair) : script };
  }
}

// A sentence the stand in can lift: a metric's sentence, plain prose that holds a figure,
// not a heading or a note. Every one in the blocks, in their order.
export interface Liftable {
  block: string;
  line: number;
  sentence: string;
}

export function liftable(blocks: Packet['blocks']): Liftable[] {
  const out: Liftable[] = [];
  for (const block of blocks) {
    block.lines.forEach((line, i) => {
      const sentence = line.trim();
      if (/^[#*\-|{]/.test(sentence) || !/\d/.test(sentence) || sentence.length < 20) return;
      out.push({ block: block.id, line: i + 1, sentence });
    });
  }
  return out;
}

// The demo's stand in: it answers by lifting whole sentences out of the packet, so
// its answers always pass their checks. It shows the flow without a model or a key;
// it does not read the question, and says so on screen.
export class ExtractiveModel implements ModelAdapter {
  readonly id: string = 'demo:extractive';
  readonly label: string = 'demo, no model';

  constructor(private readonly format: PacketFormat = 'markdown') {}

  async capabilities(): Promise<ModelCapabilities> {
    return { local: true, schemaConstraint: true, contextTokens: null, canRaiseContext: false, format: this.format };
  }

  // The sentences it lifts: the first three. The demo's stand in picks them by the
  // question's words instead.
  protected lift(packet: Packet): Liftable[] {
    return liftable(packet.blocks).slice(0, 3);
  }

  async complete(packet: Packet): Promise<{ text: string }> {
    const claims = this.lift(packet).map((l) => ({ text: /[.!?]$/.test(l.sentence) ? l.sentence : `${l.sentence}.`, citations: [{ block: l.block, line: l.line, quote: l.sentence }] }));
    const answer = claims[0]?.text ?? 'The packet holds no sentence with a figure to report.';
    return { text: JSON.stringify({ answer, claims, not_in_data: claims.length ? [] : ['a sentence with a figure'] }) };
  }
}
