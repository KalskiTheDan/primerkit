import { join } from 'node:path';
import { intentRows, primerkitHome } from '@primerkit/core';
import { positionsText, type HoldingsView, type PositionsView } from '@primerkit/session';
import { brokerFrom, modeOf, type Io } from './broker';

// primerkit positions, and the session's /positions: the Alpaca paper account's holdings, read
// only where its mode in config.yaml reads (read, dry run or paper), and every order intent in
// the journal. Nothing here sends, approves or changes an order.

export async function paperHoldings(io: Io, home = primerkitHome(), now = new Date()): Promise<HoldingsView> {
  const { mode, wrong } = modeOf(home);
  if (wrong) return { kind: 'note', text: `its mode in config.yaml is not usable, so nothing is read: ${wrong}.` };
  if (mode === 'off') return { kind: 'note', text: 'off. primerkit connect alpaca keeps paper keys, and mode: read in config.yaml reads the account.' };
  const broker = await brokerFrom(io);
  if (!broker) return { kind: 'note', text: 'no paper keys are kept. primerkit connect alpaca asks for them at a terminal.' };
  const held = await broker.positions();
  return {
    kind: 'held',
    mode,
    readAt: now.toISOString(),
    rows: held.map((p) => ({ symbol: p.symbol, qty: p.qty, marketValue: p.marketValue, ...(p.avgEntryPrice !== undefined ? { avgEntryPrice: p.avgEntryPrice } : {}), ...(p.changeToday !== undefined ? { changeToday: p.changeToday } : {}) })),
  };
}

export async function positionsView(io: Io, home = primerkitHome(), now = new Date()): Promise<PositionsView> {
  const holdings = await paperHoldings(io, home, now).catch((error: unknown): HoldingsView => ({ kind: 'note', text: `the paper account could not be read: ${(error as Error).message}` }));
  return { holdings, intents: intentRows(join(home, 'journal'), now) };
}

export async function positionsCommand(io: Io, json: boolean, home = primerkitHome(), now = new Date()): Promise<number> {
  const view = await positionsView(io, home, now);
  if (json) {
    io.print([JSON.stringify({ ok: true, ...view }, null, 2)]);
    return 0;
  }
  io.print(positionsText(view));
  return 0;
}
