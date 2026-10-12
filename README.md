# Dutch fee-aware trading bot

A TypeScript trading bot for historical backtesting and automatically generated, separately gated Interactive Brokers stock orders.

This is not financial advice and it does not guarantee profit. Backtests remain offline. Live orders require a logged-in local IBKR Client Portal Gateway session, the live kill switch, and explicit command-line confirmation; the program does not store brokerage passwords or API credentials.

## Requirements

- Node.js 18 or newer
- Run `npm install` to install the TypeScript build tools
- A CSV with `date,open,high,low,close` and optional `volume`

There are no runtime dependencies; the TypeScript compiler and Node.js type declarations are development dependencies.

## Run it

```bash
npm install
npm run build
npm test
npm run backtest
node dist/src/cli.js backtest --data path/to/daily.csv --config config/default.json
node dist/src/cli.js backtest --data path/to/daily.csv --config config/default.json --json
```

## IBKR order entry

This command sends one user-specified stock limit order per invocation. It does not run the strategy continuously or manage protective stops. It requires the IBKR Client Portal Gateway running locally, with a user-authenticated session and real-time market-data access. IBKR requires browser authentication for the gateway, and its session needs regular reauthentication; see [IBKR gateway setup](https://ibkrcampus.com/docs/web-api/authentication/cpgw/installation-authentication) and [API order documentation](https://ibkrcampus.com/docs/web-api/v1/endpoints/orders/place-order).

Set the account and local gateway address in the shell. The gateway defaults to `https://localhost:5000/v1/api`:

```bash
export IBKR_ACCOUNT_ID=U1234567
export IBKR_BASE_URL=https://localhost:5000/v1/api
# Set only if you have installed a trusted local certificate for the gateway:
# export NODE_EXTRA_CA_CERTS=/path/to/gateway-ca.pem
```

The first command below requests an IBKR what-if preview and never submits an order:

```bash
node dist/src/cli.js place-order --symbol AAPL --side BUY --quantity 1 --limit-price 200
```

To submit, add `--live` and the exact order phrase. The account must be a live account; paper accounts are rejected for live submission.

```bash
export LIVE_TRADING_ENABLED=true
node dist/src/cli.js place-order --symbol AAPL --side BUY --quantity 1 --limit-price 200 \
  --live --confirm-live-order "SUBMIT AAPL BUY 1 LMT 200"
```

Safety behavior:

- Orders are single-stock, whole-share, regular-hours DAY limit orders. Market orders, crypto, short sales, and fractional shares are not supported.
- Live submission also requires `LIVE_TRADING_ENABLED=true`; leave it unset for preview-only use.
- The default maximum order value is 1,000 in the instrument's quote currency. Adjust it deliberately with `LIVE_MAX_ORDER_NOTIONAL` if needed.
- If IBKR returns multiple matching stock contracts, pass the intended numeric contract ID with `--conid`.
- The adapter checks for a real-time quote no older than 15 seconds and blocks delayed, frozen, or missing quotes.
- IBKR's what-if preview runs before submission. If it returns a warning, the adapter stops. If the order endpoint asks for an additional confirmation, the adapter does not accept it automatically.
- If the network fails during submission, check the IBKR order list before retrying; the broker may have received the order even when the client did not receive its response.
- TLS certificate validation stays enabled. Configure the local gateway with a certificate trusted by Node.js if its default certificate is rejected; do not disable TLS verification.

The adapter uses the local [IBKR Client Portal Gateway](https://ibkrcampus.com/docs/web-api/authentication/cpgw/limitations-of-the-client-portal-gateway). Keep it on localhost and do not expose the gateway port to a network.

The included sample is deliberately small and synthetic. It is a smoke test for the engine, not evidence that the strategy makes money.

## Automatic strategy execution

The `auto-trade` command evaluates the configured daily strategy against two years of IBKR daily bars. It ignores the current, still-forming candle, saves the retrieved bars to `data/<symbol>-ibkr-daily.csv`, and acts once per completed session. It defaults to preview-only. `--watch` keeps the process running and checks for a new session every five minutes. Run it while the local gateway is authenticated and during regular US market hours so DAY limit orders can be submitted promptly.

Start with a preview; `--equity` is the sizing equity in the stock's quote currency (for example, USD for most US stocks):

```bash
node dist/src/cli.js auto-trade --symbol AAPL --equity 10000 --config config/default.json
```

To enable unattended live execution, leave the process running with the explicit live flag and symbol-specific confirmation. The live kill switch and order-notional cap still apply:

```bash
export LIVE_TRADING_ENABLED=true
node dist/src/cli.js auto-trade --symbol AAPL --equity 10000 --config config/default.json \
  --watch --live --confirm-auto-trading "ENABLE AUTO TRADING AAPL"
```

Automatic entries are whole-share DAY limit parent orders with an attached GTC ATR stop. Position size uses `riskPerTrade`, `maxPositionPct`, the ATR stop distance, the supplied equity, and `LIVE_MAX_ORDER_NOTIONAL` (default 1,000 in quote currency). Indicator exits cancel the attached stop and wait for IBKR to confirm cancellation before submitting a regular-hours DAY limit sell. A pending exit can leave the position without its stop until that sell fills, so check the printed exit status in IBKR. The runner will not manage positions it did not open, short positions, or ambiguous broker states. It persists order ownership and processed-bar state in `data/auto-<symbol>.json`; inspect IBKR orders and positions before clearing an `inFlight` marker after an interrupted or ambiguous API request.

The runner requires about two years of daily history, a real-time quote, and a live IBKR account for submission. If IBKR returns a warning, it stops for manual review. See IBKR's [historical market data](https://ibkrcampus.com/docs/web-api/v1/endpoints/market-data/historical-market-data) and [bracket-order](https://ibkrcampus.com/docs/web-api/v1/endpoints/orders/bracket-orders-oca-groups) documentation.

## Configure it

Copy `config/default.json` and change:

- `assetClass`: `stock` or `crypto`
- `platform`: a fee profile from `src/fees.ts`
- `startingCapital`: virtual starting cash in EUR
- `riskPerTrade`: equity fraction at risk per position
- `maxPositionPct`: maximum notional allocation
- `atrStopMultiple`, `slippageBps`, and indicator periods
- `allowFractionalShares`: set `true` for fractional stock sizing when the chosen venue and instrument support it

Example crypto config:

```json
{
  "assetClass": "crypto",
  "platform": "kraken_spot_taker",
  "startingCapital": 1000,
  "riskPerTrade": 0.005,
  "maxPositionPct": 0.2,
  "atrStopMultiple": 2.5,
  "slippageBps": 10,
  "indicators": { "fastEma": 10, "slowEma": 30, "rsiPeriod": 14, "atrPeriod": 14 }
}
```

## Platform choice for a Dutch beginner

The bot defaults to `ibkr_nl_tiered` for stocks because Interactive Brokers publishes a trading API and a Netherlands schedule with 0.05% tiered commission, €1.25 minimum, and €29 maximum per order at the first tier. For crypto, `kraken_spot_maker` and `kraken_spot_taker` model Kraken Pro's published entry-level spot fees of 0.40% maker and 0.80% taker; Kraken also publishes REST and WebSocket trading API documentation.

Trade Republic advertises €1 settlement cost for a single trade and no monthly card fee, and DEGIRO's January 2026 Netherlands schedule shows €1–€2 headline stock fees plus a €1 handling cost depending on venue. Their low manual-trading costs do not make them the default bot venue here: a bot needs a supported, documented trading API and the actual spread/order-routing behavior must be verified before live use.

Fee pages change. Re-check them before deploying:

- [Interactive Brokers stock commissions](https://www.interactivebrokers.com/en/pricing/commissions-stocks.php)
- [Kraken fee schedule](https://www.kraken.com/nl/features/fee-schedule)
- [Kraken API documentation](https://docs.kraken.com/api/)
- [Trade Republic Netherlands pricing](https://traderepublic.com/nl-nl)
- [DEGIRO Netherlands fee PDF](https://www.degiro.nl/data/pdf/Tarievenoverzicht.pdf)

The fee snapshots above were checked on 11 October 2026. They are not a substitute for the fee schedule shown in your account.

## Strategy

See [strategy.md](strategy.md) for the full custom strategy, sizing rules, exit logic, assumptions, and validation checklist. In brief, it is a long-only daily trend-pullback system using 10/30 EMA, RSI(14), ATR(14), next-open execution, a volatility stop, and fee-aware position sizing.

## Limitations and next steps

- Use survivorship-bias-resistant symbol lists and adjusted data that handles splits and dividends.
- Add a walk-forward/out-of-sample workflow before trusting parameters.
- Add spread, exchange holiday, partial-fill, and currency-conversion models.
- Automatic IBKR execution is daily-bar based and requires a continuously running local process for unattended operation; it does not guarantee fills or profit.
- Check Dutch tax obligations and instrument eligibility with a qualified adviser.
