# Cost-aware trend-pullback strategy

This project is a research bot with an optional, explicitly gated Alpaca automatic execution runner. It evaluates daily bars, places strategy orders only when live mode is enabled, and tracks the positions and orders it opened. It does not promise profits. Backtests are hypothetical: historical data can be wrong, markets change, and live execution adds spreads, latency, partial fills, taxes, and outages.

## Design goal

The strategy is deliberately long-only and low-turnover. It is intended for a beginner using unleveraged stocks first, with spot crypto as an optional higher-risk experiment. The automatic stock scanner can hold a diversified basket, risks a fixed fraction of equity per position, and refuses to open a position when the fee-adjusted order cannot fit the cash/buying-power budget.

## Entry

On a daily close, the strategy schedules a buy for the next bar's open when all conditions hold:

1. 10-day EMA is above the 30-day EMA: the primary trend is up.
2. RSI(14) is between 45 and 68: momentum is positive but not yet extremely extended.
3. ATR(14) exists: volatility is available for sizing and the stop.

The next-open execution avoids look-ahead bias from using a closing price that was not known at order time.

## Exit and risk

- Initial stop: entry price minus 2.5 ATR.
- Trailing stop: the highest closing price since entry minus 2.5 ATR. It only moves upward.
- Indicator exit: schedules an exit for the next open if the fast EMA falls below the slow EMA or RSI reaches 74.
- Position sizing: the smaller of (a) `riskPerTrade` of current equity divided by the ATR stop distance, (b) `maxPositionPct` of equity, and (c) the remaining portfolio/buying-power budget. The default automatic stock configuration allows up to 95% total long allocation across at most 10 positions, with a 10% per-position cap. Stocks are whole-share by default; crypto can use decimals.
- No leverage, shorting, pyramiding, or overnight financing is modeled.

## Fees and execution assumptions

Every buy and sell includes the configured platform fee and price slippage. A monthly platform fee, if configured, is charged on the first bar of each calendar month. The default stock profile estimates zero commission for Alpaca US equity orders. The default crypto profile uses Kraken Pro spot entry-tier taker pricing: 0.80%; maker pricing is available as a separate profile.

The model uses a conservative taker-like assumption for market/open and stop fills. It does not assume maker rebates, tax treatment, dividends, bid/ask spread beyond the slippage setting, or favorable partial fills.

## What to validate before risking money

Run the strategy on multiple symbols and market regimes, keep a true out-of-sample period, vary fees/slippage, and compare with buy-and-hold. Paper trade for long enough to observe rejected orders, data gaps, and execution differences. If a result is only profitable before fees or only on the supplied sample, it is not evidence of a durable edge.
