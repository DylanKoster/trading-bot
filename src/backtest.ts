import fs from "node:fs";
import { getFeeProfile, transactionFee } from "./fees";
import {
  buildIndicators,
  entrySignal,
  exitSignal,
  type Bar,
  type IndicatorSettings,
} from "./strategy";

export interface BacktestConfig {
  assetClass: "stock" | "crypto";
  platform: string;
  startingCapital: number;
  riskPerTrade: number;
  maxPositionPct: number;
  atrStopMultiple: number;
  slippageBps: number;
  allowFractionalShares?: boolean;
  scanSymbols?: string[];
  indicators: IndicatorSettings;
}

interface Position {
  entryDate: string;
  entryIndex: number;
  entryPrice: number;
  entryFee: number;
  quantity: number;
  cashBeforeEntry: number;
  highestClose: number;
  stop: number;
}

interface Trade {
  entryDate: string;
  exitDate: string;
  entryPrice: number;
  exitPrice: number;
  quantity: number;
  entryFee: number;
  exitFee: number;
  fees: number;
  grossPnl: number;
  netPnl: number;
  reason: string;
  barsHeld: number;
}

type PendingOrder =
  | { type: "entry"; atr: number | null }
  | { type: "exit"; reason: string };

export function parseCsv(text: string): Bar[] {
  const rows = text.trim().split(/\r?\n/).filter(Boolean);
  if (rows.length < 2)
    throw new Error("CSV must include a header and at least one data row");
  const header = rows[0].split(",").map((cell) => cell.trim().toLowerCase());
  const required = ["date", "open", "high", "low", "close"];
  for (const field of required) {
    if (!header.includes(field))
      throw new Error(`CSV is missing required column: ${field}`);
  }
  const index = (field: string): number => header.indexOf(field);
  const bars = rows.slice(1).map((line, rowNumber) => {
    const cells = line.split(",").map((cell) => cell.trim());
    const bar = {
      date: cells[index("date")],
      open: Number(cells[index("open")]),
      high: Number(cells[index("high")]),
      low: Number(cells[index("low")]),
      close: Number(cells[index("close")]),
      volume: header.includes("volume") ? Number(cells[index("volume")]) : null,
    };
    if (
      !bar.date ||
      [bar.open, bar.high, bar.low, bar.close].some(
        (value) => !Number.isFinite(value),
      )
    ) {
      throw new Error(`Invalid OHLC row ${rowNumber + 2}`);
    }
    if (
      bar.high < Math.max(bar.open, bar.close) ||
      bar.low > Math.min(bar.open, bar.close)
    ) {
      throw new Error(`OHLC values are inconsistent on row ${rowNumber + 2}`);
    }
    return bar;
  });
  bars.sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());
  return bars;
}

export function loadCsv(path: string): Bar[] {
  return parseCsv(fs.readFileSync(path, "utf8"));
}

function roundMoney(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

function applySlippage(
  price: number,
  side: "buy" | "sell",
  bps: number,
): number {
  const multiplier = 1 + (bps / 10000) * (side === "buy" ? 1 : -1);
  return price * multiplier;
}

export function backtest(bars: Bar[], config: BacktestConfig) {
  if (bars.length < 40)
    throw new Error(
      "Backtest needs at least 40 daily bars for the default indicators",
    );
  const profile = getFeeProfile(config.platform);
  const indicators = buildIndicators(bars, config.indicators);
  let cash = config.startingCapital;
  const positionState: { current: Position | null } = { current: null };
  let pending: PendingOrder | null = null;
  let peakEquity = cash;
  let maxDrawdown = 0;
  let previousMonth: string | null = null;
  const trades: Trade[] = [];
  const equityCurve: Array<{ date: string; equity: number }> = [];
  let totalFees = 0;

  const equityAt = (price: number): number =>
    cash + (positionState.current ? positionState.current.quantity * price : 0);

  const closePosition = (
    bar: Bar,
    rawPrice: number,
    reason: string,
    index: number,
  ): void => {
    const position = positionState.current;
    if (!position) return;
    const executionPrice = applySlippage(rawPrice, "sell", config.slippageBps);
    const notional = position.quantity * executionPrice;
    const fee = transactionFee(notional, profile);
    cash += notional - fee;
    totalFees += fee;
    trades.push({
      entryDate: position.entryDate,
      exitDate: bar.date,
      entryPrice: position.entryPrice,
      exitPrice: executionPrice,
      quantity: position.quantity,
      entryFee: position.entryFee,
      exitFee: fee,
      fees: position.entryFee + fee,
      grossPnl: (executionPrice - position.entryPrice) * position.quantity,
      netPnl:
        (executionPrice - position.entryPrice) * position.quantity -
        position.entryFee -
        fee,
      reason,
      barsHeld: index - position.entryIndex,
    });
    positionState.current = null;
    pending = null;
  };

  const openPosition = (
    bar: Bar,
    rawPrice: number,
    atrValue: number | null,
    index: number,
  ): void => {
    if (
      positionState.current ||
      typeof atrValue !== "number" ||
      !Number.isFinite(atrValue) ||
      atrValue <= 0
    )
      return;
    const executionPrice = applySlippage(rawPrice, "buy", config.slippageBps);
    const stopDistance = atrValue * config.atrStopMultiple;
    const riskBudget = equityAt(rawPrice) * config.riskPerTrade;
    const riskQuantity = riskBudget / stopDistance;
    const maxQuantity =
      (equityAt(rawPrice) * config.maxPositionPct) / executionPrice;
    let quantity = Math.min(riskQuantity, maxQuantity);
    if (config.assetClass === "stock" && !config.allowFractionalShares)
      quantity = Math.floor(quantity);
    quantity = Math.max(0, Number(quantity.toFixed(8)));
    if (quantity <= 0) return;
    const notional = quantity * executionPrice;
    const fee = transactionFee(notional, profile);
    if (cash < notional + fee) return;
    const cashBeforeEntry = cash;
    cash -= notional + fee;
    totalFees += fee;
    positionState.current = {
      entryDate: bar.date,
      entryIndex: index,
      entryPrice: executionPrice,
      entryFee: fee,
      quantity,
      cashBeforeEntry,
      highestClose: bar.close,
      stop: executionPrice - stopDistance,
    };
  };

  for (let i = 0; i < bars.length; i += 1) {
    const bar = bars[i];
    const month = bar.date.slice(0, 7);
    if (month !== previousMonth) {
      cash -= profile.monthly;
      totalFees += profile.monthly;
      previousMonth = month;
    }

    if (pending?.type === "exit" && positionState.current)
      closePosition(bar, bar.open, pending.reason, i);
    if (pending?.type === "entry" && !positionState.current)
      openPosition(bar, bar.open, pending.atr, i);
    pending = null;

    const currentPosition = positionState.current;
    if (currentPosition) {
      currentPosition.highestClose = Math.max(
        currentPosition.highestClose,
        bar.close,
      );
      const trailingStop =
        currentPosition.highestClose -
        (indicators.atr[i] ||
          currentPosition.entryPrice - currentPosition.stop) *
          config.atrStopMultiple;
      currentPosition.stop = Math.max(currentPosition.stop, trailingStop);
      if (bar.low <= currentPosition.stop) {
        const gapAwareStop = Math.min(bar.open, currentPosition.stop);
        closePosition(bar, gapAwareStop, "atr_stop", i);
      }
    }

    if (
      positionState.current &&
      i < bars.length - 1 &&
      exitSignal(indicators, i)
    ) {
      pending = { type: "exit", reason: "indicator_exit" };
    } else if (
      !positionState.current &&
      i < bars.length - 1 &&
      entrySignal(indicators, i)
    ) {
      pending = { type: "entry", atr: indicators.atr[i] };
    }

    const equity = equityAt(bar.close);
    peakEquity = Math.max(peakEquity, equity);
    maxDrawdown = Math.max(maxDrawdown, (peakEquity - equity) / peakEquity);
    equityCurve.push({ date: bar.date, equity });
  }

  if (positionState.current)
    closePosition(
      bars[bars.length - 1],
      bars[bars.length - 1].close,
      "end_of_data",
      bars.length - 1,
    );
  const finalEquity = cash;
  const netProfit = finalEquity - config.startingCapital;
  const winningTrades = trades.filter((trade) => trade.netPnl > 0);
  const dailyReturns = equityCurve
    .slice(1)
    .map((point, i) => point.equity / equityCurve[i].equity - 1);
  const mean = dailyReturns.length
    ? dailyReturns.reduce((sum, value) => sum + value, 0) / dailyReturns.length
    : 0;
  const variance =
    dailyReturns.length > 1
      ? dailyReturns.reduce((sum, value) => sum + (value - mean) ** 2, 0) /
        (dailyReturns.length - 1)
      : 0;
  const annualizedReturn =
    equityCurve.length > 1
      ? (finalEquity / config.startingCapital) **
          (252 / (equityCurve.length - 1)) -
        1
      : 0;
  return {
    assetClass: config.assetClass,
    platform: profile.label,
    startDate: bars[0].date,
    endDate: bars[bars.length - 1].date,
    startingCapital: roundMoney(config.startingCapital),
    finalEquity: roundMoney(finalEquity),
    netProfit: roundMoney(netProfit),
    returnPct: (netProfit / config.startingCapital) * 100,
    annualizedReturnPct: annualizedReturn * 100,
    totalFees: roundMoney(totalFees),
    maxDrawdownPct: maxDrawdown * 100,
    trades: trades.length,
    wins: winningTrades.length,
    losses: trades.length - winningTrades.length,
    winRatePct: trades.length
      ? (winningTrades.length / trades.length) * 100
      : 0,
    sharpeApprox:
      variance > 0 ? (mean / Math.sqrt(variance)) * Math.sqrt(252) : 0,
    buyAndHoldPct: (bars[bars.length - 1].close / bars[0].close - 1) * 100,
    tradeLog: trades.map((trade) => ({
      ...trade,
      entryPrice: roundMoney(trade.entryPrice),
      exitPrice: roundMoney(trade.exitPrice),
      entryFee: roundMoney(trade.entryFee),
      exitFee: roundMoney(trade.exitFee),
      fees: roundMoney(trade.fees),
      grossPnl: roundMoney(trade.grossPnl),
      netPnl: roundMoney(trade.netPnl),
    })),
  };
}
