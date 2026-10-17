---
name: ask
description: Answer a market question from PreReason briefings and metrics, with every claim cited to a numbered line and checked by primerkit on this machine. Use when the user asks where Bitcoin, liquidity, rates, macro or cross asset conditions stand, now or on one past day.
---

1. Call primerkit's `prepare_operation` with operation `ask` and the user's question. If it returns a catalog instead of a packet, pick up to three briefings or metrics that fit and call it again with their ids, briefings as `briefings` and metrics as `metrics`. If the question asks how things stood on one past day, such as last Friday, work that day out and pass it as `date` (YYYY-MM-DD); a metric is read as it stands now only, so pick briefings for a past day.
2. Read the packet's primer, then its lines. Answer by the primer's rules only, in the JSON it asks for.
3. Call `submit_response` with the run id and your JSON. If it returns failures, fix them once and submit again.
4. Show the rendered answer it returns as it is, sources included.

Never put the user's holdings, orders or account details into any PreReason call. Its tools take briefing ids, metric ids and dates only.
