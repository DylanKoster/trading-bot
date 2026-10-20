import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
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
  /** Maximum fraction of equity that may be allocated to long positions. */
  maxPortfolioPct?: number;
  /** Maximum number of simultaneous long positions, including pending entries. */
  maxOpenPositions?: number;
  atrStopMultiple: number;
  indicators: IndicatorSettings;
  scanSymbols?: string[];
}

export interface AutoOptions {
  symbol: string;
  equity: number;
  config: AutoConfig;
  submit: boolean;
  allowPaper?: boolean;
  dataDir?: string;
  /** Remaining portfolio allocation available for a new entry. */
  allocationBudget?: number;
  /** Current broker buying power, used as a hard cash ceiling. */
  buyingPower?: number;
}

export interface AutonomousOptions {
  config: AutoConfig;
  submit: boolean;
  allowPaper?: boolean;
  dataDir?: string;
}

interface AutoPosition {
  quantity: number;
  entryPrice: number;
  stopPrice: number;
  stopOrderId: string | null;
  parentOrderId: string | null;
  highestClose: number;
}

interface AutoState {
  accountId: string;
  symbol: string;
  assetId: string;
  lastProcessedBar: string | null;
  position: AutoPosition | null;
  inFlight: string | null;
  pendingStopOrderClientId?: string | null;
  exitOrderId?: string | null;
}

const NEW_YORK_TZ = "America/New_York";
// Renew before Alpaca's aged GTC order policy reaches its 90-day expiry.
const GTC_STOP_RENEWAL_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

const ACTIVE_ORDER_STATUSES = new Set([
  "new",
  "accepted",
  "pending_new",
  "partially_filled",
  "submitted",
  "presubmitted",
  "pending_submit",
  "pending submit",
  "partially filled",
  "pending",
]);

function orderStatus(order: any): string {
  return String(order?.status || "").toLowerCase();
}

function isActiveOrderStatus(status: string): boolean {
  return ACTIVE_ORDER_STATUSES.has(status);
}

function orderQuantity(order: any): number {
  return Math.abs(Number(order?.qty || order?.quantity || 0));
}

function orderStopPrice(order: any): number {
  return Number(order?.stop_price || order?.stopPrice || 0);
}

function orderType(order: any): string {
  return String(order?.type || order?.order_type || "").toLowerCase();
}

function orderSide(order: any): string {
  return String(order?.side || "").toLowerCase();
}

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

function optionalPositiveEnvironmentNumber(name: string): number | null {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return null;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0)
    throw new Error(`${name} must be positive`);
  return value;
}

function automaticOrderNotionalCap(): number {
  // A cap is still available for operators who want one, but the old implicit
  // 1,000 cap made a 100,000 account invest only a few thousand dollars.
  return (
    optionalPositiveEnvironmentNumber("AUTO_MAX_ORDER_NOTIONAL") ??
    optionalPositiveEnvironmentNumber("LIVE_MAX_ORDER_NOTIONAL") ??
    Number.POSITIVE_INFINITY
  );
}

function portfolioCap(config: AutoConfig): number {
  const value = config.maxPortfolioPct ?? 0.95;
  if (!Number.isFinite(value) || value <= 0 || value > 1)
    throw new Error("maxPortfolioPct must be greater than 0 and no greater than 1");
  return value;
}

function openPositionCap(config: AutoConfig, universeSize: number): number {
  const value = config.maxOpenPositions ?? Math.min(10, Math.max(1, universeSize));
  if (!Number.isInteger(value) || value < 1)
    throw new Error("maxOpenPositions must be a positive whole number");
  return value;
}

function orderNotional(order: any): number {
  const quantity = Math.abs(Number(order?.qty || order?.quantity || 0));
  const price = Number(order?.limit_price || order?.stop_price || 0);
  return Number.isFinite(quantity) && Number.isFinite(price) && quantity > 0 && price > 0
    ? quantity * price
    : 0;
}

function longPositionNotional(position: any): number {
  const quantity = Number(position?.qty || 0);
  if (!Number.isFinite(quantity) || quantity <= 0) return 0;
  const marketValue = Number(position?.market_value);
  if (Number.isFinite(marketValue) && marketValue > 0) return marketValue;
  const price = Number(position?.current_price || position?.avg_entry_price || 0);
  return Number.isFinite(price) && price > 0 ? quantity * price : 0;
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

async function getOrderByClientOrderId(
  baseUrl: string,
  clientOrderId: string,
): Promise<any | null> {
  try {
    return await request(
      baseUrl,
      `/v2/orders:by_client_order_id?client_order_id=${encodeURIComponent(clientOrderId)}`,
    );
  } catch (error) {
    if (error instanceof Error && /Alpaca request failed \(404\)/.test(error.message))
      return null;
    throw error;
  }
}

async function updateStop(
  baseUrl: string,
  state: AutoState,
  nextStop: number,
  force = false,
): Promise<void> {
  const position = state.position;
  if (!position || nextStop <= 0 || (!force && nextStop <= position.stopPrice)) return;
  if (position.stopOrderId)
    await cancelStopAndConfirm(baseUrl, position.stopOrderId);
  const stopPrice = Number(nextStop.toFixed(2));
  const result = await request(baseUrl, "/v2/orders", {
    method: "POST",
    body: JSON.stringify({
      symbol: state.symbol,
      qty: String(position.quantity),
      side: "sell",
      type: "stop",
      time_in_force: "gtc",
      stop_price: String(stopPrice),
      client_order_id: state.pendingStopOrderClientId || undefined,
    }),
  });
  if (!result?.id)
    throw new Error(
      `Alpaca returned no replacement stop order ID. Protective stop update needs manual review: ${JSON.stringify(result)}`,
    );
  position.stopOrderId = String(result.id);
  position.stopPrice = stopPrice;
}

async function cancelStopAndConfirm(
  baseUrl: string,
  orderId: string,
): Promise<void> {
  const existing = await getOrder(baseUrl, orderId);
  const existingStatus = orderStatus(existing);
  if (["cancelled", "canceled", "expired"].includes(existingStatus)) return;
  if (existingStatus === "filled")
    throw new Error(
      "Protective stop filled while the strategy action was starting; inspect the account before continuing",
    );
  if (existingStatus === "inactive")
    throw new Error(
      "Protective stop became inactive; inspect the account before continuing",
    );
  if (existingStatus !== "pending_cancel")
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
    if (["cancelled", "canceled", "expired", "filled", "inactive"].includes(value)) {
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

async function recoverStopUpdate(
  baseUrl: string,
  state: AutoState,
  held: number,
): Promise<boolean> {
  if (!state.inFlight) return false;
  const position = state.position;
  if (!state.inFlight.endsWith(":STOP_UPDATE") || !position)
    throw new Error(
      `Previous automatic action ${state.inFlight} has an unknown or incomplete outcome; reconcile Alpaca orders and positions before continuing`,
    );
  if (held !== position.quantity)
    throw new Error(
      `Alpaca position is ${held} shares while a stop update is unresolved for ${position.quantity}; reconcile the position and orders before continuing`,
    );

  if (state.pendingStopOrderClientId) {
    const submittedStop = await getOrderByClientOrderId(
      baseUrl,
      state.pendingStopOrderClientId,
    );
    if (submittedStop) {
      const status = orderStatus(submittedStop);
      if (status === "pending_cancel")
        throw new Error(
          `The replacement ${state.symbol} stop is pending cancellation; the scanner will reconcile it on the next cycle`,
        );
      if (isActiveOrderStatus(status)) {
        const stopPrice = orderStopPrice(submittedStop);
        const stopOrderId = String(submittedStop?.id || "");
        if (
          String(submittedStop?.symbol || "").toUpperCase() !== state.symbol.toUpperCase() ||
          orderSide(submittedStop) !== "sell" ||
          orderType(submittedStop) !== "stop" ||
          orderQuantity(submittedStop) !== held ||
          !stopOrderId ||
          !Number.isFinite(stopPrice) ||
          stopPrice <= 0
        )
          throw new Error(
            `The submitted replacement stop for ${state.symbol} does not match the held position; inspect Alpaca before continuing`,
          );
        const currentSellOrders = (await getOpenOrders(baseUrl)).filter(
          (order: any) => String(order?.symbol || "").toUpperCase() === state.symbol.toUpperCase() && orderSide(order) === "sell",
        );
        if (
          currentSellOrders.length > 1 ||
          currentSellOrders.some((order: any) => String(order?.id || "") !== stopOrderId)
        )
          throw new Error(
            `The ${state.symbol} replacement stop exists alongside another open sell order; reconcile the orders before continuing`,
          );
        position.stopOrderId = stopOrderId;
        position.stopPrice = stopPrice;
        state.pendingStopOrderClientId = null;
        state.inFlight = null;
        return false;
      }
      if (["filled", "expired", "cancelled", "canceled"].includes(status)) {
        if (status === "filled")
          throw new Error(
            `Alpaca reports the replacement ${state.symbol} stop filled but still reports ${held} shares; reconcile before continuing`,
          );
        state.pendingStopOrderClientId = null;
      } else {
        throw new Error(
          `The replacement ${state.symbol} stop has status ${status || "unknown"}; inspect Alpaca before continuing`,
        );
      }
    }
  }

  const openOrders = await getOpenOrders(baseUrl);
  const sellOrders = openOrders.filter(
    (order: any) => String(order?.symbol || "").toUpperCase() === state.symbol.toUpperCase() && orderSide(order) === "sell",
  );
  const stopOrders = sellOrders.filter((order: any) => orderType(order) === "stop");
  if (sellOrders.length !== stopOrders.length || stopOrders.length > 1)
    throw new Error(
      `Stop recovery for ${state.symbol} found multiple or conflicting open sell orders; reconcile them manually before continuing`,
    );

  if (stopOrders.length === 1) {
    const activeStop = stopOrders[0];
    const activeStatus = orderStatus(activeStop);
    if (activeStatus === "pending_cancel")
      throw new Error(
        `The ${state.symbol} protective stop is still pending cancellation; the scanner will reconcile it on the next cycle`,
      );
    if (!isActiveOrderStatus(activeStatus))
      throw new Error(
        `The open ${state.symbol} stop has status ${activeStatus || "unknown"}; inspect Alpaca before continuing`,
      );
    const stopPrice = orderStopPrice(activeStop);
    if (orderQuantity(activeStop) !== held || !Number.isFinite(stopPrice) || stopPrice <= 0)
      throw new Error(
        `Open ${state.symbol} stop order does not match the held quantity or has an invalid stop price; reconcile manually before continuing`,
      );
    position.stopOrderId = String(activeStop.id || "");
    if (!position.stopOrderId)
      throw new Error(`Alpaca returned an open ${state.symbol} stop without an order ID`);
    position.stopPrice = stopPrice;
    state.pendingStopOrderClientId = null;
    state.inFlight = null;
    return false;
  }

  if (position.stopOrderId) {
    const oldStop = await getOrder(baseUrl, position.stopOrderId);
    const status = orderStatus(oldStop);
    if (!["expired", "cancelled", "canceled"].includes(status))
      throw new Error(
        `The ${state.symbol} stop update is unresolved and no active replacement stop was found (old stop status: ${status || "unknown"}); inspect Alpaca before continuing`,
      );
  }

  // The old stop is confirmed terminal and no replacement is open. The position
  // manager will submit a replacement stop using the saved trailing level.
  state.inFlight = null;
  return true;
}

export async function runAutomaticOnce(
  options: AutoOptions,
): Promise<Record<string, unknown>> {
  const { symbol, equity, config, submit, allowPaper = false } = options;
  if (config.assetClass !== "stock")
    throw new Error("Automatic Alpaca execution supports stock configs only");
  if (!Number.isFinite(equity) || equity <= 0)
    throw new Error(
      "--equity must be a positive amount in the stock contract currency",
    );
  if (submit && !allowPaper && process.env.LIVE_TRADING_ENABLED !== "true")
    throw new Error(
      "Set LIVE_TRADING_ENABLED=true to enable the live-order kill switch",
    );
  const baseUrl = getBaseUrl();
  const account = await getAccount(baseUrl);
  if (submit && account.isPaper && !allowPaper)
    throw new Error(
      "ALPACA_BASE_URL points to a paper account; live automatic trading stopped",
    );
  if (submit && !account.isPaper && allowPaper)
    throw new Error("Paper mode requires ALPACA_BASE_URL=https://paper-api.alpaca.markets");
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
  const brokerPosition = await fetchPosition(baseUrl, symbol);
  const held = Number(brokerPosition?.qty || 0);
  const hadInFlight = Boolean(state.inFlight);
  let forceStopReplacement = await recoverStopUpdate(baseUrl, state, held);
  if (hadInFlight) saveState(statePath, state);
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
  if (held < 0)
    throw new Error(
      `Alpaca reports a short ${symbol} position; this long-only runner will not manage it`,
    );
  const pendingPosition = state.position;
  if (pendingPosition && !pendingPosition.stopOrderId && pendingPosition.parentOrderId) {
    const parentOrderId = pendingPosition.parentOrderId;
    const parentOrder = await getOrder(baseUrl, parentOrderId);
    const parentStatus = orderStatus(parentOrder);
    if (isActiveOrderStatus(parentStatus))
      return {
        symbol,
        bar: latest.date,
        action: "entry order awaiting fill",
        orderId: parentOrderId,
        status: parentStatus,
      };
    if (parentStatus === "filled") {
      const stopOrderId = String(parentOrder?.legs?.[0]?.id || "");
      if (!stopOrderId)
        throw new Error(
          "Alpaca reports the entry filled but returned no attached stop order; inspect open orders and protect the position manually",
        );
      pendingPosition.stopOrderId = stopOrderId;
      pendingPosition.stopPrice = Number(
        parentOrder?.legs?.[0]?.stop_price || pendingPosition.stopPrice,
      );
      saveState(statePath, state);
    } else if (["canceled", "cancelled", "rejected", "expired"].includes(parentStatus)) {
      if (held > 0)
        throw new Error(
          `Alpaca holds ${held} ${symbol} shares but the saved entry order is ${parentStatus}; reconcile ownership and protective orders manually`,
        );
      state.position = null;
      state.lastProcessedBar = latest.date;
      saveState(statePath, state);
    } else {
      throw new Error(
        `Could not reconcile the entry order (${parentStatus || "unknown"}); inspect Alpaca before continuing`,
      );
    }
  }
  const closedPosition = state.position;
  if (closedPosition && held === 0) {
    const stopStatus = closedPosition.stopOrderId
      ? await getOrder(baseUrl, closedPosition.stopOrderId)
      : null;
    const stopState = orderStatus(stopStatus);
    if (stopState === "filled") {
      const stopOrderId = closedPosition.stopOrderId;
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
    if (isActiveOrderStatus(stopState) && closedPosition.stopOrderId)
      await cancelStopAndConfirm(baseUrl, closedPosition.stopOrderId);
    else if (
      stopState &&
      !["expired", "cancelled", "canceled", "inactive"].includes(stopState)
    )
      throw new Error(
        `Could not reconcile protective stop status (${stopState}); inspect Alpaca before continuing`,
      );
    const parentOrderId = closedPosition.parentOrderId;
    if (!parentOrderId) {
      state.position = null;
      state.lastProcessedBar = latest.date;
      saveState(statePath, state);
      return {
        symbol,
        bar: latest.date,
        action: "adopted position is no longer held",
      };
    }
    const parentStatus = await getOrder(baseUrl, parentOrderId);
    const status = orderStatus(parentStatus);
    if (isActiveOrderStatus(status)) {
      return {
        symbol,
        bar: latest.date,
        action: "entry order awaiting fill",
        orderId: parentOrderId,
        status,
      };
    }
    if (status === "filled")
      throw new Error(
        "Alpaca says the entry filled but the position endpoint is flat; reconcile account positions before restarting",
      );
    if (!["cancelled", "canceled", "inactive", "expired"].includes(status)) {
      throw new Error(
        `Could not reconcile pending entry order status (${status || "unknown"}); inspect Alpaca before restarting`,
      );
    }
    state.position = null;
    state.lastProcessedBar = latest.date;
  }
  if (held === 0 && !state.position && state.lastProcessedBar === latest.date)
    return { symbol, bar: latest.date, action: "already processed", submit };
  if (submit && !isRegularSession())
    return {
      symbol,
      bar: latest.date,
      action: "waiting for regular US market hours",
      submit,
    };

  if (held > 0 && !state.position) {
    if (!Number.isInteger(held))
      throw new Error(
        `Alpaca holds a fractional ${symbol} position (${held}); automatic adoption currently requires whole shares`,
      );
    const openOrders = await getOpenOrders(baseUrl);
    const symbolOrders = openOrders.filter(
      (order: any) => String(order?.symbol || "").toUpperCase() === symbol.toUpperCase(),
    );
    if (symbolOrders.some((order: any) => orderSide(order) === "buy"))
      throw new Error(`Cannot adopt ${symbol} while an open buy order can change its position quantity`);
    const sellOrders = symbolOrders.filter((order: any) => orderSide(order) === "sell");
    const stopOrders = sellOrders.filter((order: any) => orderType(order) === "stop");
    if (sellOrders.length !== stopOrders.length || stopOrders.length > 1)
      throw new Error(
        `Cannot adopt ${symbol}: multiple or conflicting open sell orders need manual reconciliation`,
      );
    const entryPrice = Number(brokerPosition?.avg_entry_price || 0);
    if (!Number.isFinite(entryPrice) || entryPrice <= 0)
      throw new Error(`Alpaca returned no valid average entry price for ${symbol}; cannot adopt the position`);

    if (stopOrders.length === 1) {
      const stopOrder = stopOrders[0];
      const status = orderStatus(stopOrder);
      const stopPrice = orderStopPrice(stopOrder);
      const stopOrderId = String(stopOrder?.id || "");
      if (
        !isActiveOrderStatus(status) ||
        orderQuantity(stopOrder) !== held ||
        !stopOrderId ||
        !Number.isFinite(stopPrice) ||
        stopPrice <= 0
      )
        throw new Error(
          `Cannot adopt ${symbol}: its open sell stop does not match the held quantity or has invalid details`,
        );
      state.position = {
        quantity: held,
        entryPrice,
        stopPrice,
        stopOrderId,
        parentOrderId: null,
        // Start the trailing watermark at adoption; the original holding date is unknown.
        highestClose: latest.close,
      };
      if (submit) saveState(statePath, state);
    } else {
      if (typeof atr !== "number" || !Number.isFinite(atr) || atr <= 0)
        throw new Error(`Cannot adopt ${symbol} without a valid ATR for its initial protective stop`);
      const quote = await getQuote(symbol, "SELL");
      const highestClose = Math.max(entryPrice, latest.close);
      const stopPrice = Number(
        Math.max(
          entryPrice - atr * config.atrStopMultiple,
          highestClose - atr * config.atrStopMultiple,
        ).toFixed(2),
      );
      if (stopPrice <= 0 || stopPrice >= quote.bid)
        throw new Error(
          `Cannot safely place an initial ${symbol} stop at ${stopPrice}; current bid is ${quote.bid}. Review this holding manually`,
        );
      const adoptedPosition: AutoPosition = {
        quantity: held,
        entryPrice,
        stopPrice,
        stopOrderId: null,
        parentOrderId: null,
        highestClose,
      };
      state.position = adoptedPosition;
      const order = {
        symbol,
        qty: String(held),
        side: "sell",
        type: "stop",
        time_in_force: "gtc",
        stop_price: String(stopPrice),
      };
      if (!submit)
        return {
          symbol,
          bar: latest.date,
          action: "preview adoption of existing position",
          quantity: held,
          stopPrice,
          preview: { order, quote },
        };
      state.inFlight = `${latest.date}:STOP_UPDATE`;
      state.pendingStopOrderClientId ||= `auto-stop-${symbol.toLowerCase()}-${randomUUID()}`;
      saveState(statePath, state);
      await updateStop(baseUrl, state, stopPrice, true);
      state.inFlight = null;
      state.pendingStopOrderClientId = null;
      saveState(statePath, state);
      return {
        symbol,
        bar: latest.date,
        action: "adopted existing position and placed protective stop",
        quantity: held,
        stopPrice,
        stopOrderId: adoptedPosition.stopOrderId,
      };
    }
  }

  const position = state.position;
  if (position && held !== position.quantity) {
    throw new Error(
      `Alpaca position is ${held} shares but automatic state tracks ${position.quantity}; reconcile manually before continuing`,
    );
  }

  if (position) {
    let renewStop = forceStopReplacement || !position.stopOrderId;
    if (position.stopOrderId) {
      const existingStop = await getOrder(baseUrl, position.stopOrderId);
      const status = orderStatus(existingStop);
      if (["expired", "cancelled", "canceled"].includes(status)) {
        renewStop = true;
      } else if (status === "filled") {
        throw new Error(
          `Alpaca reports the ${symbol} protective stop filled but still reports ${held} shares; reconcile the position before continuing`,
        );
      } else if (isActiveOrderStatus(status)) {
        const actualStopPrice = orderStopPrice(existingStop);
        if (
          String(existingStop?.symbol || "").toUpperCase() !== symbol.toUpperCase() ||
          orderSide(existingStop) !== "sell" ||
          orderType(existingStop) !== "stop" ||
          orderQuantity(existingStop) !== held ||
          !Number.isFinite(actualStopPrice) ||
          actualStopPrice <= 0
        )
          throw new Error(
            `The active ${symbol} protective stop does not match the broker position; inspect Alpaca before continuing`,
          );
        position.stopPrice = actualStopPrice;
        const expiresAt = Date.parse(String(existingStop?.expires_at || ""));
        if (
          Number.isFinite(expiresAt) &&
          expiresAt - Date.now() <= GTC_STOP_RENEWAL_WINDOW_MS
        )
          renewStop = true;
      } else {
        throw new Error(
          `The ${symbol} protective stop has status ${status || "unknown"}; inspect Alpaca before continuing`,
        );
      }
    }

    const quote = await getQuote(symbol, "SELL");
    const currentAtr =
      typeof atr === "number" && Number.isFinite(atr) && atr > 0
        ? atr
        : (position.entryPrice - position.stopPrice) / config.atrStopMultiple;
    if (!Number.isFinite(currentAtr) || currentAtr <= 0)
      throw new Error(`Cannot calculate a valid trailing stop for ${symbol}; inspect the position state`);
    const highestClose = Math.max(position.highestClose, latest.close);
    const trailingStop = Math.max(
      position.stopPrice,
      highestClose - currentAtr * config.atrStopMultiple,
    );

    const nextStop = Number(Math.max(position.stopPrice, trailingStop).toFixed(2));
    const updateStopOrder = renewStop || nextStop > position.stopPrice;
    if (updateStopOrder) {
      if (nextStop <= 0 || nextStop >= quote.bid)
        throw new Error(
          `The calculated ${symbol} protective stop (${nextStop}) is at or above the current bid (${quote.bid}); review the position manually`,
        );
      const replacementOrder = {
        symbol,
        qty: String(position.quantity),
        side: "sell",
        type: "stop",
        time_in_force: "gtc",
        stop_price: String(nextStop),
      };
      if (!submit)
        return {
          symbol,
          bar: latest.date,
          action: renewStop ? "preview protective stop renewal" : "preview trailing stop update",
          quantity: position.quantity,
          stopPrice: nextStop,
          preview: { order: replacementOrder, quote },
        };

      state.inFlight = `${latest.date}:STOP_UPDATE`;
      state.pendingStopOrderClientId ||= `auto-stop-${symbol.toLowerCase()}-${randomUUID()}`;
      saveState(statePath, state);
      await updateStop(baseUrl, state, nextStop, true);
      state.inFlight = null;
      state.pendingStopOrderClientId = null;
      position.highestClose = highestClose;
      state.lastProcessedBar = latest.date;
      saveState(statePath, state);
      return {
        symbol,
        bar: latest.date,
        action: renewStop ? "renewed protective stop" : "updated trailing stop",
        quantity: position.quantity,
        stopPrice: position.stopPrice,
        stopOrderId: position.stopOrderId,
      };
    }

    if (exitSignal(indicators, index)) {
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
      if (position.stopOrderId)
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
    position.highestClose = highestClose;
    state.lastProcessedBar = latest.date;
    if (submit) saveState(statePath, state);
    return {
      symbol,
      bar: latest.date,
      action: "hold",
      quantity: position.quantity,
      stopPrice: position.stopPrice,
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
  const configuredBudget = options.allocationBudget ?? Number.POSITIVE_INFINITY;
  const accountBuyingPower = Number(account.buyingPower);
  const buyingPowerBudget = options.buyingPower ?? (
    Number.isFinite(accountBuyingPower)
      ? Math.max(0, accountBuyingPower)
      : Number.POSITIVE_INFINITY
  );
  if (!Number.isFinite(configuredBudget) && configuredBudget !== Number.POSITIVE_INFINITY)
    throw new Error("allocationBudget must be finite and non-negative");
  if (!Number.isFinite(buyingPowerBudget) && buyingPowerBudget !== Number.POSITIVE_INFINITY)
    throw new Error("buyingPower must be finite and non-negative");
  if (configuredBudget < 0 || buyingPowerBudget < 0)
    throw new Error("allocationBudget and buyingPower must be non-negative");
  const allocationBudget = Math.min(configuredBudget, buyingPowerBudget);
  const maxNotional = automaticOrderNotionalCap();
  const quantity = Math.floor(
    Math.min(
      riskQuantity,
      positionLimit,
      maxNotional / quote.ask,
      allocationBudget / quote.ask,
    ),
  );
  if (quantity < 1)
    return {
      symbol,
      bar: latest.date,
      action: "no entry",
      reason:
        "Risk, portfolio allocation, buying-power, or order-notional caps allow fewer than one share",
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
  if (options.submit && !options.allowPaper && process.env.LIVE_TRADING_ENABLED !== "true")
    throw new Error("Set LIVE_TRADING_ENABLED=true to enable the live-order kill switch");
  if (options.submit && account.isPaper && !options.allowPaper)
    throw new Error("ALPACA_BASE_URL points to a paper account; live automatic trading stopped");
  if (options.submit && !account.isPaper && options.allowPaper)
    throw new Error("Paper mode requires ALPACA_BASE_URL=https://paper-api.alpaca.markets");
  if (!Number.isFinite(account.equity) || account.equity <= 0)
    throw new Error("Alpaca returned invalid account equity; no strategy action taken");

  const dataDir = path.resolve(options.dataDir || "data");
  const symbols = [...new Set((options.config.scanSymbols || [])
    .map((symbol) => String(symbol).trim().toUpperCase())
    .filter((symbol) => /^[A-Z0-9.-]{1,16}$/.test(symbol)))];
  if (symbols.length === 0)
    throw new Error("Add one or more candidate tickers to scanSymbols in the config file");
  const maxPortfolioPct = portfolioCap(options.config);
  const maxOpenPositions = openPositionCap(options.config, symbols.length);
  const accountPositions = await getPositions(baseUrl);
  const heldSymbols = accountPositions
    .filter((position) => Number(position?.qty || 0) !== 0)
    .map((position) => String(position.symbol || "").toUpperCase())
    .filter((symbol) => /^[A-Z0-9.-]{1,16}$/.test(symbol));
  const manageableHeldSymbols = accountPositions
    .filter((position) => {
      const quantity = Number(position?.qty || 0);
      return quantity > 0 && Number.isInteger(quantity);
    })
    .map((position) => String(position.symbol || "").toUpperCase())
    .filter((symbol) => /^[A-Z0-9.-]{1,16}$/.test(symbol));
  const unmanagedPositions = accountPositions
    .map((position) => ({
      symbol: String(position.symbol || "").toUpperCase(),
      quantity: Number(position?.qty || 0),
    }))
    .filter(
      (position) => position.quantity < 0 || (position.quantity > 0 && !Number.isInteger(position.quantity)),
    );
  const unmanagedPositionSymbols = new Set(
    unmanagedPositions.map((position) => position.symbol),
  );
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
  const managedSymbols = [...new Set([
    ...manageableHeldSymbols,
    ...[...trackedSymbols].filter((symbol) => !unmanagedPositionSymbols.has(symbol)),
  ])];
  const openOrders = await getOpenOrders(baseUrl);
  const decisions: Record<string, unknown>[] = unmanagedPositions.map((position) => ({
    symbol: position.symbol,
    action: "existing position left unmanaged",
    quantity: position.quantity,
    reason: position.quantity < 0
      ? "automatic strategy manages long positions only"
      : "automatic stop orders require whole-share quantities",
  }));
  for (const symbol of managedSymbols) {
    decisions.push(
      await runAutomaticOnce({
        symbol,
        equity: account.equity,
        config: options.config,
        submit: options.submit,
        allowPaper: options.allowPaper,
        dataDir,
      }),
    );
  }

  const positivePositions = accountPositions.filter((position) => Number(position?.qty || 0) > 0);
  const existingLongNotional = positivePositions.reduce(
    (sum, position) => sum + longPositionNotional(position),
    0,
  );
  const openBuyOrders = openOrders.filter(
    (order) => String(order?.side || "").toLowerCase() === "buy",
  );
  const openBuyNotional = openBuyOrders.reduce(
    (sum, order) => sum + orderNotional(order),
    0,
  );
  const accountBuyingPower = Number(account.buyingPower);
  const availableBuyingPower = Number.isFinite(accountBuyingPower)
    ? Math.max(0, accountBuyingPower)
    : Number.POSITIVE_INFINITY;
  let remainingPortfolioBudget = Math.max(
    0,
    account.equity * maxPortfolioPct - existingLongNotional - openBuyNotional,
  );
  // Alpaca's buying_power already reflects broker reservations. Open buy
  // orders are subtracted from the portfolio budget above, but not again here.
  let remainingBuyingPower = availableBuyingPower;
  let activePositionCount = positivePositions.length +
    [...trackedSymbols].filter((symbol) => !heldSymbols.includes(symbol)).length;
  const openBuySymbols = new Set(
    openBuyOrders
      .map((order) => String(order?.symbol || "").toUpperCase())
      .filter(Boolean),
  );

  for (const symbol of symbols.filter(
    (candidate) => !heldSymbols.includes(candidate) && !trackedSymbols.has(candidate),
  )) {
    if (activePositionCount >= maxOpenPositions) break;
    if (openBuySymbols.has(symbol)) {
      decisions.push({
        symbol,
        action: "candidate skipped",
        reason: "an open buy order already exists for this symbol",
      });
      continue;
    }
    if (remainingPortfolioBudget < 1 || remainingBuyingPower < 1) break;
    try {
      const decision = await runAutomaticOnce({
        symbol,
        equity: account.equity,
        config: options.config,
        submit: options.submit,
        allowPaper: options.allowPaper,
        dataDir,
        allocationBudget: remainingPortfolioBudget,
        buyingPower: remainingBuyingPower,
      });
      decisions.push(decision);
      if (["preview entry bracket", "submitted entry bracket"].includes(String(decision.action))) {
        const notional = Number(decision.quantity) * Number(decision.limitPrice);
        if (Number.isFinite(notional) && notional > 0) {
          remainingPortfolioBudget = Math.max(0, remainingPortfolioBudget - notional);
          remainingBuyingPower = Math.max(0, remainingBuyingPower - notional);
          activePositionCount += 1;
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (options.submit && /unknown|inspect|manual|inFlight|protective stop|reconcile/i.test(message))
        throw error;
      decisions.push({ symbol, action: "candidate skipped", reason: message });
    }
  }
  return {
    action: managedSymbols.length > 0
      ? "managed existing positions and scanned for additional entries"
      : "no qualifying entry; chose not to trade",
    equity: account.equity,
    portfolioBudget: account.equity * maxPortfolioPct,
    remainingPortfolioBudget,
    maxOpenPositions,
    candidatesScanned: decisions.length,
    decisions,
  };
}
