const REQUEST_TIMEOUT_MS = 10000;
const MAX_QUOTE_FUTURE_SKEW_MS = 2000;
const DEFAULT_TRADING_URL = "https://paper-api.alpaca.markets";
const DATA_URL = "https://data.alpaca.markets";

export interface OrderInput {
  symbol: string;
  side: "BUY" | "SELL";
  quantity: number;
  limitPrice: number;
  submit?: boolean;
  confirmation?: string | true;
}

export function getBaseUrl(): string {
  const value = process.env.ALPACA_BASE_URL || DEFAULT_TRADING_URL;
  const url = new URL(value);
  if (url.protocol !== "https:") throw new Error("ALPACA_BASE_URL must use HTTPS");
  return url.toString().replace(/\/$/, "");
}

function credentials(): Record<string, string> {
  const key = process.env.ALPACA_API_KEY;
  const secret = process.env.ALPACA_SECRET_KEY;
  if (!key || !secret)
    throw new Error("Set ALPACA_API_KEY and ALPACA_SECRET_KEY for Alpaca API access");
  return { "APCA-API-KEY-ID": key, "APCA-API-SECRET-KEY": secret };
}

async function fetchJson(url: string, options: RequestInit = {}): Promise<any> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetch(url, {
      ...options,
      headers: {
        Accept: "application/json",
        ...credentials(),
        ...(options.body ? { "Content-Type": "application/json" } : {}),
        ...options.headers,
      },
      signal: controller.signal,
    });
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError")
      throw new Error(`Alpaca request timed out: ${url}`);
    throw new Error(`Could not reach Alpaca API: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    clearTimeout(timeout);
  }
  const body = await response.text();
  let result: any;
  try { result = body ? JSON.parse(body) : null; }
  catch { throw new Error(`Alpaca returned non-JSON content (${response.status})`); }
  if (!response.ok) {
    const detail = result?.message || result?.error || response.statusText;
    throw new Error(`Alpaca request failed (${response.status}): ${detail}`);
  }
  return result;
}

export function request(_baseUrl: string, endpoint: string, options: RequestInit = {}): Promise<any> {
  return fetchJson(`${getBaseUrl()}${endpoint}`, options);
}

export function dataRequest(endpoint: string): Promise<any> {
  return fetchJson(`${DATA_URL}${endpoint}`);
}

export async function getAccount(baseUrl: string): Promise<{
  id: string;
  isPaper: boolean;
  equity: number;
  buyingPower: number;
  cash: number;
}> {
  const account = await request(baseUrl, "/v2/account");
  const isPaper = new URL(baseUrl).hostname.startsWith("paper-");
  return {
    id: String(account.id),
    isPaper,
    equity: Number(account.equity),
    buyingPower: Number(account.buying_power),
    cash: Number(account.cash),
  };
}

export async function getPositions(baseUrl: string): Promise<any[]> {
  const positions = await request(baseUrl, "/v2/positions");
  if (!Array.isArray(positions)) throw new Error("Alpaca did not return account positions");
  return positions;
}

export async function getOpenOrders(baseUrl: string): Promise<any[]> {
  const orders = await request(baseUrl, "/v2/orders?status=open&limit=500");
  if (!Array.isArray(orders)) throw new Error("Alpaca did not return open orders");
  return orders;
}

export async function getStockContract(baseUrl: string, symbol: string): Promise<{ assetId: string; symbol: string; name?: string }> {
  const asset = await request(baseUrl, `/v2/assets/${encodeURIComponent(symbol.toUpperCase())}`);
  if (asset?.class !== "us_equity" || asset?.tradable !== true)
    throw new Error(`Alpaca asset ${symbol.toUpperCase()} is not a tradable US equity`);
  return { assetId: String(asset.id), symbol: String(asset.symbol), name: asset.name };
}

export async function getQuote(symbol: string, side: "BUY" | "SELL"): Promise<{ bid: number; ask: number; referencePrice: number; updatedAt: string }> {
  const result = await dataRequest(`/v2/stocks/${encodeURIComponent(symbol)}/quotes/latest?feed=iex`);
  const quote = result?.quote;
  const bid = Number(quote?.bp);
  const ask = Number(quote?.ap);
  const updatedAt = String(quote?.t || "");
  if (!Number.isFinite(bid) || bid <= 0 || !Number.isFinite(ask) || ask <= 0 || !updatedAt)
    throw new Error("Alpaca did not return a valid latest quote");
  const age = Date.now() - Date.parse(updatedAt);
  if (!Number.isFinite(age) || age < -MAX_QUOTE_FUTURE_SKEW_MS || age > 15000) {
    const ageDetail = !Number.isFinite(age)
      ? "has an invalid timestamp"
      : age < 0
        ? `is ${(Math.abs(age) / 1000).toFixed(1)} seconds ahead of the local clock`
        : `${(age / 1000).toFixed(1)} seconds old`;
    throw new Error(
      `Alpaca ${symbol.toUpperCase()} IEX quote timestamp ${updatedAt} ${ageDetail}; local UTC time is ${new Date().toISOString()}. Order not submitted.`,
    );
  }
  return { bid, ask, referencePrice: side === "BUY" ? ask : bid, updatedAt };
}

export async function getPosition(baseUrl: string, symbol: string): Promise<any | null> {
  try { return await request(baseUrl, `/v2/positions/${encodeURIComponent(symbol)}`); }
  catch (error) {
    if (error instanceof Error && error.message.includes("(404)")) return null;
    throw error;
  }
}

export async function getOrder(baseUrl: string, orderId: string): Promise<any> {
  return request(baseUrl, `/v2/orders/${encodeURIComponent(orderId)}?nested=true`);
}

export async function ensureSellIsCovered(baseUrl: string, _accountId: string, symbol: string, quantity: number): Promise<void> {
  const position = await getPosition(baseUrl, symbol);
  const sharesHeld = Number(position?.qty || 0);
  if (sharesHeld < quantity) throw new Error(`Sell rejected locally: account holds ${sharesHeld} shares, requested ${quantity}; short sales are disabled`);
}

function expectedConfirmation(order: Pick<OrderInput, "symbol" | "side" | "quantity" | "limitPrice">): string {
  return `SUBMIT ${order.symbol} ${order.side} ${order.quantity} LMT ${order.limitPrice}`;
}

export async function placeOrder({ symbol, side, quantity, limitPrice, submit = false, confirmation }: OrderInput): Promise<Record<string, any>> {
  if (submit && process.env.LIVE_TRADING_ENABLED !== "true") throw new Error("Live submission is disabled. Set LIVE_TRADING_ENABLED=true to enable the live-order kill switch.");
  const baseUrl = getBaseUrl();
  const account = await getAccount(baseUrl);
  if (submit && account.isPaper) throw new Error("ALPACA_BASE_URL points to a paper account; live submission stopped.");
  const asset = await getStockContract(baseUrl, symbol);
  const quote = await getQuote(symbol, side);
  if (side === "SELL") await ensureSellIsCovered(baseUrl, account.id, symbol, quantity);
  const notional = quantity * limitPrice;
  const maxNotional = Number(process.env.LIVE_MAX_ORDER_NOTIONAL || 1000);
  if (!Number.isFinite(maxNotional) || maxNotional <= 0) throw new Error("LIVE_MAX_ORDER_NOTIONAL must be a positive number");
  if (notional > maxNotional) throw new Error(`Order notional ${notional.toFixed(2)} exceeds LIVE_MAX_ORDER_NOTIONAL (${maxNotional.toFixed(2)} in the quote currency)`);
  const order = { symbol: asset.symbol, qty: String(quantity), side: side.toLowerCase(), type: "limit", time_in_force: "day", limit_price: String(limitPrice), extended_hours: false };
  const summary = { mode: submit ? "live submission requested" : "preview only", symbol, side, quantity, limitPrice, notional, accountId: account.id, asset: asset.name || symbol, quote, order };
  if (!submit) return summary;
  if (confirmation !== expectedConfirmation({ symbol, side, quantity, limitPrice }))
    throw new Error(`Live submission requires --confirm-live-order "${expectedConfirmation({ symbol, side, quantity, limitPrice })}". The order was validated but not submitted.`);
  let brokerResponse: any;
  try { brokerResponse = await request(baseUrl, "/v2/orders", { method: "POST", body: JSON.stringify(order) }); }
  catch (error) { throw new Error(`Alpaca submission status is unknown; inspect open orders before retrying. ${error instanceof Error ? error.message : String(error)}`); }
  return { ...summary, submission: "sent to Alpaca", brokerResponse };
}

export { expectedConfirmation };
