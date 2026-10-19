import fs from "node:fs";
import path from "node:path";
import {
  getAccount,
  getBaseUrl,
  getQuote,
  getStockContract,
  getPositions,
  getOpenOrders,
  request,
  dataRequest,
  getPosition as fetchPosition,
  getOrder,
} from "./alpaca";
import {
  buildIndicators,
  entrySignal,
  exitSignal,
  type Bar,
  type IndicatorSettings,
} from "./strategy";

export interface AutoConfig {
  assetClass: "stock" | "crypto";
  startingCapital: number;
  riskPerTrade: number;
  maxPositionPct: number;
  atrStopMultiple: number;
  indicators: IndicatorSettings;
  scanSymbols?: string[];
}

export interface AutoOptions {
  symbol: string;
  equity: number;
  config: AutoConfig;
  submit: boolean;
  dataDir?: string;
}

export interface AutonomousOptions {
  config: AutoConfig;
  submit: boolean;
  dataDir?: string;
}

interface AutoPosition {
  quantity: number;
  entryPrice: number;
  stopPrice: number;
  stopOrderId: string;
  parentOrderId: string;
  highestClose: number;
}

interface AutoState {
  accountId: string;
  symbol: string;
  assetId: string;
  lastProcessedBar: string | null;
  position: AutoPosition | null;
  inFlight: string | null;
  exitOrderId?: string | null;
}

const NEW_YORK_TZ = "America/New_York";

function newYorkDate(timestamp: number): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: NEW_YORK_TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(timestamp));
  const values = Object.fromEntries(
    parts.map((part) => [part.type, part.value]),
  );
  return `${values.year}-${values.month}-${values.day}`;
}

function isRegularSession(): boolean {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: NEW_YORK_TZ,
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date());
  const values = Object.fromEntries(
    parts.map((part) => [part.type, part.value]),
  );
  const minutes = Number(values.hour) * 60 + Number(values.minute);
  return (
    !["Sat", "Sun"].includes(values.weekday) &&
    minutes >= 9 * 60 + 35 &&
    minutes < 15 * 60 + 55
  );
}

function loadState(
  filePath: string,
  accountId: string,
  symbol: string,
  assetId: string,
): AutoState {
  if (!fs.existsSync(filePath))
    return {
      accountId,
      symbol,
      assetId,
      lastProcessedBar: null,
      position: null,
      inFlight: null,
    };
  const state = JSON.parse(fs.readFileSync(filePath, "utf8")) as AutoState;
  if (state.accountId !== accountId || state.symbol !== symbol || String(state.assetId) !== String(assetId)) {
    throw new Error(
      `Auto-trading state at ${filePath} belongs to a different account or contract; inspect it before continuing`,
    );
  }
  return state;
}

function saveState(filePath: string, state: AutoState): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.tmp`;
  fs.writeFileSync(temporaryPath, `${JSON.stringify(state, null, 2)}\n`, {
    mode: 0o600,
  });
  fs.renameSync(temporaryPath, filePath);
}

function csvForBars(bars: Bar[]): string {
  return (
    [
      "date,open,high,low,close,volume",
      ...bars.map(
        (bar) =>
          `${bar.date},${bar.open},${bar.high},${bar.low},${bar.close},${bar.volume ?? ""}`,
      ),
    ].join("\n") + "\n"
  );
}

async function getDailyHistory(
  symbol: string,
): Promise<Bar[]> {
  const start = new Date(Date.now() - 3 * 365 * 24 * 60 * 60 * 1000).toISOString();
  const query = new URLSearchParams({ timeframe: "1Day", start, limit: "10000", adjustment: "all", feed: "iex" });
  const response = await dataRequest(`/v2/stocks/${encodeURIComponent(symbol)}/bars?${query}`);
  if (!Array.isArray(response?.bars))
    throw new Error("Alpaca did not return daily historical bars");
  const bars: Bar[] = (response.bars as any[])
    .map((item) => ({
      date: newYorkDate(Date.parse(item.t)),
      open: Number(item.o),
      high: Number(item.h),
      low: Number(item.l),
      close: Number(item.c),
      volume: Number.isFinite(Number(item.v)) ? Number(item.v) : null,
    }))
    .filter(
      (bar) =>
        bar.date &&
        [bar.open, bar.high, bar.low, bar.close].every(Number.isFinite),
    );
  bars.sort((a, b) => a.date.localeCompare(b.date));
  const uniqueBars = [...new Map(bars.map((bar) => [bar.date, bar])).values()];
  if (uniqueBars.length < 400)
    throw new Error(
      `Alpaca returned only ${uniqueBars.length} daily bars; automatic strategy requires approximately two years of history`,
    );
  const first = new Date(`${uniqueBars[0].date}T00:00:00Z`).getTime();
  const last = new Date(
    `${uniqueBars[uniqueBars.length - 1].date}T00:00:00Z`,
  ).getTime();
  if (last - first < 700 * 24 * 60 * 60 * 1000)
    throw new Error(
      "Alpaca daily history spans less than two calendar years; no strategy action taken",
    );
  return uniqueBars;
}

async function getPosition(baseUrl: string, symbol: string): Promise<number> {
  const position = await fetchPosition(baseUrl, symbol);
  return Number(position?.qty || 0);
}

async function submitPayload(
  baseUrl: string,
  payload: Record<string, unknown>,
): Promise<unknown> {
  try {
    return await request(
      baseUrl,
      "/v2/orders",
      {
        method: "POST",
        body: JSON.stringify(payload),
      },
    );
  } catch (error) {
    throw new Error(
      `Alpaca submission status is unknown; inspect open orders and positions before restarting. ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

async function updateStop(
  baseUrl: string,
  state: AutoState,
  nextStop: number,
): Promise<void> {
  const position = state.position;
  if (!position || nextStop <= position.stopPrice || nextStop <= 0) return;
  await cancelStopAndConfirm(baseUrl, position.stopOrderId);
  const result = await request(baseUrl, "/v2/orders", {
    method: "POST",
    body: JSON.stringify({
      symbol: state.symbol,
      qty: String(position.quantity),
      side: "sell",
      type: "stop",
      time_in_force: "gtc",
      stop_price: String(Number(nextStop.toFixed(2))),
    }),
  });
  if (!result?.id)
    throw new Error(
      `Alpaca returned no replacement stop order ID. Protective stop update needs manual review: ${JSON.stringify(result)}`,
    );
  position.stopOrderId = String(result.id);
  position.stopPrice = Number(nextStop.toFixed(2));
}

async function cancelStopAndConfirm(
  baseUrl: string,
  orderId: string,
): Promise<void> {
  await request(
    baseUrl,
    `/v2/orders/${encodeURIComponent(orderId)}`,
    { method: "DELETE" },
  );
  for (let attempt = 0; attempt < 10; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 1000));
    const status = await request(
      baseUrl,
      `/v2/orders/${encodeURIComponent(orderId)}`,
    );
    const value = String(
      status?.status || "",
    ).toLowerCase();
    if (["cancelled", "canceled", "filled", "inactive"].includes(value)) {
      if (value === "filled")
        throw new Error(
          "Protective stop filled while the strategy exit was starting; inspect the account before restarting",
        );
      if (value === "inactive")
        throw new Error(
          "Protective stop became inactive; inspect the account before restarting",
        );
      return;
    }
  }
  throw new Error(
    "Alpaca has not confirmed cancellation of the protective stop; strategy exit was not submitted",
  );
}

export async function runAutomaticOnce(
  options: AutoOptions,
): Promise<Record<string, unknown>> {
  const { symbol, equity, config, submit } = options;
  if (config.assetClass !== "stock")
    throw new Error("Automatic Alpaca execution supports stock configs only");
  if (!Number.isFinite(equity) || equity <= 0)
    throw new Error(
      "--equity must be a positive amount in the stock contract currency",
    );
  if (submit && process.env.LIVE_TRADING_ENABLED !== "true")
    throw new Error(
      "Set LIVE_TRADING_ENABLED=true to enable the live-order kill switch",
    );
  const baseUrl = getBaseUrl();
  const account = await getAccount(baseUrl);
  if (submit && account.isPaper)
    throw new Error(
      "ALPACA_BASE_URL points to a paper account; live automatic trading stopped",
    );
  const contract = await getStockContract(baseUrl, symbol);
  const assetId = String(contract.assetId);
  const bars = await getDailyHistory(symbol);
  const dataDir = path.resolve(options.dataDir || "data");
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(
    path.join(dataDir, `${symbol.toLowerCase()}-alpaca-daily.csv`),
    csvForBars(bars),
  );

  // Ignore today's still-forming daily candle. Signals use only completed sessions.
  const today = newYorkDate(Date.now());
  const closedBars = bars.filter((bar) => bar.date < today);
  if (closedBars.length < 40)
    throw new Error(
      "Not enough completed Alpaca daily bars for the configured indicators",
    );
  const latest = closedBars[closedBars.length - 1];
  const indicators = buildIndicators(closedBars, config.indicators);
  const index = closedBars.length - 1;
  const atr = indicators.atr[index];
  const statePath = path.join(dataDir, `auto-${symbol.toLowerCase()}.json`);
  const state = loadState(statePath, account.id, symbol, assetId);
  if (state.inFlight)
    throw new Error(
      `Previous automatic action ${state.inFlight} has an unknown or incomplete outcome; reconcile Alpaca orders and positions, then clear the state marker manually`,
    );
  const held = await getPosition(baseUrl, symbol);
  if (state.exitOrderId) {
    const exitOrderId = state.exitOrderId;
    const exitStatus = await getOrder(baseUrl, exitOrderId);
    const status = String(
      exitStatus?.status || "",
    ).toLowerCase();
    if (
      [
        "new",
        "accepted",
        "pending_new",
        "partially_filled",
        "submitted",
        "presubmitted",
        "pending submit",
        "partially filled",
        "pending",
      ].includes(status)
    ) {
      return {
        symbol,
        bar: latest.date,
        action: "indicator exit awaiting fill",
        orderId: exitOrderId,
        status,
      };
    }
    if (status === "filled") {
      if (held !== 0)
        throw new Error(
          `Exit order filled but Alpaca still reports ${held} shares; reconcile any partial fill before restarting`,
        );
      state.position = null;
      state.exitOrderId = null;
      state.lastProcessedBar = latest.date;
      saveState(statePath, state);
      return {
        symbol,
        bar: latest.date,
        action: "indicator exit filled",
        orderId: exitOrderId,
      };
    }
    throw new Error(
      `Indicator exit order is ${status || "in an unknown state"} and its protective stop was canceled; inspect Alpaca and manage the position manually`,
    );
  }
  if (held > 0 && !state.position)
    throw new Error(
      `Alpaca holds ${held} ${symbol} shares, but this runner has no ownership state; refusing to manage an untracked position`,
    );
  if (held < 0)
    throw new Error(
      `Alpaca reports a short ${symbol} position; this long-only runner will not manage it`,
    );
  if (state.position && !state.position.stopOrderId) {
    const parentOrder = await getOrder(baseUrl, state.position.parentOrderId);
    const parentStatus = String(parentOrder?.status || "").toLowerCase();
    if (["new", "accepted", "pending_new", "partially_filled"].includes(parentStatus))
      return {
        symbol,
        bar: latest.date,
        action: "entry order awaiting fill",
        orderId: state.position.parentOrderId,
        status: parentStatus,
      };
    if (parentStatus === "filled") {
      const stopOrderId = String(parentOrder?.legs?.[0]?.id || "");
      if (!stopOrderId)
        throw new Error(
          "Alpaca reports the entry filled but returned no attached stop order; inspect open orders and protect the position manually",
        );
      state.position.stopOrderId = stopOrderId;
      saveState(statePath, state);
    } else if (["canceled", "cancelled", "rejected", "expired"].includes(parentStatus)) {
      state.position = null;
      state.lastProcessedBar = latest.date;
      saveState(statePath, state);
    } else {
      throw new Error(
        `Could not reconcile the entry order (${parentStatus || "unknown"}); inspect Alpaca before continuing`,
      );
    }
  }
  if (state.position && held === 0) {
    const stopStatus = await getOrder(baseUrl, state.position.stopOrderId);
    const stopState = String(
      stopStatus?.status || "",
    ).toLowerCase();
    if (stopState === "filled") {
      const stopOrderId = state.position.stopOrderId;
      state.position = null;
      state.lastProcessedBar = latest.date;
      saveState(statePath, state);
      return {
        symbol,
        bar: latest.date,
        action: "protective stop filled",
        stopOrderId,
      };
    }
    const parentStatus = await getOrder(baseUrl, state.position.parentOrderId);
    const status = String(
      parentStatus?.status || "",
    ).toLowerCase();
    if (
      [
        "new",
        "accepted",
        "pending_new",
        "partially_filled",
        "submitted",
        "presubmitted",
        "pending submit",
        "partially filled",
        "pending",
      ].includes(status)
    ) {
      return {
        symbol,
        bar: latest.date,
        action: "entry order awaiting fill",
        orderId: state.position.parentOrderId,
        status,
      };
    }
    if (status === "filled")
      throw new Error(
        "Alpaca says the entry filled but the position endpoint is flat; reconcile account positions before restarting",
      );
    if (!["cancelled", "canceled", "inactive"].includes(status)) {
      throw new Error(
        `Could not reconcile pending entry order status (${status || "unknown"}); inspect Alpaca before restarting`,
      );
    }
    state.position = null;
    state.lastProcessedBar = latest.date;
  }
  if (state.lastProcessedBar === latest.date)
    return { symbol, bar: latest.date, action: "already processed", submit };
  if (submit && !isRegularSession())
    return {
      symbol,
      bar: latest.date,
      action: "waiting for regular US market hours",
      submit,
    };

  const position = state.position;
  if (position && held !== position.quantity) {
    throw new Error(
      `Alpaca position is ${held} shares but automatic state tracks ${position.quantity}; reconcile manually before continuing`,
    );
  }

  if (position && exitSignal(indicators, index)) {
    const quote = await getQuote(symbol, "SELL");
    const exitOrder = {
      symbol,
      qty: String(position.quantity),
      type: "limit",
      limit_price: String(quote.bid),
      side: "sell",
      time_in_force: "day",
      extended_hours: false,
    };
    const payload = exitOrder;
    const preview = { order: exitOrder, quote };
    if (!submit)
      return {
        symbol,
        bar: latest.date,
        action: "preview indicator exit",
        quantity: position.quantity,
        limitPrice: quote.bid,
        preview,
      };
    state.inFlight = `${latest.date}:EXIT`;
    saveState(statePath, state);
    await cancelStopAndConfirm(baseUrl, position.stopOrderId);
    const brokerResponse = await submitPayload(baseUrl, payload);
    const items = Array.isArray(brokerResponse)
      ? brokerResponse
      : [brokerResponse];
    if (
      items.some(
        (item: any) =>
          item?.error || (item?.id && Array.isArray(item?.message)),
      )
    ) {
      throw new Error(
        `Alpaca rejected the exit order after the protective stop was canceled. Inspect the account immediately: ${JSON.stringify(brokerResponse)}`,
      );
    }
    const exitOrderId = String(items[0]?.id || "");
    if (!exitOrderId)
      throw new Error(
        `Alpaca returned no exit order ID and the protective stop is canceled; inspect the account immediately: ${JSON.stringify(brokerResponse)}`,
      );
    state.exitOrderId = exitOrderId;
    state.inFlight = null;
    state.lastProcessedBar = latest.date;
    saveState(statePath, state);
    return {
      symbol,
      bar: latest.date,
      action: "submitted indicator exit",
      quantity: position.quantity,
      limitPrice: quote.bid,
      exitOrderId,
    };
  }

  if (position) {
    const quote = await getQuote(symbol, "SELL");
    const highestClose = Math.max(position.highestClose, latest.close);
    const currentAtr =
      atr ||
      (position.entryPrice - position.stopPrice) / config.atrStopMultiple;
    const trailingStop = Math.max(
      position.stopPrice,
      highestClose - currentAtr * config.atrStopMultiple,
    );
    if (trailingStop > position.stopPrice && submit) {
      state.inFlight = `${latest.date}:STOP_UPDATE`;
      saveState(statePath, state);
      try {
        await updateStop(baseUrl, state, trailingStop);
      } catch (error) {
        // Keep the recovery marker: Alpaca may have applied a modify request even if the response was lost.
        throw error;
      }
    }
    position.highestClose = highestClose;
    state.lastProcessedBar = latest.date;
    state.inFlight = null;
    if (submit) saveState(statePath, state);
    return {
      symbol,
      bar: latest.date,
      action: "hold",
      quantity: position.quantity,
      stopPrice: submit ? position.stopPrice : trailingStop,
      quote,
    };
  }

  if (!entrySignal(indicators, index) || typeof atr !== "number" || atr <= 0) {
    state.lastProcessedBar = latest.date;
    if (submit) saveState(statePath, state);
    return { symbol, bar: latest.date, action: "no entry signal", submit };
  }

  const quote = await getQuote(symbol, "BUY");
  const stopPrice = Number(
    (quote.ask - atr * config.atrStopMultiple).toFixed(2),
  );
  if (stopPrice <= 0 || stopPrice >= quote.ask)
    return {
      symbol,
      bar: latest.date,
      action: "blocked",
      reason: "ATR stop is invalid relative to the live ask",
    };
  const riskQuantity = (equity * config.riskPerTrade) / (quote.ask - stopPrice);
  const positionLimit = (equity * config.maxPositionPct) / quote.ask;
  const maxNotional = Number(process.env.LIVE_MAX_ORDER_NOTIONAL || 1000);
  if (!Number.isFinite(maxNotional) || maxNotional <= 0)
    throw new Error("LIVE_MAX_ORDER_NOTIONAL must be positive");
  const quantity = Math.floor(
    Math.min(riskQuantity, positionLimit, maxNotional / quote.ask),
  );
  if (quantity < 1)
    return {
      symbol,
      bar: latest.date,
      action: "no entry",
      reason:
        "Risk, allocation, or order-notional caps allow fewer than one share",
    };

  const bracket = {
    symbol,
    qty: String(quantity),
    side: "buy",
    type: "limit",
    time_in_force: "day",
    limit_price: String(quote.ask),
    order_class: "oto",
    stop_loss: { stop_price: String(stopPrice) },
    extended_hours: false,
  };
  const preview = { order: bracket, quote };
  if (!submit)
    return {
      symbol,
      bar: latest.date,
      action: "preview entry bracket",
      quantity,
      limitPrice: quote.ask,
      stopPrice,
      preview,
    };
  state.inFlight = `${latest.date}:ENTRY`;
  saveState(statePath, state);
  const brokerResponse = await submitPayload(baseUrl, bracket);
  const items = Array.isArray(brokerResponse)
    ? brokerResponse
    : [brokerResponse];
  if (
    items.some(
      (item: any) => item?.error || (item?.id && Array.isArray(item?.message)),
    )
  ) {
    throw new Error(
      `Alpaca returned a warning or error for the automatic OTO order; inspect broker response and open orders before restarting: ${JSON.stringify(brokerResponse)}`,
    );
  }
  const parentOrderId = String(items[0]?.id || "");
  const fullOrder = parentOrderId ? await getOrder(baseUrl, parentOrderId) : items[0];
  const stopOrderId = String(fullOrder?.legs?.[0]?.id || "");
  if (!parentOrderId)
    throw new Error(
      `Alpaca accepted the OTO order but returned no parent order ID; inspect open orders before restarting: ${JSON.stringify(brokerResponse)}`,
    );
  state.position = {
    quantity,
    entryPrice: quote.ask,
    stopPrice,
    stopOrderId,
    parentOrderId,
    highestClose: latest.close,
  };
  state.lastProcessedBar = latest.date;
  state.inFlight = null;
  saveState(statePath, state);
  return {
    symbol,
    bar: latest.date,
    action: "submitted entry bracket",
    quantity,
    limitPrice: quote.ask,
    stopPrice,
    stopOrderId,
    brokerResponse,
  };
}

export async function runAutonomousCycle(
  options: AutonomousOptions,
): Promise<Record<string, unknown>> {
  if (options.config.assetClass !== "stock")
    throw new Error("Autonomous Alpaca execution supports stock configs only");
  const baseUrl = getBaseUrl();
  const account = await getAccount(baseUrl);
  if (options.submit && process.env.LIVE_TRADING_ENABLED !== "true")
    throw new Error("Set LIVE_TRADING_ENABLED=true to enable the live-order kill switch");
  if (options.submit && account.isPaper)
    throw new Error("ALPACA_BASE_URL points to a paper account; live automatic trading stopped");
  if (!Number.isFinite(account.equity) || account.equity <= 0)
    throw new Error("Alpaca returned invalid account equity; no strategy action taken");

  const dataDir = path.resolve(options.dataDir || "data");
  const accountPositions = await getPositions(baseUrl);
  const heldSymbols = accountPositions
    .filter((position) => Number(position?.qty || 0) !== 0)
    .map((position) => String(position.symbol || "").toUpperCase())
    .filter((symbol) => /^[A-Z0-9.-]{1,16}$/.test(symbol));
  const trackedSymbols = new Set<string>();
  if (fs.existsSync(dataDir)) {
    for (const name of fs.readdirSync(dataDir)) {
      if (!/^auto-[A-Z0-9.-]+\.json$/i.test(name)) continue;
      const state = JSON.parse(fs.readFileSync(path.join(dataDir, name), "utf8")) as AutoState;
      if (state.accountId !== account.id) continue;
      if (state.position || state.inFlight || state.exitOrderId)
        trackedSymbols.add(state.symbol.toUpperCase());
    }
  }

  // Reconcile and manage an existing bot position or pending action before scanning entries.
  const managedSymbols = [...new Set([...heldSymbols, ...trackedSymbols])];
  if (managedSymbols.length > 0) {
    const decisions: Record<string, unknown>[] = [];
    for (const symbol of managedSymbols) {
      decisions.push(
        await runAutomaticOnce({
          symbol,
          equity: account.equity,
          config: options.config,
          submit: options.submit,
          dataDir,
        }),
      );
    }
    return {
      action: "managed existing position or pending order; no new entry considered",
      equity: account.equity,
      decisions,
    };
  }

  const openOrders = await getOpenOrders(baseUrl);
  if (openOrders.length > 0)
    return {
      action: "waiting for account open orders; no new entry considered",
      openOrderCount: openOrders.length,
    };

  const symbols = [...new Set((options.config.scanSymbols || [])
    .map((symbol) => String(symbol).trim().toUpperCase())
    .filter((symbol) => /^[A-Z0-9.-]{1,16}$/.test(symbol)))];
  if (symbols.length === 0)
    throw new Error("Add one or more candidate tickers to scanSymbols in the config file");

  const decisions: Record<string, unknown>[] = [];
  for (const symbol of symbols) {
    try {
      const decision = await runAutomaticOnce({
        symbol,
        equity: account.equity,
        config: options.config,
        submit: options.submit,
        dataDir,
      });
      decisions.push(decision);
      if (["preview entry bracket", "submitted entry bracket"].includes(String(decision.action)))
        return {
          action: options.submit ? "selected and submitted the highest-ranked qualifying candidate" : "selected the highest-ranked qualifying candidate (preview only)",
          equity: account.equity,
          candidatesScanned: decisions.length,
          decisions,
        };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (options.submit && /unknown|inspect|manual|inFlight|protective stop|reconcile/i.test(message))
        throw error;
      decisions.push({ symbol, action: "candidate skipped", reason: message });
    }
  }
  return {
    action: "no qualifying entry; chose not to trade",
    equity: account.equity,
    candidatesScanned: decisions.length,
    decisions,
  };
}
