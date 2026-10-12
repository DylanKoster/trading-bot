interface BrokerContract {
  conid: string | number;
  symbol: string;
  companyHeader?: string;
  description?: string;
  secType?: string;
  restricted?: boolean;
  sections?: Array<{ secType: string }>;
}

interface BrokerQuote {
  conid: string | number;
  "84"?: string;
  "86"?: string;
  "6509"?: string;
  _updated?: string | number;
}

export interface OrderInput {
  symbol: string;
  side: "BUY" | "SELL";
  quantity: number;
  limitPrice: number;
  conid?: string;
  submit?: boolean;
  confirmation?: string | true;
}

const DEFAULT_BASE_URL = "https://localhost:5000/v1/api";
const REQUEST_TIMEOUT_MS = 10000;

function getBaseUrl(
  value: string = process.env.IBKR_BASE_URL || DEFAULT_BASE_URL,
): string {
  const url = new URL(value);
  if (url.protocol !== "https:")
    throw new Error("IBKR_BASE_URL must use HTTPS");
  if (!["localhost", "127.0.0.1", "::1"].includes(url.hostname)) {
    throw new Error(
      "This adapter only supports the local IBKR Client Portal Gateway",
    );
  }
  return url.toString().replace(/\/$/, "");
}

export async function request(
  baseUrl: string,
  endpoint: string,
  options: RequestInit = {},
): Promise<any> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  let response;
  try {
    response = await fetch(`${baseUrl}${endpoint}`, {
      ...options,
      headers: {
        Accept: "application/json",
        ...(options.body ? { "Content-Type": "application/json" } : {}),
        ...options.headers,
      },
      signal: controller.signal,
    });
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError")
      throw new Error(`IBKR request timed out: ${endpoint}`);
    throw new Error(
      `Could not reach IBKR Client Portal Gateway: ${error instanceof Error ? error.message : String(error)}`,
    );
  } finally {
    clearTimeout(timeout);
  }

  const text = await response.text();
  let result;
  try {
    result = text ? JSON.parse(text) : null;
  } catch {
    throw new Error(
      `IBKR returned non-JSON content (${response.status}) for ${endpoint}`,
    );
  }
  if (!response.ok) {
    const detail = result?.error || result?.message || response.statusText;
    throw new Error(`IBKR request failed (${response.status}): ${detail}`);
  }
  if (
    result &&
    !Array.isArray(result) &&
    typeof result === "object" &&
    result.error
  ) {
    throw new Error(`IBKR rejected the request: ${result.error}`);
  }
  return result;
}

function encodeQuery(values: Record<string, string>): string {
  return new URLSearchParams(values).toString();
}

function asPositiveNumber(
  value: string | number | undefined,
  label: string,
): number {
  const parsed = Number(String(value).replaceAll(",", ""));
  if (!Number.isFinite(parsed) || parsed <= 0)
    throw new Error(`IBKR returned an invalid ${label}`);
  return parsed;
}

function resolveStock(
  matches: BrokerContract[],
  symbol: string,
  requestedConid?: string,
): BrokerContract {
  if (!Array.isArray(matches))
    throw new Error("IBKR contract search returned an invalid response");
  const upperSymbol = symbol.toUpperCase();
  const candidates = matches.filter((item) => {
    if (
      item.symbol?.toUpperCase() !== upperSymbol ||
      !item.conid ||
      item.restricted
    )
      return false;
    if (item.sections)
      return item.sections.some((section) => section.secType === "STK");
    return item.secType === "STK";
  });
  const unique = [
    ...new Map(candidates.map((item) => [String(item.conid), item])).values(),
  ];
  if (requestedConid) {
    const selected = unique.find(
      (item) => String(item.conid) === String(requestedConid),
    );
    if (!selected)
      throw new Error(
        `IBKR contract ${requestedConid} is not a matching stock contract for ${upperSymbol}`,
      );
    return selected;
  }
  if (!unique.length)
    throw new Error(
      `IBKR did not find an available stock contract for ${upperSymbol}`,
    );
  if (unique.length > 1) {
    const description = unique
      .map(
        (item) =>
          `${item.companyHeader || item.description || item.symbol} (conid ${item.conid})`,
      )
      .join("; ");
    throw new Error(
      `IBKR found multiple stock contracts for ${upperSymbol}; pass one matching --conid. Matches: ${description}`,
    );
  }
  return unique[0];
}

export async function requireAuthenticatedSession(
  baseUrl: string,
): Promise<void> {
  const status = await request(baseUrl, "/iserver/auth/status");
  if (!status?.authenticated || !status?.connected) {
    throw new Error(
      "IBKR session is not authenticated and connected. Log in through the Client Portal Gateway in a browser first.",
    );
  }
  const brokerageSession = await request(baseUrl, "/iserver/auth/ssodh/init", {
    method: "POST",
    body: JSON.stringify({ publish: true, compete: false }),
  });
  if (
    !brokerageSession?.authenticated ||
    !brokerageSession?.connected ||
    brokerageSession?.competing
  ) {
    throw new Error(
      `IBKR brokerage session is not ready${brokerageSession?.message ? `: ${brokerageSession.message}` : ""}`,
    );
  }
}

export async function getAccount(
  baseUrl: string,
): Promise<{ id: string; isPaper: boolean }> {
  const accountId = process.env.IBKR_ACCOUNT_ID;
  if (!accountId)
    throw new Error(
      "Set IBKR_ACCOUNT_ID to the account that should receive the order",
    );
  const accountResponse = await request(baseUrl, "/iserver/accounts");
  if (
    !Array.isArray(accountResponse?.accounts) ||
    !accountResponse.accounts.includes(accountId)
  ) {
    throw new Error(
      "IBKR_ACCOUNT_ID is not present in the authenticated account list",
    );
  }
  return {
    id: accountId,
    isPaper: accountResponse.isPaper === true || accountId.startsWith("DU"),
  };
}

export async function getStockContract(
  baseUrl: string,
  symbol: string,
  conid?: string,
): Promise<BrokerContract> {
  const matches = await request(
    baseUrl,
    `/iserver/secdef/search?${encodeQuery({ symbol })}`,
  );
  return resolveStock(matches, symbol, conid);
}

export async function getLiveQuote(
  baseUrl: string,
  conid: string | number,
  side: "BUY" | "SELL",
): Promise<{
  bid: number;
  ask: number;
  referencePrice: number;
  updatedAt: string | number | null;
}> {
  const query = encodeQuery({ conids: String(conid), fields: "31,84,86,6509" });
  await request(baseUrl, `/iserver/marketdata/snapshot?${query}`); // IBKR requires a pre-flight request.
  let quote: BrokerQuote | null = null;
  for (let attempt = 0; attempt < 6; attempt += 1) {
    if (attempt) await new Promise((resolve) => setTimeout(resolve, 500));
    const snapshots = await request(
      baseUrl,
      `/iserver/marketdata/snapshot?${query}`,
    );
    quote = Array.isArray(snapshots)
      ? snapshots.find((item) => Number(item.conid) === Number(conid))
      : null;
    const price = quote?.[side === "BUY" ? "86" : "84"];
    if (price && quote?.["6509"]) break;
  }
  if (!quote) throw new Error("IBKR did not return a market data snapshot");
  if (String(quote["6509"])[0] !== "R") {
    throw new Error(
      `IBKR quote is not real-time (market data status: ${quote["6509"] || "unknown"}); order not submitted`,
    );
  }
  const quoteAgeMs = Date.now() - Number(quote._updated);
  if (!Number.isFinite(quoteAgeMs) || quoteAgeMs < 0 || quoteAgeMs > 15000) {
    throw new Error(
      "IBKR quote is missing or older than 15 seconds; order not submitted",
    );
  }
  const bid = asPositiveNumber(quote["84"], "bid");
  const ask = asPositiveNumber(quote["86"], "ask");
  return {
    bid,
    ask,
    referencePrice: side === "BUY" ? ask : bid,
    updatedAt: quote._updated || null,
  };
}

export async function ensureSellIsCovered(
  baseUrl: string,
  accountId: string,
  conid: string | number,
  quantity: number,
): Promise<void> {
  const positions = await request(
    baseUrl,
    `/portfolio/${encodeURIComponent(accountId)}/positions/0`,
  );
  if (!Array.isArray(positions))
    throw new Error("IBKR returned an invalid positions response");
  const position = positions.find(
    (item) => Number(item.conid) === Number(conid),
  );
  const sharesHeld = Number(position?.position || 0);
  if (sharesHeld < quantity) {
    throw new Error(
      `Sell rejected locally: account holds ${sharesHeld} shares, requested ${quantity}; short sales are disabled`,
    );
  }
}

function formatNumber(value: number): string {
  return Number(value).toString();
}

function expectedConfirmation(
  order: Pick<OrderInput, "symbol" | "side" | "quantity" | "limitPrice">,
): string {
  return `SUBMIT ${order.symbol} ${order.side} ${formatNumber(order.quantity)} LMT ${formatNumber(order.limitPrice)}`;
}

function buildOrder(
  order: OrderInput,
  conid: string | number,
): Record<string, string | number | boolean> {
  return {
    conid: Number(conid),
    orderType: "LMT",
    price: order.limitPrice,
    side: order.side,
    tif: "DAY",
    quantity: order.quantity,
    outsideRTH: false,
  };
}

async function placeOrder({
  symbol,
  side,
  quantity,
  limitPrice,
  conid,
  submit = false,
  confirmation,
}: OrderInput): Promise<Record<string, any>> {
  if (submit && process.env.LIVE_TRADING_ENABLED !== "true") {
    throw new Error(
      "Live submission is disabled. Set LIVE_TRADING_ENABLED=true to enable the live-order kill switch.",
    );
  }
  const baseUrl = getBaseUrl();
  await requireAuthenticatedSession(baseUrl);
  const account = await getAccount(baseUrl);
  const accountId = account.id;
  if (submit && account.isPaper) {
    throw new Error(
      "The selected account appears to be an IBKR paper account (DU...). Live submission stopped.",
    );
  }

  const contract = await getStockContract(baseUrl, symbol, conid);
  const quote = await getLiveQuote(baseUrl, contract.conid, side);
  if (side === "SELL")
    await ensureSellIsCovered(baseUrl, accountId, contract.conid, quantity);

  const order = { symbol, side, quantity, limitPrice };
  const orderPayload = { orders: [buildOrder(order, contract.conid)] };
  const notional = quantity * limitPrice;
  const maxNotional = Number(process.env.LIVE_MAX_ORDER_NOTIONAL || 1000);
  if (!Number.isFinite(maxNotional) || maxNotional <= 0) {
    throw new Error("LIVE_MAX_ORDER_NOTIONAL must be a positive number");
  }
  if (notional > maxNotional) {
    throw new Error(
      `Order notional ${notional.toFixed(2)} exceeds LIVE_MAX_ORDER_NOTIONAL (${maxNotional.toFixed(2)} in the contract's quote currency)`,
    );
  }

  const preview = await request(
    baseUrl,
    `/iserver/account/${encodeURIComponent(accountId)}/orders/whatif`,
    { method: "POST", body: JSON.stringify(orderPayload) },
  );
  const summary = {
    mode: submit ? "live submission requested" : "what-if preview only",
    symbol,
    side,
    quantity,
    limitPrice,
    notional,
    accountId,
    contract: contract.companyHeader || contract.description || symbol,
    quote,
    preview,
  };
  if (!submit) return summary;
  const previewItems = Array.isArray(preview) ? preview : [preview];
  if (previewItems.some((item) => item?.error)) {
    throw new Error(
      `IBKR what-if rejected the order: ${previewItems
        .map((item) => item.error)
        .filter(Boolean)
        .join("; ")}`,
    );
  }
  if (previewItems.some((item) => item?.warn)) {
    return {
      ...summary,
      submission:
        "blocked because IBKR returned a what-if warning; review the broker warning and submit manually if appropriate",
    };
  }
  if (confirmation !== expectedConfirmation(order)) {
    throw new Error(
      `Live submission requires --confirm-live-order "${expectedConfirmation(order)}". The order was previewed but not submitted.`,
    );
  }

  let submitted;
  try {
    submitted = await request(
      baseUrl,
      `/iserver/account/${encodeURIComponent(accountId)}/orders`,
      { method: "POST", body: JSON.stringify(orderPayload) },
    );
  } catch (error) {
    throw new Error(
      `IBKR submission status is unknown; inspect the account's open orders before retrying. ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const items = Array.isArray(submitted) ? submitted : [submitted];
  if (items.some((item) => item?.id && Array.isArray(item.message))) {
    return {
      ...summary,
      submission:
        "IBKR requires order-warning confirmation. This adapter does not auto-accept warnings; review them in IBKR and confirm manually.",
      brokerResponse: submitted,
    };
  }
  if (items.some((item) => item?.error)) {
    throw new Error(
      `IBKR rejected the order: ${items
        .map((item) => item.error)
        .filter(Boolean)
        .join("; ")}`,
    );
  }
  return { ...summary, submission: "sent to IBKR", brokerResponse: submitted };
}

export { expectedConfirmation, getBaseUrl, placeOrder };
