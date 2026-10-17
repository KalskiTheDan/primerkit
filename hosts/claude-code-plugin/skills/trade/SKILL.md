---
name: trade
description: Place one stock order the user asked for through Robinhood's own server, after primerkit records it as an intent and the user approves that intent at a terminal. Use when the user types an order, or asks to act on rules they wrote, and Robinhood's server is connected. Real money, in Robinhood's separate agent account.
---

This is real money: an order placed through Robinhood's server is a real order in the user's Robinhood agent account, and its losses are real. Nothing here is investment advice, and you never propose a strategy, a symbol, a side or a size.

An order comes from one of two places, and from nowhere else:
- an order the user typed, such as "buy 2 AAPL at market"; or
- rules the user wrote, which name the order. Quote the rule you apply.

If the user asks what to buy or sell, or asks you to decide, say you do not choose trades, and stop.

1. Call primerkit's `status`. If Robinhood is off there, say Robinhood is not connected (in a terminal: `primerkit connect robinhood --host <app>`) and stop. If the user wants market context, answer it through primerkit's `ask` skill as its own answer. Never give a briefing, a reading or a trend as the reason for an order.
2. Call `intent_record` with the symbol, side, quantity, order type (and limit price for a limit order) and `source` (`typed` or `rules`, with the rules' name). It keeps the intent as pending and sends nothing.
3. Tell the user the intent id, and ask them to run `primerkit intent approve <id>` in a terminal and type yes there. Wait for them.
4. Call `status` with `intent_id`. Go on when it reads `approved`. If it reads `pending`, wait for the user; if `expired`, start again at step 2. Place nothing on any other state.
5. Call Robinhood's review or preview tool for exactly that order (for a stock, `review_equity_order`), and show the user what Robinhood returns, as it is.
6. Ask the user in this chat whether to place it, and wait for their yes. Then call Robinhood's order tool once, for exactly the approved symbol, side, quantity and type. Robinhood's own trade approvals then ask in its app; tell the user to approve it there.
7. One approved intent is one order. A change to the symbol, side, quantity or type is a new intent, from step 2.

Never tell the app to always allow an order tool, and never turn Robinhood's trade approvals off. Crypto is not placed through this skill. Never put the user's holdings, orders or account details into any PreReason call: its tools take briefing ids, metric ids and dates.
