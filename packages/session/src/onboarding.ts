// The words of the setup's panels and the launchpad.

// The no-advice line, on the launchpad and through the setup.
export const NO_ADVICE = 'Nothing here is investment advice, and the model never proposes a strategy.';

// Each step of the setup as two strips: what you do there, and what the agent does.
export const ONBOARDING: ReadonlyArray<{ you: string; agent: string }> = [
  { you: 'Pick where your model runs: an AI app, a key, or a model on this machine.', agent: 'Looks for apps, keys and local models here, then checks whether the model you pick answers and cites correctly.' },
  { you: 'Approve primerkit in your browser. A free account needs no card.', agent: "Collects its key itself and reads the key's tier. There is nothing to copy." },
  { you: 'Pick a question, or type your own.', agent: "Reads the briefings that answer it, ties each figure to a line, and primerkit's code checks the answer." },
  { you: 'Choose a time for a morning digest, or leave it for now.', agent: 'Shows the entry it adds to the scheduler before adding it, then each morning compares your briefings with the day before.' },
];
