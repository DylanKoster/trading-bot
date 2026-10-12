import fs from "node:fs";
import path from "node:path";
import {
  getAccount,
  getBaseUrl,
  getLiveQuote,
  getStockContract,
  request,
  requireAuthenticatedSession,
} from "./ibkr";
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
}

export interface AutoOptions {
  symbol: string;
  equity: number;
  config: AutoConfig;
  conid?: string;
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
  conid: string;
  lastProcessedBar: string | null;
  position: AutoPosition | null;
  inFlight: string | null;
  exitOrderId?: string | null;
}

interface HistoryBar {
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
  v?: number;
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
  conid: string,
): AutoState {
  if (!fs.existsSync(filePath))
    return {
      accountId,
      conid,
      lastProcessedBar: null,
      position: null,
      inFlight: null,
    };
  const state = JSON.parse(fs.readFileSync(filePath, "utf8")) as AutoState;
  if (state.accountId !== accountId || String(state.conid) !== String(conid)) {
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
  baseUrl: string,
  conid: string | number,
): Promise<Bar[]> {
  const query = new URLSearchParams({
    conid: String(conid),
    period: "2y",
    bar: "1d",
    outsideRth: "false",
  });
  const response = await request(
    baseUrl,
    `/iserver/marketdata/history?${query}`,
  );
  if (!Array.isArray(response?.data))
    throw new Error("IBKR did not return daily historical bars");
  const bars: Bar[] = (response.data as HistoryBar[])
    .map((item) => ({
      date: newYorkDate(Number(item.t)),
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
      `IBKR returned only ${uniqueBars.length} daily bars; automatic strategy requires approximately two years of history`,
    );
  const first = new Date(`${uniqueBars[0].date}T00:00:00Z`).getTime();
  const last = new Date(
    `${uniqueBars[uniqueBars.length - 1].date}T00:00:00Z`,
  ).getTime();
  if (last - first < 700 * 24 * 60 * 60 * 1000)
    throw new Error(
      "IBKR daily history spans less than two calendar years; no strategy action taken",
    );
  return uniqueBars;
}

async function getPosition(
  baseUrl: string,
  accountId: string,
  conid: string,
): Promise<number> {
  const positions = await request(
    baseUrl,
    `/portfolio/${encodeURIComponent(accountId)}/positions/0`,
  );
  if (!Array.isArray(positions))
    throw new Error("IBKR returned an invalid positions response");
  return Number(
    positions.find((item) => String(item.conid) === conid)?.position || 0,
  );
}

function checkPreview(preview: unknown): string | null {
  const items = Array.isArray(preview) ? preview : [preview];
  const errors = items.map((item: any) => item?.error).filter(Boolean);
  if (errors.length)
    throw new Error(`IBKR what-if rejected the order: ${errors.join("; ")}`);
  const warnings = items.map((item: any) => item?.warn).filter(Boolean);
  return warnings.length
    ? `IBKR what-if warning; no order submitted: ${warnings.join("; ")}`
    : null;
}

async function submitPayload(
  baseUrl: string,
  accountId: string,
  payload: Record<string, unknown>[],
): Promise<unknown> {
  try {
    return await request(
      baseUrl,
      `/iserver/account/${encodeURIComponent(accountId)}/orders`,
      {
        method: "POST",
        body: JSON.stringify({ orders: payload }),
      },
    );
  } catch (error) {
    throw new Error(
      `IBKR submission status is unknown; inspect open orders and positions before restarting. ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

async function updateStop(
  baseUrl: string,
  accountId: string,
  conid: string,
  state: AutoState,
  nextStop: number,
): Promise<void> {
  const position = state.position;
  if (!position || nextStop <= position.stopPrice || nextStop <= 0) return;
  const result = await request(
    baseUrl,
    `/iserver/account/${encodeURIComponent(accountId)}/order/${encodeURIComponent(position.stopOrderId)}`,
    {
      method: "POST",
      body: JSON.stringify({
        conid: Number(conid),
        orderType: "STP",
        price: Number(nextStop.toFixed(2)),
        side: "SELL",
        tif: "GTC",
        quantity: position.quantity,
        outsideRTH: false,
      }),
    },
  );
  const items = Array.isArray(result) ? result : [result];
  if (
    items.some(
      (item: any) => item?.error || (item?.id && Array.isArray(item?.message)),
    )
  ) {
    throw new Error(
      `IBKR stop update needs manual review; protective stop remains at ${position.stopPrice}. Response: ${JSON.stringify(result)}`,
    );
  }
  position.stopPrice = Number(nextStop.toFixed(2));
}

async function cancelStopAndConfirm(
  baseUrl: string,
  accountId: string,
  orderId: string,
): Promise<void> {
  await request(
    baseUrl,
    `/iserver/account/${encodeURIComponent(accountId)}/order/${encodeURIComponent(orderId)}`,
    { method: "DELETE" },
  );
  for (let attempt = 0; attempt < 10; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 1000));
    const status = await request(
      baseUrl,
      `/iserver/account/${encodeURIComponent(accountId)}/order/status/${encodeURIComponent(orderId)}`,
    );
    const value = String(
      status?.status || status?.order_status || "",
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
    "IBKR has not confirmed cancellation of the protective stop; strategy exit was not submitted",
  );
}

export async function runAutomaticOnce(
  options: AutoOptions,
): Promise<Record<string, unknown>> {
  const { symbol, equity, config, conid: requestedConid, submit } = options;
  if (config.assetClass !== "stock")
    throw new Error("Automatic IBKR execution supports stock configs only");
  if (!Number.isFinite(equity) || equity <= 0)
    throw new Error(
      "--equity must be a positive amount in the stock contract currency",
    );
  if (submit && process.env.LIVE_TRADING_ENABLED !== "true")
    throw new Error(
      "Set LIVE_TRADING_ENABLED=true to enable the live-order kill switch",
    );
  const baseUrl = getBaseUrl();
  await requireAuthenticatedSession(baseUrl);
  const account = await getAccount(baseUrl);
  if (submit && account.isPaper)
    throw new Error(
      "The selected account appears to be an IBKR paper account; live automatic trading stopped",
    );
  const contract = await getStockContract(baseUrl, symbol, requestedConid);
  const contractId = String(contract.conid);
  const bars = await getDailyHistory(baseUrl, contract.conid);
  const dataDir = path.resolve(options.dataDir || "data");
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(
    path.join(dataDir, `${symbol.toLowerCase()}-ibkr-daily.csv`),
    csvForBars(bars),
  );

  // Ignore today's still-forming daily candle. Signals use only completed sessions.
  const today = newYorkDate(Date.now());
  const closedBars = bars.filter((bar) => bar.date < today);
  if (closedBars.length < 40)
    throw new Error(
      "Not enough completed IBKR daily bars for the configured indicators",
    );
  const latest = closedBars[closedBars.length - 1];
  const indicators = buildIndicators(closedBars, config.indicators);
  const index = closedBars.length - 1;
  const atr = indicators.atr[index];
  const statePath = path.join(dataDir, `auto-${symbol.toLowerCase()}.json`);
  const state = loadState(statePath, account.id, contractId);
  if (state.inFlight)
    throw new Error(
      `Previous automatic action ${state.inFlight} has an unknown or incomplete outcome; reconcile IBKR orders and positions, then clear the state marker manually`,
    );
  const held = await getPosition(baseUrl, account.id, contractId);
  if (state.exitOrderId) {
    const exitOrderId = state.exitOrderId;
    const exitStatus = await request(
      baseUrl,
      `/iserver/account/${encodeURIComponent(account.id)}/order/status/${encodeURIComponent(exitOrderId)}`,
    );
    const status = String(
      exitStatus?.status || exitStatus?.order_status || "",
    ).toLowerCase();
    if (
      [
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
          `Exit order filled but IBKR still reports ${held} shares; reconcile any partial fill before restarting`,
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
      `Indicator exit order is ${status || "in an unknown state"} and its protective stop was canceled; inspect IBKR and manage the position manually`,
    );
  }
  if (held > 0 && !state.position)
    throw new Error(
      `IBKR holds ${held} ${symbol} shares, but this runner has no ownership state; refusing to manage an untracked position`,
    );
  if (held < 0)
    throw new Error(
      `IBKR reports a short ${symbol} position; this long-only runner will not manage it`,
    );
  if (state.position && held === 0) {
    const stopStatus = await request(
      baseUrl,
      `/iserver/account/${encodeURIComponent(account.id)}/order/status/${encodeURIComponent(state.position.stopOrderId)}`,
    );
    const stopState = String(
      stopStatus?.status || stopStatus?.order_status || "",
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
    const parentStatus = await request(
      baseUrl,
      `/iserver/account/${encodeURIComponent(account.id)}/order/status/${encodeURIComponent(state.position.parentOrderId)}`,
    );
    const status = String(
      parentStatus?.status || parentStatus?.order_status || "",
    ).toLowerCase();
    if (
      [
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
        "IBKR says the entry filled but the position endpoint is flat; reconcile account positions before restarting",
      );
    if (!["cancelled", "canceled", "inactive"].includes(status)) {
      throw new Error(
        `Could not reconcile pending entry order status (${status || "unknown"}); inspect IBKR before restarting`,
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
      `IBKR position is ${held} shares but automatic state tracks ${position.quantity}; reconcile manually before continuing`,
    );
  }

  if (position && exitSignal(indicators, index)) {
    const quote = await getLiveQuote(baseUrl, contract.conid, "SELL");
    const exitOrder = {
      conid: Number(contractId),
      orderType: "LMT",
      price: quote.bid,
      side: "SELL",
      tif: "DAY",
      quantity: position.quantity,
      outsideRTH: false,
    };
    const payload = [exitOrder];
    const preview = await request(
      baseUrl,
      `/iserver/account/${encodeURIComponent(account.id)}/orders/whatif`,
      { method: "POST", body: JSON.stringify({ orders: payload }) },
    );
    const warning = checkPreview(preview);
    if (warning)
      return { symbol, bar: latest.date, action: "blocked", reason: warning };
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
    await cancelStopAndConfirm(baseUrl, account.id, position.stopOrderId);
    const brokerResponse = await submitPayload(baseUrl, account.id, payload);
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
        `IBKR requires manual confirmation for the exit order; the protective stop is canceled. Inspect the account immediately: ${JSON.stringify(brokerResponse)}`,
      );
    }
    const exitOrderId = String(items[0]?.order_id || "");
    if (!exitOrderId)
      throw new Error(
        `IBKR returned no exit order ID and the protective stop is canceled; inspect the account immediately: ${JSON.stringify(brokerResponse)}`,
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
    const quote = await getLiveQuote(baseUrl, contract.conid, "SELL");
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
        await updateStop(baseUrl, account.id, contractId, state, trailingStop);
      } catch (error) {
        // Keep the recovery marker: IBKR may have applied a modify request even if the response was lost.
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

  const quote = await getLiveQuote(baseUrl, contract.conid, "BUY");
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

  const cOID = `auto-${symbol}-${Date.now()}`;
  const bracket = [
    {
      conid: Number(contractId),
      cOID,
      orderType: "LMT",
      price: quote.ask,
      side: "BUY",
      tif: "DAY",
      quantity,
      outsideRTH: false,
    },
    {
      conid: Number(contractId),
      orderType: "STP",
      price: stopPrice,
      side: "SELL",
      tif: "GTC",
      quantity,
      outsideRTH: false,
      parentId: cOID,
    },
  ];
  const preview = await request(
    baseUrl,
    `/iserver/account/${encodeURIComponent(account.id)}/orders/whatif`,
    { method: "POST", body: JSON.stringify({ orders: bracket }) },
  );
  const warning = checkPreview(preview);
  if (warning)
    return { symbol, bar: latest.date, action: "blocked", reason: warning };
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
  const brokerResponse = await submitPayload(baseUrl, account.id, bracket);
  const items = Array.isArray(brokerResponse)
    ? brokerResponse
    : [brokerResponse];
  if (
    items.some(
      (item: any) => item?.error || (item?.id && Array.isArray(item?.message)),
    )
  ) {
    throw new Error(
      `IBKR returned a warning or error for the automatic bracket; inspect broker response and open orders before restarting: ${JSON.stringify(brokerResponse)}`,
    );
  }
  const stopOrder = items.find(
    (item: any) =>
      item?.parent_order_id ||
      (item?.order_id && String(item?.order_id) !== String(items[0]?.order_id)),
  );
  const stopOrderId = String(stopOrder?.order_id || "");
  if (!stopOrderId)
    throw new Error(
      `IBKR accepted a response without a recognizable protective stop order ID; inspect open orders before restarting: ${JSON.stringify(brokerResponse)}`,
    );
  const parentOrderId = String(items[0]?.order_id || "");
  if (!parentOrderId)
    throw new Error(
      `IBKR accepted the bracket but returned no parent order ID; inspect open orders before restarting: ${JSON.stringify(brokerResponse)}`,
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
