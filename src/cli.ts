import fs from "node:fs";
import path from "node:path";
import { runAutomaticOnce } from "./auto";
import { backtest, loadCsv, type BacktestConfig } from "./backtest";
import { placeOrder, type OrderInput } from "./ibkr";

type CliArgs = Record<string, string | true>;

function argsToObject(argv: string[]): CliArgs {
  const result: CliArgs = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (!argv[i].startsWith("--")) continue;
    const key = argv[i].slice(2);
    result[key] = argv[i + 1]?.startsWith("--") ? true : argv[i + 1] || true;
    if (result[key] !== true) i += 1;
  }
  return result;
}

function printReport(report: ReturnType<typeof backtest>): void {
  const money = (value: number) => `€${value.toFixed(2)}`;
  const pct = (value: number) => `${value.toFixed(2)}%`;
  console.log(`Backtest: ${report.startDate} → ${report.endDate}`);
  console.log(`Platform: ${report.platform}`);
  console.log(
    `Capital: ${money(report.startingCapital)} → ${money(report.finalEquity)} (${pct(report.returnPct)})`,
  );
  console.log(
    `Net profit: ${money(report.netProfit)} | fees: ${money(report.totalFees)} | max drawdown: ${pct(report.maxDrawdownPct)}`,
  );
  console.log(
    `Trades: ${report.trades} | wins: ${report.wins} | losses: ${report.losses} | win rate: ${pct(report.winRatePct)}`,
  );
  console.log(
    `Approx. annualized return: ${pct(report.annualizedReturnPct)} | buy-and-hold: ${pct(report.buyAndHoldPct)}`,
  );
  if (report.tradeLog.length) {
    console.log("\nTrade log:");
    for (const trade of report.tradeLog) {
      console.log(
        `  ${trade.entryDate} → ${trade.exitDate} | ${trade.reason} | net ${money(trade.netPnl)} | fees ${money(trade.fees)}`,
      );
    }
  }
}

function printOrderResult(
  result: Awaited<ReturnType<typeof placeOrder>>,
): void {
  console.log(JSON.stringify(result, null, 2));
  if (result.mode === "what-if preview only") {
    console.log(
      "\nPreview only. No order was submitted. Live submission also requires LIVE_TRADING_ENABLED=true, --live, and the exact order confirmation phrase.",
    );
  }
}

function stringArg(args: CliArgs, key: string): string {
  return typeof args[key] === "string" ? (args[key] as string) : "";
}

function parseOrderArgs(args: CliArgs): OrderInput {
  const symbol = stringArg(args, "symbol").toUpperCase();
  const sideValue = stringArg(args, "side").toUpperCase();
  const quantity = Number(stringArg(args, "quantity"));
  const limitPrice = Number(stringArg(args, "limit-price"));
  const conid = stringArg(args, "conid") || undefined;
  if (!/^[A-Z0-9.-]{1,16}$/.test(symbol))
    throw new Error("Provide a valid stock --symbol");
  if (sideValue !== "BUY" && sideValue !== "SELL")
    throw new Error("--side must be BUY or SELL");
  const side = sideValue;
  if (
    !Number.isFinite(quantity) ||
    quantity <= 0 ||
    !Number.isInteger(quantity)
  ) {
    throw new Error("--quantity must be a positive whole number of shares");
  }
  if (!Number.isFinite(limitPrice) || limitPrice <= 0)
    throw new Error("--limit-price must be a positive number");
  if (conid && !/^\d+$/.test(conid))
    throw new Error("--conid must be a numeric IBKR contract ID");
  if (args.live && args.live !== true)
    throw new Error("--live is a flag and takes no value");
  const confirmationValue = args["confirm-live-order"];
  if (confirmationValue && confirmationValue === true)
    throw new Error("--confirm-live-order requires the exact order phrase");
  if (confirmationValue && !args.live)
    throw new Error("--confirm-live-order requires --live");
  return {
    symbol,
    side,
    quantity,
    limitPrice,
    conid,
    submit: args.live === true,
    confirmation:
      typeof confirmationValue === "string" ? confirmationValue : undefined,
  };
}

async function main(): Promise<void> {
  const [, , command, ...argv] = process.argv;
  if (command === "place-order") {
    const args = argsToObject(argv);
    try {
      const result = await placeOrder(parseOrderArgs(args));
      printOrderResult(result);
    } catch (error) {
      console.error(
        `Order command failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      process.exitCode = 1;
    }
    return;
  }
  if (command === "auto-trade") {
    const args = argsToObject(argv);
    const symbol = stringArg(args, "symbol").toUpperCase();
    const equity = Number(stringArg(args, "equity"));
    const conid = stringArg(args, "conid") || undefined;
    const configPath = path.resolve(
      stringArg(args, "config") || "config/default.json",
    );
    const config = JSON.parse(
      fs.readFileSync(configPath, "utf8"),
    ) as BacktestConfig;
    if (!/^[A-Z0-9.-]{1,16}$/.test(symbol))
      throw new Error("Provide a valid stock --symbol");
    if (conid && !/^\d+$/.test(conid))
      throw new Error("--conid must be a numeric IBKR contract ID");
    if (!Number.isFinite(equity) || equity <= 0)
      throw new Error(
        "--equity is required and must be positive in the contract currency",
      );
    if (args.live && args.live !== true)
      throw new Error("--live is a flag and takes no value");
    if (args.watch && args.watch !== true)
      throw new Error("--watch is a flag and takes no value");
    const confirmation = stringArg(args, "confirm-auto-trading");
    if (args.live && confirmation !== `ENABLE AUTO TRADING ${symbol}`) {
      throw new Error(
        `Live automation requires --confirm-auto-trading "ENABLE AUTO TRADING ${symbol}"`,
      );
    }
    if (!args.live && confirmation)
      throw new Error("--confirm-auto-trading requires --live");
    const options = {
      symbol,
      equity,
      config,
      conid,
      submit: args.live === true,
    };
    const runOnce = async () => {
      const result = await runAutomaticOnce(options);
      console.log(JSON.stringify(result, null, 2));
      return result;
    };
    try {
      await runOnce();
      if (args.watch) {
        console.log(
          "Watching for new completed daily bars; press Ctrl+C to stop.",
        );
        while (true) {
          await new Promise((resolve) => setTimeout(resolve, 5 * 60 * 1000));
          await runOnce();
        }
      }
    } catch (error) {
      console.error(
        `Automatic strategy failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      process.exitCode = 1;
    }
    return;
  }
  if (command !== "backtest") {
    console.error(
      'Usage:\n  node dist/src/cli.js backtest --data data/file.csv --config config/default.json [--json]\n  node dist/src/cli.js place-order --symbol AAPL --side BUY --quantity 1 --limit-price 200 [--conid IBKR_CONID] [--live --confirm-live-order "SUBMIT AAPL BUY 1 LMT 200"]\n  node dist/src/cli.js auto-trade --symbol AAPL --equity 10000 --config config/default.json [--watch] [--live --confirm-auto-trading "ENABLE AUTO TRADING AAPL"]',
    );
    process.exitCode = 1;
    return;
  }
  const args = argsToObject(argv);
  const configPath = path.resolve(
    stringArg(args, "config") || "config/default.json",
  );
  const dataPath = path.resolve(stringArg(args, "data") || "data/sample.csv");
  const config = JSON.parse(
    fs.readFileSync(configPath, "utf8"),
  ) as BacktestConfig;
  const report = backtest(loadCsv(dataPath), config);
  if (args.json) console.log(JSON.stringify(report, null, 2));
  else printReport(report);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
