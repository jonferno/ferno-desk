# FERNO DESK: a self-hosted perp research desk

Read-only research over Hyperliquid and GMX v2 perps. It screens trader wallets, replays the last 48
hours of their fills to work out what they actually built, charts price with a MACD pane, and can post
fill alerts to a Discord webhook. No wallet, no keys, no orders. Nothing here trades.

The public demo at <https://ferno.fun/hl/> is a frozen snapshot of the same UI, Hyperliquid only.

![Wallet view: equity timeline with range chips, positions rebuilt from the last 48h of fills, paged trade list](docs/screenshot-wallet.jpg)

## What it does

**Screener.** Pulls the Hyperliquid leaderboard, then checks the 400 largest accounts against four
tests over the last 30 days: active in the last 48h, green days at 48% or more, no single day worth
more than 70% of profit, and a worst day better than -30% of equity. Wallets that pass are listed as
consistent; wallets that fail exactly one test are listed as near misses with the test they failed,
so the board still shows the interesting ones. Equity floor is $10k, and the 30-day P&L and ROI on the
board are the live figures, the same ones the favourites card shows.

**Wallet page.** Equity timeline with 24h/7d/30d/all ranges, the explorer link, the position table and
the 48h trade list. The curve merges every portfolio window Hyperliquid returns (day, week, month,
all time) so the last day is not a single point. Positions are rebuilt from the last 48h of fills only,
with average-cost accounting,
so "size 500 entered at 2,719" from a trade three weeks ago does not show up as a current position.
Each row carries the venue's leverage; the percent is the unlevered price move, and hovering it shows the
return on margin. The venue's own total is kept as a hover hint when it differs. Trades page 50 at a time.

**Chart.** Alphabetical, searchable token picker; blue up / orange down candles; a measure tool you
arm with a button and finish with two clicks; MACD 12/26/9 plus a zero-lag band aligned to the price
pane. Star any token to keep it: stars show at the top of the picker and as chips above the chart, so
the handful of coins you actually trade are one click away.

**Favourites.** Star any wallet, on both venues. Its card carries the same numbers as the leaderboard
plus its newest fill and how that position is doing right now. Both venues take their own Discord
webhook from the FAVOURITES tab: each alert is an embed with the coin logo, price, notional, fill count
and links to that venue's chart and the wallet, folded to one message per wallet per 15 minutes so a
burst does not spam the channel.

**GMX venue.** A switch in the header swaps the whole desk to GMX v2 on Arbitrum. The board is built
from the venue's own `periodAccountStats` rows, so PnL and ROI match app.gmx.io: PnL is realised PnL,
and ROI is net realised PnL after fees, price impact and positive funding, over the capital used in
the window. Rows carry win/loss with a hit rate, average leverage, 48h fills and the window's trade count,
every column sorts, and the same star as the Hyperliquid side saves a wallet to a GMX favourites tab. The wallet
page reads live positions from the GMX API (entry, mark, liquidation, leverage, collateral and PnL)
and the last 48 hours of executed trades from `/trades/search`. Because GMX publishes no account value
history, the wallet chart is cumulative realised PnL over 30 days from the day-level `accountStats` rows,
not an equity curve. Windows are 7d and 30d, day aligned because GMX's resolver only accepts UTC
midnight. The chart tab reads `/prices/ohlcv` and runs the same zero-lag band and MACD as the
Hyperliquid side, with the same measure tool.

**Passcode gate.** Set `SITE_PASSCODE` and every page and `/api/*` route needs it, with an HttpOnly
HMAC cookie and a 10-attempt / 10-minute lockout. Leave it empty to run open on your own box.

## Quick start

```bash
npm install
npm run dev
```

That starts the engine on `http://localhost:8899` and Vite on `http://localhost:5173` with `/api`
proxied to the engine. Open the Vite port while developing.

Production:

```bash
npm run build
SITE_PASSCODE=choose-something npm start
```

`npm run build` writes the static bundle to `dist/`, which the engine serves itself. The whole app
then lives on one port, `8899` by default.

## Configuration

| Variable | Default | What it does |
|---|---|---|
| `PORT` | `8899` | Port the engine listens on |
| `DATA_DIR` | `./data` | Where the follow list, favorites, webhook and screener cache are written |
| `SITE_PASSCODE` | empty | Gate for the whole app. Empty means no gate |

`DATA_DIR` is created on demand. Back it up if you care about your follow list.

## How it gets data

Public Hyperliquid endpoints only, no account or API key:

- `POST https://api.hyperliquid.xyz/info` with `leaderboard`, `clearinghouseState`,
  `userFillsByTime`, `userFills`, `candleSnapshot`, `allMids`, `meta`, `spotMeta`
- `https://stats-data.hyperliquid.xyz/Mainnet/leaderboard` for the address list

The engine refreshes the board every 10 minutes and caches wallet, chart and stats responses, so a
page view rarely hits the API twice. Hyperliquid returns 429 under load; the caches absorb it and a
failed lookup falls back to the last good copy.

GMX uses its public API plus the Subsquid index, no key either:

- `https://arbitrum.gmxapi.io/v1` (peer `.ai`) for `/markets/info`, `/positions`, `/trades/search`
  and `/prices/ohlcv`. Trade routes intermittently answer 500 after ten seconds, so every call is
  retried across both hosts.
- `https://gmx.squids.live/gmx-synthetics-arbitrum:prod/api/graphql` for the board's
  `periodAccountStats`. The indexer rejects non-browser user agents, so the client sends a browser
  one; money is 30-decimal fixed point on both sources.

Two data rules worth knowing:

- `pnlHistory` is cumulative, so daily figures come from differences, never raw points.
- ROI is chained from the account's own equity and pnl samples, not `pnl / current equity`. The
  plain ratio reads 400% on a wallet that just withdrew most of its money; chaining keeps deposits
  and withdrawals neutral.
- Hyperliquid throttles by IP. A wallet request that still fails after retries falls back to the
  last good copy, and the page says how old it is.
- Spot fills arrive with asset ids like `@272`. They are mapped through `spotMeta` to `UZEC/USDC`
  and friends before display.

## Hosting it for real

`deploy/` has a systemd unit and an nginx server block. The short version: build, run
`node_modules/.bin/tsx src/server/index.ts` under a service user with `SITE_PASSCODE` in the unit,
and reverse proxy to `127.0.0.1:8899`.

The gate is a passcode over plain HTTP unless you put TLS in front of it, in which case the passcode
stops strangers rather than a determined snoop. Put TLS in front.

## Limits

- Read-only by design. There is no order path in this codebase and adding one is on you.
- The 48h position window is deliberately short. A position opened earlier shows only the fills
  inside the window, which is why the venue total is kept beside it.
- Funding, fees and liquidations are not modelled.
- Not financial advice. A wallet that looks consistent for 30 days is a wallet that looked
  consistent for 30 days.

## License

MIT. See `LICENSE`.
