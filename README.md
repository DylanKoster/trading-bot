# Dutch fee-aware trading bot

A TypeScript research and trading bot with historical backtesting and guarded Alpaca stock order entry.

This is not financial advice and it does not guarantee profit. Backtests remain offline. Broker access uses Alpaca API keys; live orders require the live kill switch, an Alpaca live endpoint, and explicit command-line confirmation.

## Requirements

- Node.js 18 or newer
- Run `npm install` to install the TypeScript build tools
- A CSV with `date,open,high,low,close` and optional `volume`
- Alpaca API credentials for order entry and market data

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

## Alpaca order entry

The `place-order` command validates and sends one user-specified stock limit order per invocation. It does not run the strategy continuously or manage protective stops. The API defaults to Alpaca paper trading at `https://paper-api.alpaca.markets`; requests use Alpaca's Trading API and stock market data endpoints.

Set API credentials from your Alpaca account. Use paper credentials first:

```bash
export ALPACA_API_KEY=your_key_id
export ALPACA_SECRET_KEY=your_secret_key
```

Preview mode fetches the asset, account, and latest quote, checks the order limits, and prints the exact order payload. Alpaca does not provide the what-if endpoint used by the previous broker integration, so this is a local preview; it does not predict buying-power, regulatory, or broker-side order rejections.

```bash
node dist/src/cli.js place-order --symbol AAPL --side BUY --quantity 1 --limit-price 200
```

Live submission requires the live endpoint, the kill switch, `--live`, and the exact order phrase. Confirm live API access with Alpaca and change the endpoint only when ready:

```bash
export ALPACA_BASE_URL=https://api.alpaca.markets
export LIVE_TRADING_ENABLED=true
node dist/src/cli.js place-order --symbol AAPL --side BUY --quantity 1 --limit-price 200 \
  --live --confirm-live-order "SUBMIT AAPL BUY 1 LMT 200"
```

Safety behavior:

- Orders are single-stock, whole-share, regular-hours DAY limit orders. Market orders, crypto, short sales, and fractional shares are not supported.
- The default maximum order value is 1,000 in the instrument's quote currency. Adjust it with `LIVE_MAX_ORDER_NOTIONAL` if needed.
- The adapter checks for a valid latest IEX quote no older than 15 seconds and blocks missing or stale quotes.
- Sells are checked against the current long position. Live submission to an endpoint identified as paper is blocked.
- If the network fails during submission, inspect Alpaca's open orders before retrying; the broker may have received an order even when the client did not receive its response.
- TLS certificate validation stays enabled.

The included sample is deliberately small and synthetic. It is a smoke test for the engine, not evidence that the strategy makes money.

## Automatic strategy execution

The `auto-trade` command runs continuously and scans the `scanSymbols` candidate list in `config/default.json`. It manages existing bot positions first, then evaluates the remaining candidates and can submit multiple qualifying entries in one cycle. Portfolio allocation is capped by `maxPortfolioPct` and `maxOpenPositions`; each position is capped by `maxPositionPct` and the ATR risk budget. The default list is an editable starter universe, not a recommendation. It ignores the current, still-forming daily candle, uses account equity and broker buying power for sizing, and reserves capital for existing positions and open buy orders. It scans every five minutes by default and retries after temporary API errors. Press Ctrl+C to stop. This scanner uses the IEX bars and quotes already used by the bot; it does not call Alpaca's SIP-only most-active screener.

Preview mode does not submit orders:

```bash
node dist/src/cli.js auto-trade --config config/default.json
```

To submit orders to Alpaca paper trading, load your paper credentials and explicitly confirm paper mode. Alpaca uses separate paper and live credentials and API domains. [Alpaca authentication docs](https://docs.alpaca.markets/us/v1.1/docs/authentication-1)

```bash
set -a
. ./.env
set +a
export ALPACA_BASE_URL=https://paper-api.alpaca.markets
node dist/src/cli.js auto-trade --config config/default.json --paper \
  --confirm-auto-trading "ENABLE PAPER AUTO TRADING"
```

Live automation remains separately gated by `ALPACA_BASE_URL=https://api.alpaca.markets`, `LIVE_TRADING_ENABLED=true`, `--live`, and the explicit confirmation phrase:

```bash
export ALPACA_BASE_URL=https://api.alpaca.markets
export LIVE_TRADING_ENABLED=true
node dist/src/cli.js auto-trade --config config/default.json --interval-minutes 5 \
  --live --confirm-auto-trading "ENABLE AUTONOMOUS AUTO TRADING"
```

Automatic entries are whole-share DAY limit orders with an attached Alpaca OTO stop-loss order. Position size uses `riskPerTrade`, `maxPositionPct`, the configured portfolio budget, current account buying power, current account equity, and the ATR stop distance. There is no implicit automatic order-notional cap; set `AUTO_MAX_ORDER_NOTIONAL` when an additional per-order ceiling is desired. `LIVE_MAX_ORDER_NOTIONAL` is also honored for compatibility. Indicator exits cancel the attached stop and wait for Alpaca to confirm cancellation before submitting a regular-hours DAY limit sell. A pending exit can leave the position without its stop until that sell fills, so check the account when an exit is pending. The runner will not manage positions it did not open, short positions, or ambiguous broker states. It persists order ownership and processed-bar state in `data/auto-<symbol>.json`; reconcile Alpaca orders and positions before clearing an `inFlight` marker after an interrupted or ambiguous API request.

The runner requires about two years of daily history and a current quote. Alpaca's account permissions, market-data subscription, and asset availability determine whether a request can be served. Orders may be rejected or remain unfilled; preview mode cannot verify broker acceptance.

## Configure it

Copy `config/default.json` and change:

- `assetClass`: `stock` or `crypto`
- `platform`: a fee profile from `src/fees.ts`
- `startingCapital`: virtual starting cash in EUR
- `riskPerTrade`: equity fraction at risk per position
- `maxPositionPct`: maximum notional allocation
- `maxPortfolioPct`: maximum fraction of equity allocated across all long positions
- `maxOpenPositions`: maximum simultaneous positions, including pending entries
- `scanSymbols`: candidate stock symbols the strategy may choose among
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

The default stock fee profile estimates zero commission for Alpaca US equities. Actual fees and availability can depend on account, security, and regulatory charges. Kraken profiles model published Pro spot entry-tier fees; see [Kraken fees](https://www.kraken.com/nl/features/fee-schedule) and [Kraken API documentation](https://docs.kraken.com/api/).

## Strategy

See [strategy.md](strategy.md) for the custom strategy, sizing rules, exit logic, assumptions, and validation checklist. In brief, it is a long-only daily trend-pullback system using 10/30 EMA, RSI(14), ATR(14), next-open execution, a volatility stop, and fee-aware position sizing.

## Limitations and next steps

- Use survivorship-bias-resistant symbol lists and adjusted data that handles splits and dividends.
- Add a walk-forward/out-of-sample workflow before trusting parameters.
- Add spread, exchange holiday, partial-fill, and currency-conversion models.
- Automatic Alpaca execution is daily-bar based and requires a continuously running local process for unattended operation; it does not guarantee fills or profit.
- Check Dutch tax obligations and instrument eligibility with a qualified adviser.
