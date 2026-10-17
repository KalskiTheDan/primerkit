// The words of the first run.

// The disclaimer as five short points, accepted once.
export const DISCLAIMER_POINTS: ReadonlyArray<readonly string[]> = [
  ['primerkit runs on this machine, with the model you choose.'],
  ['Your model and your primers make every decision.'],
  ['PreReason publishes the same general market briefings to everyone who', 'subscribes. It never sees your questions, answers, holdings or orders.'],
  ['Nothing here is investment advice.'],
  ['Broker connections stay off until you turn them on. Paper trading is', 'the default wherever the broker offers it.'],
];

// First questions a free key can answer, each with the free briefings that answer it. The
// demo's saved briefings answer every one of them too. Markets come first: Bitcoin is not
// the focus.
export interface FirstQuestion {
  question: string;
  briefings: string[];
}

export const FIRST_QUESTIONS: readonly FirstQuestion[] = [
  { question: 'What is the Treasury yield curve doing?', briefings: ['macro.snapshot'] },
  { question: 'Is net liquidity rising or falling?', briefings: ['macro.snapshot'] },
  { question: 'How is Bitcoin moving with stocks and the dollar?', briefings: ['cross.correlations'] },
  { question: 'Where does Bitcoin stand?', briefings: ['btc.context'] },
];

// Commands that later builds add. Typing one says so.
export const LATER_COMMANDS = ['/run', '/new', '/test', '/arms'];

// Commands this build runs, each listed in the menu that opens as / is typed; the help
// line under the input shows five of them.
export const COMMANDS = ['/digest', '/brief', '/chart', '/catalog', '/compare', '/bench', '/routine', '/journal', '/model', '/schedule', '/connect', '/help', '/clear', '/quit'];
export const HELP_LINE = ['/digest', '/bench', '/model', '/journal', '/help'];
