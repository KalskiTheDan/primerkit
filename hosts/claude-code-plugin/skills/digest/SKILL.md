---
name: digest
description: What changed across the user's PreReason watchlist since the last digest, each change cited to its briefing line and checked by primerkit on this machine. Use when the user asks for the digest or what changed since yesterday.
---

1. Call primerkit's `prepare_operation` with operation `digest`. If it returns the finished digest, show it as it is.
2. Otherwise write one change for each item in the packet's diff block, by the primer's rules, in the JSON it asks for.
3. Call `submit_response` with the run id and your JSON. If it returns failures, fix them once and submit again.
4. Show the digest it returns as it is.

Never put the user's holdings, orders or account details into any PreReason call. Its tools take briefing ids, metric ids and dates only.
