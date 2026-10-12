import test from 'node:test';
import assert from 'node:assert/strict';
import { backtest, parseCsv, type BacktestConfig } from '../src/backtest';
import { transactionFee, getFeeProfile } from '../src/fees';
import type { Bar } from '../src/strategy';

function makeBars(): Bar[] {
  const bars: Bar[] = [];
  let price = 100;
  for (let i = 0; i < 80; i += 1) {
    if (i > 35 && i < 43) price -= 2.5;
    else if (i > 57 && i < 63) price -= 3;
    else price += 0.8;
    bars.push({
      date: `2025-01-${String(i + 1).padStart(2, '0')}`,
      open: price - 0.2,
      high: price + 1,
      low: price - 1,
      close: price,
      volume: 1000,
    });
  }
  return bars;
}

const config: BacktestConfig = {
  assetClass: 'stock',
  platform: 'ibkr_nl_tiered',
  startingCapital: 10000,
  riskPerTrade: 0.01,
  maxPositionPct: 0.25,
  atrStopMultiple: 2.5,
  slippageBps: 5,
  indicators: { fastEma: 10, slowEma: 30, rsiPeriod: 14, atrPeriod: 14 },
};

test('CSV parser validates and sorts OHLC data', () => {
  const bars = parseCsv('date,open,high,low,close\n2025-01-02,2,3,1,2.5\n2025-01-01,1,2,0.5,1.5');
  assert.equal(bars[0].date, '2025-01-01');
  assert.equal(bars[1].close, 2.5);
});

test('IBKR fee applies percentage and minimum', () => {
  const profile = getFeeProfile('ibkr_nl_tiered');
  assert.equal(transactionFee(1000, profile), 1.25);
  assert.equal(transactionFee(10000, profile), 5);
});

test('backtest reports fees and produces a finite result', () => {
  const report = backtest(makeBars(), config);
  assert.ok(Number.isFinite(report.finalEquity));
  assert.ok(report.totalFees > 0);
  assert.ok(report.trades > 0);
  assert.equal(report.startingCapital, 10000);
  assert.ok(Math.abs(report.tradeLog.reduce((sum, trade) => sum + trade.netPnl, 0) - report.netProfit) < 0.01);
});
