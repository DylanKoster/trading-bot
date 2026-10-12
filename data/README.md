# Data files

## `ibkr-aapl-daily.csv`

Five daily AAPL bars copied from the response example in Interactive Brokers' official TWS API documentation for `get_historical_data()`. The example shows regular daily OHLC bars and volume for 13–17 October 2025. Values are in USD; dates are exchange session dates. This is a short broker-data sample, not a complete history, and it is too short for this project's default 40-bar backtest requirement.

Source: [Interactive Brokers TWS API — `get_historical_data()`](https://www.interactivebrokers.com/docs/tws-api/sync-doc/historical-market-data)

## `sample.csv`

Synthetic smoke-test data for the backtest engine. It is not market data.

For a longer broker export, use the same `date,open,high,low,close,volume` columns. Confirm whether the broker's prices are split-adjusted and whether volume is reported in shares before using the file in research.
