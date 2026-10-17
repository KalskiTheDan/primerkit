# The comprehension benchmark, questions of 2026-09-25

`questions-2026-09-25.json` holds fixed questions and their key for the five free briefings: btc.pulse, btc.context, macro.snapshot, cross.correlations and btc.grid-stress, ten each. They come from PreReason's comprehension benchmark and were built from the briefings beside them, in `briefings-2026-09-25/`.

Each question has a kind (number, whole number, date, yes or no, choice), its unit, and a key: the answer and, for numbers, the tolerance allowed. Answers are scored by code, with no model judging.

The fitness check reads a slice: questions q01 to q07 on btc.pulse and btc.context, in markdown and in JSON.
