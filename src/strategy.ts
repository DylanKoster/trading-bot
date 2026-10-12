export interface Bar {
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number | null;
}

export interface IndicatorSettings {
  fastEma: number;
  slowEma: number;
  rsiPeriod: number;
  atrPeriod: number;
}

export type IndicatorSeries = Array<number | null>;

export interface Indicators {
  fastEma: IndicatorSeries;
  slowEma: IndicatorSeries;
  rsi: IndicatorSeries;
  atr: IndicatorSeries;
}

export function sma(values: number[], period: number): IndicatorSeries {
  const result = Array(values.length).fill(null);
  if (period <= 0) throw new Error("Indicator periods must be positive");
  for (let i = period - 1; i < values.length; i += 1) {
    const window = values.slice(i - period + 1, i + 1);
    result[i] = window.reduce((sum, value) => sum + value, 0) / period;
  }
  return result;
}

export function ema(values: number[], period: number): IndicatorSeries {
  const result = Array(values.length).fill(null);
  if (period <= 0) throw new Error("Indicator periods must be positive");
  if (values.length < period) return result;
  const seed =
    values.slice(0, period).reduce((sum, value) => sum + value, 0) / period;
  const multiplier = 2 / (period + 1);
  result[period - 1] = seed;
  for (let i = period; i < values.length; i += 1) {
    result[i] = (values[i] - result[i - 1]) * multiplier + result[i - 1];
  }
  return result;
}

export function rsi(values: number[], period: number): IndicatorSeries {
  const result = Array(values.length).fill(null);
  if (period <= 0) throw new Error("Indicator periods must be positive");
  if (values.length <= period) return result;
  let gains = 0;
  let losses = 0;
  for (let i = 1; i <= period; i += 1) {
    const delta = values[i] - values[i - 1];
    gains += Math.max(delta, 0);
    losses += Math.max(-delta, 0);
  }
  let averageGain = gains / period;
  let averageLoss = losses / period;
  result[period] =
    averageLoss === 0 ? 100 : 100 - 100 / (1 + averageGain / averageLoss);
  for (let i = period + 1; i < values.length; i += 1) {
    const delta = values[i] - values[i - 1];
    averageGain = (averageGain * (period - 1) + Math.max(delta, 0)) / period;
    averageLoss = (averageLoss * (period - 1) + Math.max(-delta, 0)) / period;
    result[i] =
      averageLoss === 0 ? 100 : 100 - 100 / (1 + averageGain / averageLoss);
  }
  return result;
}

export function atr(bars: Bar[], period: number): IndicatorSeries {
  const trueRanges = bars.map((bar, index) => {
    if (index === 0) return bar.high - bar.low;
    return Math.max(
      bar.high - bar.low,
      Math.abs(bar.high - bars[index - 1].close),
      Math.abs(bar.low - bars[index - 1].close),
    );
  });
  const result = Array(bars.length).fill(null);
  if (bars.length < period) return result;
  let average =
    trueRanges.slice(0, period).reduce((sum, value) => sum + value, 0) / period;
  result[period - 1] = average;
  for (let i = period; i < bars.length; i += 1) {
    average = (average * (period - 1) + trueRanges[i]) / period;
    result[i] = average;
  }
  return result;
}

export function buildIndicators(
  bars: Bar[],
  settings: IndicatorSettings,
): Indicators {
  const closes = bars.map((bar) => bar.close);
  return {
    fastEma: ema(closes, settings.fastEma),
    slowEma: ema(closes, settings.slowEma),
    rsi: rsi(closes, settings.rsiPeriod),
    atr: atr(bars, settings.atrPeriod),
  };
}

function signalValues(
  indicators: Indicators,
  index: number,
): { fast: number; slow: number; rsi: number; atr: number } | null {
  const fast = indicators.fastEma[index];
  const slow = indicators.slowEma[index];
  const rsiValue = indicators.rsi[index];
  const atrValue = indicators.atr[index];
  if (fast === null || slow === null || rsiValue === null || atrValue === null)
    return null;
  return { fast, slow, rsi: rsiValue, atr: atrValue };
}

export function entrySignal(indicators: Indicators, index: number): boolean {
  const values = signalValues(indicators, index);
  if (!values) return false;
  return values.fast > values.slow && values.rsi >= 45 && values.rsi <= 68;
}

export function exitSignal(indicators: Indicators, index: number): boolean {
  const values = signalValues(indicators, index);
  if (!values) return false;
  return values.fast < values.slow || values.rsi >= 74;
}
