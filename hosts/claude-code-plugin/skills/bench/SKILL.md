---
name: bench
description: Run primerkit's comprehension benchmark on a model the user picks, with reading tests on frozen PreReason briefings as markdown, as JSON and with no data, scored by code. Use when the user asks to benchmark or compare how well a model reads the briefings.
---

1. Ask the user which model to test if they have not said, and warn them it takes 45 answers at three runs.
2. Call primerkit's `bench_next` with that model's id. It returns one packet and its key.
3. Answer each packet in a fresh context: start a subagent with that model pinned, give it the packet text as it is, and ask for its reply only. Never answer a packet yourself in this conversation, and never give the subagent anything but the packet.
4. Call `bench_record` with the key and the subagent's reply, exactly as it came.
5. Repeat until `bench_next` returns the result, then show it as it is. Up to five subagents may run at once.
