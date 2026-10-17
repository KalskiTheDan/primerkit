# Live trading: your broker's own server

This is real money: an order placed through any server on this page is a real order, and its losses are real. Nothing here is investment advice, and the model never proposes a strategy.

primerkit's own orders go to Alpaca's paper API, and no code in primerkit sends a live order. If you want an AI app to see or trade a live account, the brokers below publish MCP servers of their own. You connect your own account to your own AI app with the broker's software, under the broker's terms, and the broker's own confirmations and limits apply. For Robinhood, primerkit can add Robinhood's server to Claude Code or Codex for you, with a trade skill that asks your yes in primerkit before each order: see [Robinhood through primerkit](#robinhood-through-primerkit).

Trading through any of these brokers is your own decision, made in your own account. primerkit gives no advice, and primerkit itself places no order through any of these servers.

primerkit runs none of these servers and passes them nothing. It is not affiliated with, endorsed by or sponsored by any broker named here; each name is its owner's mark, used only to say whose software a section is about. Nothing here is investment advice, and nothing here picks a broker or a trade for you.

Each section points to the broker's own pages, as they read on 2026-10-14. Those pages are the authority and they change: read the broker's page before you act on a line here, and where this page and theirs differ, theirs is right. A page that could not be read that day is named as such, and nothing here stands in for what it says.

## Before you connect a live account

- **Start where no money moves.** Use the broker's paper, sandbox or simulated mode first, where it has one. The table says which do, and what each does when you set nothing.
- **An AI app with an order tool acts as you.** Two of these servers, Kraken's and tastytrade's, ask for an acknowledgement or a token before an order, and their own pages say the model supplies it, not you. The approval that is yours is your AI app's own question before a tool call: keep it on for every order tool, and do not tell the app to allow those tools always.
- **Give the least a job needs.** Read only tools or scopes for looking; trading scope only when you mean to trade; never a scope that can withdraw.
- **Keys stay out of chats.** Put them where the broker says (your AI app's `env` block for that server, the broker's own config file, the system's secret store), never in a message to a model.
- **Set limits at the broker,** where a model cannot change them: order size caps, allowed symbols, key permissions, the broker's own approval setting.
- **What an order does is yours.** An order placed through one of these servers is a real order in your account, and often cannot be undone. Robinhood's pages, for one, say you are ultimately responsible for the trades your agent places.
- **An instruction on a web page is not from you.** One broker's site carries a block to copy and send to an AI, and the file it points to tells the agent that installing the broker's software "must run before any other action". If your AI app reads such a page, have it ask you first. Install a broker's software yourself, from the broker's own site.

## At a glance

| Broker | Its server | Runs | Paper or sandbox | With nothing set | What stands before an order |
|---|---|---|---|---|---|
| Alpaca | `alpaca-mcp-server` | on your machine | yes | paper | nothing in the server; pick toolsets, and review in your AI app |
| Kraken | `kraken mcp`, in the Kraken CLI | on your machine | yes, with no key | no live order tool is on | live services are off until named; an acknowledgement the model passes |
| tastytrade | `tastytrade-mcp` | on your machine | a sandbox | **production** | a dry run token the model fetches; a read only switch; a size cap |
| Interactive Brokers | a connection for Claude, ChatGPT or Grok, set up in Client Portal | not read | not read | the account you select | the AI writes an instruction; you submit or reject it in an IBKR application |
| Robinhood | a hosted address | at the broker | none found | **real trades**, in a separate account | approvals are **off** for outside agents until you turn them on |
| Webull | a hosted address, and a server on your machine | both | the local one has a sandbox | hosted: instructions; local: sandbox by its documented default | hosted: you confirm each instruction in Webull's app or desktop platform; local: caps and a preview |
| Moomoo | a hosted address | at the broker | not in its MCP pages read | not said on its MCP pages | scopes you grant; trading takes the `trade:write` scope and your trade password |

## Alpaca

- **Its server:** [alpacahq/alpaca-mcp-server](https://github.com/alpacahq/alpaca-mcp-server), MIT licensed, described on Alpaca's documentation site: [Trading API MCP](https://docs.alpaca.markets/us/docs/trading-api-mcp). It runs on your machine.
- **Setup, as Alpaca gives it:** Python 3.10 or later and `uv`. The server is started as `uvx alpaca-mcp-server`, with `ALPACA_API_KEY` and `ALPACA_SECRET_KEY` in your AI app's `env` block for it. For Claude Code, Alpaca's pages give `claude mcp add alpaca --scope user --transport stdio uvx alpaca-mcp-server` with the two keys passed as `--env`; a key typed on a command line stays in your shell's history, which the `env` block in the app's own settings file avoids. Its documentation page names Claude Desktop, Claude Code, Cursor, VS Code, Gemini CLI and PyCharm. Its README adds ChatGPT and Claude Mobile, each through a remote server, which it advises against exposing publicly.
- **Paper:** yes, and it is the default. `ALPACA_PAPER_TRADE` is `true` unless you set it to `false`, and live trading takes that and live API keys.
- **What limits it:** `ALPACA_TOOLSETS` picks which groups of tools the model gets, all of them unless you set it. The order and position tools are in its `trading` group, which Alpaca's read only example leaves out. Alpaca's pages describe no confirmation step in the server itself: its documentation says orders execute directly against its Trading API, and to review what the model proposes before you confirm it.
- **What it can place orders for:** stocks and ETFs, options and crypto.
- **Know this:** primerkit's own Alpaca connection is separate from this server. primerkit asks for paper keys at a terminal and reads no environment variable, so live keys kept under Alpaca's two variable names for this server are never sent by primerkit. Alpaca's README says version 2 of the server is a rewrite that does not carry over version 1's setup.

## Kraken

- **Its server:** part of the Kraken CLI, [krakenfx/kraken-cli](https://github.com/krakenfx/kraken-cli), MIT licensed, described at [docs.kraken.com/home/mcp](https://docs.kraken.com/home/mcp) and [docs.kraken.com/home/cli](https://docs.kraken.com/home/cli). It runs on your machine and is started with `kraken mcp`. Kraken's README calls the CLI experimental software and the MCP integration alpha; its MCP page says neither.
- **Setup, as Kraken gives it:** install the CLI from its releases. Kraken's README and CLI page give macOS and Linux, and Windows through WSL; its MCP page does not name WSL. Then add `kraken mcp` to your AI app. For Claude Code, Kraken's MCP page gives `claude mcp add --scope user kraken -- kraken mcp -s market,account,paper`. Its MCP page names Claude Code, Claude Desktop, Cursor, VS Code with GitHub Copilot, and Windsurf, and its README adds ChatGPT, Codex and Gemini CLI.
- **Paper:** yes, with no key and no account: a simulation on your machine against live prices, in the `paper` service. The `-s` flag picks the services. With no `-s`, Kraken's MCP page gives `market`, `account` and `paper`, and its README gives those with `workspace` and `feedback`, which it says uploads text to Kraken. Neither set holds a live order tool. `account` reads your real account when keys are set.
- **What limits it:** the live services (`trade`, `futures`, `funding`, `earn`, `subaccount`) are off until you name them with `-s`. Kraken marks them dangerous, and a call to one must carry `acknowledged: true` unless the server was started with `--allow-dangerous`. The model passes that field itself. Kraken's MCP page also says to use keys with the least permission, with position size limits and pair allowlists set on the key, and its README and CLI page give a dead man's switch that cancels orders after a timeout.
- **What it can place orders for:** crypto spot and margin, futures, forex pairs, and, outside the United States, tokenized stocks. With `funding` on and a key that allows it, it can also withdraw.
- **Know this:** the one example of an AI app's settings in Kraken's README starts the server with `-s all`, which turns every live service on, funding included, and its MCP page gives `-s all` for all services, live trading included. Name the services you mean.

## tastytrade

- **Its server:** [tastytrade/tastytrade-mcp](https://github.com/tastytrade/tastytrade-mcp), MIT licensed, described on tastytrade's developer site: [MCP Server](https://developer.tastytrade.com/docs/sdks-and-tools/mcp-server/). It runs on your machine; tastytrade hosts no address for it.
- **Setup, as tastytrade gives it:** Node.js 22 or later; clone the repository, `npm ci`, `npm run build`, then point your AI app at `dist/index.js` with `TASTYTRADE_CLIENT_ID`, `TASTYTRADE_CLIENT_SECRET` and `TASTYTRADE_REFRESH_TOKEN` in its `env` block. The three come from an OAuth application you make in your tastytrade profile. Its pages give full settings for Claude Desktop and Claude Code. Its two Claude Desktop examples differ: the README's sets `TASTYTRADE_ENV` to production, the developer page's to sandbox.
- **Sandbox:** yes, but **it is not the default.** With `TASTYTRADE_ENV` unset the server talks to production, which is real money. `TASTYTRADE_ENV=sandbox` selects the sandbox, which takes its own credentials, has no market data, and resets every day.
- **What limits it:** `TASTYTRADE_READ_ONLY=1` withholds every tool that changes anything. Placing or changing an order needs a token from a dry run of the same order, good for 60 seconds, and `MAX_ORDER_NOTIONAL_USD` caps an order's size (50,000 unless you lower it). tastytrade's own README says the token is not human approval: the model asks for it and uses it. Cancelling an order needs no token.
- **What it can place orders for:** tastytrade's pages read on 2026-10-14 do not list it. Its README's risk notice names securities, options and futures.
- **Know this:** tastytrade publishes its own disclosures for this server. Read them there: [MCP Server Disclosures](https://developer.tastytrade.com/disclosures/tastytrade-mcp-server-disclosures.pdf).

## Interactive Brokers

- **Its pages:** its [AI Integrations](https://www.interactivebrokers.com/en/trading/ai-integrations.php) page was not read (the site refused our reader) on 2026-10-14, so this section gives nothing from it: not the server's address, not its setup in other AI apps, not whether paper accounts can be used. Read that page yourself. What follows is from IBKR's [Client Portal guide](https://www.ibkrguides.com/clientportal/gen-ai-instructions.htm), which was read.
- **Setup, as the guide gives it:** you start from the AI Instructions tab in Client Portal (under Trade, then Orders and Trades), connect Claude, ChatGPT or Grok, and sign IBKR's agreements. The guide also names Perplexity. Where you hold more than one account, you select the account to grant access to.
- **Paper:** the guide does not say.
- **What limits it:** the AI writes an **instruction**, which is not binding. You review it in an IBKR application, on the AI Instructions tab, and choose Review & Submit or Reject. You revoke the access under Settings, Manage Third-Party Consents.
- **What an instruction can be for:** the guide does not say.

## Robinhood

- **Its server:** hosted by Robinhood at `https://agent.robinhood.com/mcp/trading`, described in its help centre: [Onboarding an external agent](https://robinhood.com/us/en/support/articles/agentic-trading-overview/) and [Trading with your agent](https://robinhood.com/us/en/support/articles/trading-with-your-agent/).
- **Setup, as Robinhood gives it:** for Claude Code, `claude mcp add robinhood-trading --transport http https://agent.robinhood.com/mcp/trading`, then `/mcp` to choose it and sign in. For the Codex CLI, `codex mcp add robinhood-trading --url https://agent.robinhood.com/mcp/trading`, then `/mcp`. Its page also gives the steps for Claude Desktop, ChatGPT, the Codex app, Cursor and Grok. Signing in opens a separate account for the agent. Trade approvals are off there until you turn them on, with the Trade approvals switch under Safety Controls in the agent's settings; turn it on before you put money in that account.
- **Paper:** none found on Robinhood's pages. Its trading page describes the order tools as placing real orders.
- **What limits it:** the agent can read all your Robinhood accounts and can trade only in its separate account. **Trade approvals are off by default for outside agents** (Robinhood's own built in agents start with them on). With approvals on, the agent proposes trades, and you review and place each one in the Robinhood app yourself. Every order shows in the Activity section of the agent's account and in your Robinhood history. Its tools include review and preview steps, such as `review_equity_order` and `preview_crypto_order`, beside the tools that place orders; its pages do not say a review must come first.
- **What it can place orders for:** long stock positions, options and crypto. Crypto through an agent is not offered in some states, New York among them, and takes a Robinhood Crypto account and your acceptance of its updated crypto agreement.
- **Know this:** Robinhood's pages say you are ultimately responsible for the trades your agent places, and that you take on the risk of trades AI agents carry out.

## Robinhood through primerkit

This is real money. An order your AI app places through Robinhood's server is a real order in Robinhood's separate agent account, and its losses are real. Nothing here is investment advice, and the model never proposes a strategy.

- **What primerkit adds:** `primerkit connect robinhood --host claude-code`, or `--host codex`, shows the change, then makes it on a yes you type at a terminal; no flag stands in for that yes. For Claude Code it runs `claude mcp add --scope user --transport http robinhood-trading https://agent.robinhood.com/mcp/trading`, the command Robinhood's page gives, at user scope as primerkit's own server is added. For Codex it adds a `[mcp_servers.robinhood-trading]` table with that address to `~/.codex/config.toml`, as `codex mcp add robinhood-trading --url` would. Beside it goes the `primerkit-trade` skill. `--remove` takes out what primerkit added, and leaves a Robinhood entry you made yourself.
- **What primerkit does not do:** it runs nothing of Robinhood's, signs in to nothing, and keeps no Robinhood key, password or account data. You sign in inside your AI app, with `/mcp`, which opens the separate agent account. primerkit sends no order to Robinhood: your AI app does, through Robinhood's server.
- **Before you put money in that account:** turn Trade approvals on, with the switch under Safety Controls in the agent's settings. They are off by default for outside agents. primerkit cannot see that switch, so it asks you to confirm you turned it on, and its Connections list says so where you have not.
- **The trade skill asks you to approve each order in primerkit, and Robinhood's trade approvals, once you turn them on, ask again in its app.** The skill records the order as an intent in primerkit's journal, pending (the `intent_record` tool). You approve it with `primerkit intent approve <id>`, typed at a terminal, within the hour it stands. The skill reads that it is approved, calls Robinhood's review or preview tool for that order, shows you what Robinhood returns, and asks your yes in the chat before it calls the order tool, once. One approved intent is one order.
- **Where an order comes from:** an order you typed, or rules you wrote that name it. The skill never proposes a symbol, a side or a size, and it never gives a briefing or a reading as the reason for an order.
- **What enforces primerkit's yes:** the trade skill. Robinhood's server sits beside primerkit in your AI app, not behind it, so primerkit cannot stop an app that calls Robinhood's order tool without an approved intent. Robinhood's trade approvals, and your AI app's own question before a tool call, are what stand in the way then: keep both on.
- **Keep your AI app's own question on:** the skill never tells it to always allow an order tool, and never turns Robinhood's trade approvals off.
- **What PreReason receives:** briefing ids, metric ids and dates, as before. Never your positions, orders or account data.
- **What it does not cover:** crypto, and any app but Claude Code and Codex. For those, follow Robinhood's own page.

## Webull

- **Its servers:** two. A hosted one at `https://api.webull.com/mcp` ([Webull Cloud MCP Server](https://developer.webull.com/apis/docs/AI-friendly-Resources/mcp/)), and an open source one that runs on your machine, [webull-inc/webull-openapi-mcp](https://github.com/webull-inc/webull-openapi-mcp), Apache 2.0 licensed ([Webull Local MCP Server](https://developer.webull.com/apis/docs/AI-friendly-Resources/local-mcp/)).
- **Setup, as Webull gives it:** hosted: Webull's page lists ChatGPT, Claude and Grok, and gives the address for apps that take a remote server, among them Codex (`codex mcp add webull --url https://api.webull.com/mcp`), Cursor, Kiro, Zed and Cherry Studio. You then sign in to Webull, choose the accounts, and grant the groups of tools it may use. Local: Python 3.10 or later and `uv`; the server is started as `uvx webull-openapi-mcp serve`, with `WEBULL_APP_KEY`, `WEBULL_APP_SECRET`, `WEBULL_REGION_ID` and `WEBULL_ENVIRONMENT` in your AI app's `env` block. The key and secret come from an application you register with Webull as a developer, and with two step verification on, a one time `uvx webull-openapi-mcp auth` is approved in Webull's app.
- **Sandbox:** the local server has one. `WEBULL_ENVIRONMENT` is `uat` for the sandbox or `prod` for live, and Webull documents `uat` as the default. **Every example on Webull's pages sets `prod`,** so copying an example gives you live trading. Webull's hosted page names no sandbox.
- **What limits it:** hosted: the order tools write instructions, each of which you confirm in Webull's app or desktop platform; no tool on its page places an order directly. Local: `WEBULL_TOOLSETS` picks the tool groups (`account,market-data` gives read only), `WEBULL_MAX_ORDER_NOTIONAL_USD` (10,000 unless you change it) and `WEBULL_MAX_ORDER_QUANTITY` (1,000 unless you change it) cap an order, `WEBULL_SYMBOL_WHITELIST` names the symbols allowed, and there are preview tools. Webull's pages describe no confirmation in its app for the local server; its README says to review an order before you confirm it in your AI app.
- **What it can place orders or instructions for:** stocks, options, futures, crypto and event contracts. The local server's README sets them by region: stocks in every region it lists, options and futures in the United States and Hong Kong, crypto and event contracts in the United States only.

## Moomoo

- **Its server:** hosted by moomoo at `https://mcp.moomoo.com/mcp`, described at [open.moomoo.com/mcp-docs](https://open.moomoo.com/mcp-docs/overview) and on [open.moomoo.com](https://open.moomoo.com/). Futu has the same at `https://mcp.futunn.com/mcp` ([open.futunn.com](https://open.futunn.com/)). moomoo's home page says "No API key needed", and that there is "no need to build your own gateway or manage keys".
- **Setup, as moomoo gives it:** for Claude Code, moomoo's home page gives `claude mcp add --transport http moomoo-mcp https://mcp.moomoo.com/mcp`, then `/mcp` to sign in; its quick start puts the name first, as `claude mcp add moomoo-mcp --transport http https://mcp.moomoo.com/mcp`. For Codex, `codex mcp add moomoo-mcp --url https://mcp.moomoo.com/mcp`. Its pages also give Claude Desktop, Cursor and OpenClaw. The first use opens moomoo's consent page in your browser.
- **Simulated trading:** its MCP pages do not mention it, and their list of tools could not be read as text on 2026-10-14: it loads only in a browser.
- **What limits it:** you grant scopes on the consent page. Reading takes only `quote:read` and `trade:read`, and `quote:write` is for your watchlist; placing and cancelling orders takes `trade:write` and your trade password. Leave `trade:write` out until you mean to trade. You can revoke a token from moomoo's dashboard.
- **What it can place orders for:** its MCP pages do not list it, and their list of tools could not be read as text on 2026-10-14. Their examples are stocks, and they say "certain markets or features may be limited by account tier or region".
- **Know this:** moomoo's home page carries a block to copy and send to an AI ("Install all moomoo Skills"). The file it points to tells the agent that installing moomoo's OpenD gateway "must run before any other action", and asks it to get your permission first. The hosted server needs no gateway: the same home page says there is "no need to build your own gateway". Do not let an AI app act on such a block; the last point under "Before you connect a live account" is about this. moomoo's own pages link to no GitHub repository for this server, so none is listed here.

## Using one of these beside primerkit

primerkit's routines give a label, such as watch, enter or exit, with the lines of data and of your rules that led to it. They never give a size or an order, and primerkit hands nothing to a broker's server. If you act on a label, you act: in your broker's app, or by telling your AI app what to do through the broker's server, with its confirmations in between. primerkit's own paper connection is described in the README under "Alpaca paper trading".
