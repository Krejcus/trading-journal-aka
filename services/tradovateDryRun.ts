import type { BrokerOrderRequest } from './brokerPort';
import { TRADOVATE_HOSTS } from './tradovateMapping';
import type { BrokerEnvironment } from './brokerPort';
import { TradovateRateLimitError, TradovateTransportError } from './tradovateBroker';

export interface TradovateDryRunResult {
  accepted: boolean;
  rejectReason: string | null;
  raw: unknown;
}

/** Ověří payload přes Tradovate /order/dryrun. Nikdy nevolá placeorder. */
export async function dryRunTradovateOrder(options: {
  environment: BrokerEnvironment;
  accessToken: string;
  order: BrokerOrderRequest;
  fetchImpl?: typeof fetch;
}): Promise<TradovateDryRunResult> {
  if (options.environment !== 'demo') {
    throw new TradovateTransportError('Copier pilot dry-run je povolen pouze v demo prostředí');
  }
  const fetchImpl = options.fetchImpl ?? fetch;
  const headers = {
    Accept: 'application/json',
    Authorization: `Bearer ${options.accessToken.trim()}`,
    'Content-Type': 'application/json',
  };
  const contractResponse = await fetchImpl(
    `${TRADOVATE_HOSTS.demo.rest}/contract/find?name=${encodeURIComponent(options.order.symbol)}`,
    { method: 'GET', headers, signal: AbortSignal.timeout(10_000) },
  );
  const contractRaw = await parseResponse(contractResponse, 'contract lookup');
  const contract = contractRaw && typeof contractRaw === 'object'
    ? contractRaw as Record<string, unknown>
    : {};
  if (!Number.isSafeInteger(contract.id) || Number(contract.id) <= 0) {
    throw new TradovateTransportError(`Tradovate nenalezlo kontrakt ${options.order.symbol}`);
  }
  const response = await fetchImpl(`${TRADOVATE_HOSTS.demo.rest}/order/dryrun`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      accountId: options.order.accountId,
      orders: [{
        contractId: Number(contract.id),
        action: options.order.side,
        orderQty: options.order.quantity,
        orderType: options.order.orderType,
        ...(options.order.limitPrice != null ? { price: options.order.limitPrice } : {}),
        ...(options.order.stopPrice != null ? { stopPrice: options.order.stopPrice } : {}),
        isAutomated: true,
      }],
    }),
    signal: AbortSignal.timeout(10_000),
  });
  const payload = await parseResponse(response, 'dry-run');
  const record = payload && typeof payload === 'object' ? payload as Record<string, unknown> : {};
  const rejectReason = typeof record.rejectReason === 'string' ? record.rejectReason.trim() : '';
  const reason = rejectReason && rejectReason !== 'Success'
    ? [record.comment, record.errorText, rejectReason]
      .find(value => typeof value === 'string' && value.trim()) as string
    : typeof record.errorText === 'string' && record.errorText.trim()
      ? record.errorText.trim()
      : null;
  return { accepted: reason == null, rejectReason: reason, raw: payload };
}

async function parseResponse(response: Response, operation: string): Promise<unknown> {
  const text = await response.text();
  if (response.status === 423 || response.status === 429) {
    throw new TradovateRateLimitError(
      `Tradovate ${operation} rate limited (${response.status})`,
      response.status === 429 ? 60 * 60 * 1_000 : null,
      response.status === 429,
      undefined,
      response.status,
    );
  }
  if (!response.ok) {
    throw new TradovateTransportError(
      `Tradovate ${operation} failed (${response.status}): ${text.slice(0, 300)}`,
      response.status,
    );
  }
  let parsed: unknown;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    throw new TradovateTransportError(`Tradovate ${operation} returned malformed JSON`);
  }
  const record = parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : {};
  if (typeof record['p-ticket'] === 'string') {
    throw new TradovateRateLimitError(
      typeof record['p-message'] === 'string' ? record['p-message'] : `Tradovate ${operation} returned a penalty ticket`,
      Number.isFinite(record['p-time']) ? Number(record['p-time']) * 1_000 : null,
      record['p-captcha'] === true,
      record['p-ticket'],
    );
  }
  return parsed;
}
