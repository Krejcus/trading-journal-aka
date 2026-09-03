import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createMacCopierDeviceTokenProvider,
  loadMacCopierDevice,
} from '../../server/macCopierDevice';
import { loadMacCopierConnectionManifest } from '../../server/macCopierConnectionManifest';

/**
 * Read-only capability probe for Tradovate risk entities.
 *
 * Safety properties:
 * - every broker request is GET-only and passes an exact path/query allowlist;
 * - no order, position, copier-runtime, worker or direct database operation is present;
 * - tokens are used only in Authorization headers and never enter output objects;
 * - responses are reduced to an explicit field allowlist before they are logged.
 */

const DEMO_API_BASE_URL = 'https://demo.tradovateapi.com/v1';
const DEFAULT_MANIFEST_PATH = resolve(
  homedir(),
  'Library/Application Support/AlphaTrade/copier/connections.json',
);
const REQUEST_PAUSE_MS = 250;
const REQUEST_TIMEOUT_MS = 10_000;

const NO_QUERY_PATHS = new Set([
  '/account/list',
  '/accountRiskStatus/list',
  '/auth/me',
  '/marketDataSubscription/list',
  '/permission/list',
  '/tradingPermission/list',
  '/user/list',
  '/userAccountAutoLiq/list',
  '/userAccountPositionLimit/list',
  '/userAccountRiskParameter/list',
  '/userPlugin/list',
]);

const MASTER_ID_PATHS = new Set([
  '/accountRiskStatus/deps',
  '/userAccountAutoLiq/deps',
  '/userAccountPositionLimit/deps',
  '/userAccountRiskParameter/deps',
]);

const FORBIDDEN_OPERATION = /\/(?:create|update|delete|item|placeorder|placeoco|placeoso|cancelorder|modifyorder|liquidateposition|liquidatepositions)$/i;

export function assertReadOnlyTradovatePath(path: string): void {
  if (!path.startsWith('/') || path.startsWith('//')) throw new Error(`risk-probe-path-denied:${path}`);
  const parsed = new URL(path, 'https://read-only.invalid');
  if (parsed.origin !== 'https://read-only.invalid' || parsed.hash || FORBIDDEN_OPERATION.test(parsed.pathname)) {
    throw new Error(`risk-probe-path-denied:${path}`);
  }
  if (NO_QUERY_PATHS.has(parsed.pathname)) {
    if (parsed.search) throw new Error(`risk-probe-query-denied:${path}`);
    return;
  }
  if (MASTER_ID_PATHS.has(parsed.pathname)) {
    if ([...parsed.searchParams.keys()].some(key => key !== 'masterid')) {
      throw new Error(`risk-probe-query-denied:${path}`);
    }
    const values = parsed.searchParams.getAll('masterid');
    if (values.length !== 1 || !/^[1-9]\d*$/.test(values[0])) {
      throw new Error(`risk-probe-query-denied:${path}`);
    }
    return;
  }
  throw new Error(`risk-probe-path-denied:${path}`);
}

interface HttpProbe {
  path: string;
  httpStatus: number | null;
  ok: boolean;
  value: unknown;
  error: string | null;
}

export async function readOnlyTradovateGet(options: {
  baseUrl: string;
  path: string;
  accessToken: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}): Promise<HttpProbe> {
  assertReadOnlyTradovatePath(options.path);
  if (options.baseUrl !== DEMO_API_BASE_URL) {
    throw new Error(`risk-probe-host-denied:${safeText(options.baseUrl, 80)}`);
  }
  const fetchImpl = options.fetchImpl ?? fetch;
  try {
    const response = await fetchImpl(`${options.baseUrl}${options.path}`, {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${options.accessToken}`,
      },
      signal: AbortSignal.timeout(options.timeoutMs ?? REQUEST_TIMEOUT_MS),
    });
    const value = await response.json().catch(() => null) as unknown;
    return {
      path: options.path,
      httpStatus: response.status,
      ok: response.ok,
      value,
      error: response.ok ? null : safeApiError(value),
    };
  } catch (error) {
    return {
      path: options.path,
      httpStatus: null,
      ok: false,
      value: null,
      error: error instanceof Error ? `transport-${safeText(error.name, 40)}` : 'transport-error',
    };
  }
}

type SafeScalar = string | number | boolean | null;
type SafeRecord = Record<string, SafeScalar | SafeScalar[]>;

const ACCOUNT_FIELDS = [
  'id', 'name', 'active', 'restricted', 'closed', 'readonly', 'futuresDisabled',
  'accountType', 'riskCategoryId', 'autoLiqProfileId', 'evaluationSize',
] as const;
const AUTO_LIQ_FIELDS = [
  'id', 'accountId', 'userAccountId', 'changesLocked', 'marginPercentageAlert',
  'dailyLossPercentageAlert', 'dailyLossAlert', 'marginPercentageLiqOnly',
  'dailyLossPercentageLiqOnly', 'dailyLossLiqOnly', 'marginPercentageAutoLiq',
  'dailyLossPercentageAutoLiq', 'dailyLossAutoLiq', 'weeklyLossAutoLiq',
  'flattenTimestamp', 'trailingMaxDrawdown', 'trailingMaxDrawdownLimit',
  'trailingMaxDrawdownMode', 'dailyProfitAutoLiq', 'weeklyProfitAutoLiq',
  'doNotUnlock',
] as const;
const POSITION_LIMIT_FIELDS = [
  'id', 'accountId', 'contractId', 'productId', 'exchangeId', 'productType',
  'riskDiscountContractGroupId', 'productVerificationStatus', 'contractGroupId',
  'active', 'riskTimePeriodId', 'totalBy', 'shortLimit', 'longLimit',
  'exposedLimit', 'description',
] as const;
const RISK_PARAMETER_FIELDS = [
  'id', 'userAccountPositionLimitId', 'contractId', 'productId', 'exchangeId',
  'productType', 'riskDiscountContractGroupId', 'productVerificationStatus',
  'contractGroupId', 'fungibleProductId', 'maxOpeningOrderQty',
  'maxClosingOrderQty', 'fungibleMaxOpeningOrderQty', 'fungibleMaxClosingOrderQty',
  'maxBackMonth', 'preExpirationDays', 'marginPercentage', 'marginDollarValue',
  'hardLimit',
] as const;
const RISK_STATUS_FIELDS = [
  'id', 'accountId', 'adminAction', 'adminTimestamp', 'liquidateOnly',
  'userTriggeredLiqOnly', 'maxNetLiq', 'minNetLiq',
] as const;
const MARKET_DATA_FIELDS = [
  'id', 'userId', 'marketDataSubscriptionPlanId', 'year', 'month', 'startTimestamp',
  'expirationTimestamp', 'professional', 'expired', 'status',
] as const;
const PERMISSION_FIELDS = [
  'id', 'userId', 'accountId', 'status', 'updated', 'approvedById',
] as const;
const USER_PLUGIN_FIELDS = [
  'id', 'userId', 'pluginId', 'entitlementId', 'startTimestamp',
  'expirationTimestamp', 'autorenewal', 'active', 'status',
] as const;

const safeText = (value: unknown, maxLength = 160): string => String(value ?? '')
  .replace(/[\u0000-\u001f\u007f]/g, ' ')
  .replace(/\s+/g, ' ')
  .trim()
  .slice(0, maxLength);

const safeApiError = (value: unknown): string => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return 'http-error';
  const body = value as Record<string, unknown>;
  return safeText(body.errorCode ?? body.errorText ?? body.message ?? 'http-error');
};

const isSafeScalar = (value: unknown): value is SafeScalar => (
  value == null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'
);

const pickFields = (value: unknown, fields: readonly string[]): SafeRecord => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const source = value as Record<string, unknown>;
  const output: SafeRecord = {};
  for (const field of fields) {
    const candidate = source[field];
    if (isSafeScalar(candidate)) output[field] = typeof candidate === 'string' ? safeText(candidate) : candidate;
    else if (Array.isArray(candidate) && candidate.every(isSafeScalar)) {
      output[field] = candidate.slice(0, 50).map(item => typeof item === 'string' ? safeText(item) : item);
    }
  }
  return output;
};

const list = (value: unknown): unknown[] => Array.isArray(value) ? value : [];

interface SafeHttpSummary {
  path: string;
  httpStatus: number | null;
  ok: boolean;
  count: number | null;
  records: SafeRecord[];
  error: string | null;
}

const summarize = (
  probe: HttpProbe,
  fields: readonly string[],
  options: { omitRecords?: boolean } = {},
): SafeHttpSummary => ({
  path: probe.path,
  httpStatus: probe.httpStatus,
  ok: probe.ok,
  count: Array.isArray(probe.value) ? probe.value.length : probe.value == null ? null : 1,
  records: options.omitRecords ? [] : list(probe.value).map(value => pickFields(value, fields)),
  error: probe.error,
});

const summarizeAutoLiq = (probe: HttpProbe): SafeHttpSummary => {
  const summary = summarize(probe, AUTO_LIQ_FIELDS);
  return {
    ...summary,
    records: summary.records.map(record => ({
      ...record,
      changesLocked: Object.hasOwn(record, 'changesLocked') ? record.changesLocked : null,
    })),
  };
};

const summarizeAuthMe = (probe: HttpProbe): SafeHttpSummary => ({
  path: probe.path,
  httpStatus: probe.httpStatus,
  ok: probe.ok,
  count: probe.value == null ? null : 1,
  records: probe.ok ? [{
    authenticated: true,
    ...pickFields(probe.value, [
      'userStatus', 'hasLive', 'hasFunded', 'hasMarketData', 'emailVerified', 'isTrial',
      'organizationName', 'currentAccountPlan', 'currentMDSubs', 'activePlugins',
    ]),
  }] : [],
  error: probe.error,
});

const inferFirm = (accountName: unknown): string => {
  const normalized = safeText(accountName, 80).toUpperCase();
  if (/^(?:F?TDFY)/.test(normalized)) return 'Tradeify';
  if (/^(?:LFE|LFF|LTT)/.test(normalized) || normalized.includes('LUCID')) return 'Lucid';
  return 'Unknown/demo';
};

const positiveId = (value: unknown): number | null => {
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
};

const sleep = (ms: number): Promise<void> => new Promise(resolveSleep => setTimeout(resolveSleep, ms));

interface AccountProbeResult {
  account: SafeRecord & { firm: string };
  riskStatus: SafeHttpSummary;
  autoLiq: SafeHttpSummary;
  positionLimits: SafeHttpSummary;
  riskParametersByPositionLimit: SafeHttpSummary[];
}

interface ConnectionProbeResult {
  connection: string;
  environment: 'demo';
  tokenIntrospection: SafeHttpSummary;
  accountsList: SafeHttpSummary;
  globalEntities: Record<string, SafeHttpSummary>;
  accounts: AccountProbeResult[];
}

const callWithPause = async (
  accessToken: string,
  path: string,
  pause = true,
): Promise<HttpProbe> => {
  const result = await readOnlyTradovateGet({
    baseUrl: DEMO_API_BASE_URL,
    path,
    accessToken,
  });
  if (pause) await sleep(REQUEST_PAUSE_MS);
  return result;
};

async function probeConnection(
  connectionId: string,
  deviceConfigPath: string,
): Promise<ConnectionProbeResult> {
  const config = await loadMacCopierDevice(deviceConfigPath);
  if (config.connectionId !== connectionId) throw new Error('connection-device-mismatch');
  const token = await createMacCopierDeviceTokenProvider({ config }).getAccessToken();

  const tokenIntrospection = summarizeAuthMe(await callWithPause(token, '/auth/me'));
  const accountsProbe = await callWithPause(token, '/account/list');
  const accountRecords = list(accountsProbe.value);
  const accountsList = summarize(accountsProbe, ACCOUNT_FIELDS);

  const globalDefinitions = [
    ['accountRiskStatus', '/accountRiskStatus/list', RISK_STATUS_FIELDS],
    ['userAccountAutoLiq', '/userAccountAutoLiq/list', AUTO_LIQ_FIELDS],
    ['userAccountPositionLimit', '/userAccountPositionLimit/list', POSITION_LIMIT_FIELDS],
    ['userAccountRiskParameter', '/userAccountRiskParameter/list', RISK_PARAMETER_FIELDS],
    ['permission', '/permission/list', PERMISSION_FIELDS],
    ['tradingPermission', '/tradingPermission/list', PERMISSION_FIELDS],
    ['userPlugin', '/userPlugin/list', USER_PLUGIN_FIELDS],
    ['user', '/user/list', []],
    ['marketDataSubscription', '/marketDataSubscription/list', MARKET_DATA_FIELDS],
  ] as const;
  const globalEntities: Record<string, SafeHttpSummary> = {};
  for (const [label, path, fields] of globalDefinitions) {
    const probe = await callWithPause(token, path);
    globalEntities[label] = label === 'userAccountAutoLiq'
      ? summarizeAutoLiq(probe)
      : summarize(probe, fields, { omitRecords: label === 'user' });
  }

  const accounts: AccountProbeResult[] = [];
  for (const accountValue of accountRecords) {
    const rawAccount = accountValue as Record<string, unknown>;
    const accountId = positiveId(rawAccount.id);
    if (!accountId) continue;
    const account = {
      ...pickFields(rawAccount, ACCOUNT_FIELDS),
      firm: inferFirm(rawAccount.name),
    };
    const riskStatus = summarize(
      await callWithPause(token, `/accountRiskStatus/deps?masterid=${accountId}`),
      RISK_STATUS_FIELDS,
    );
    const autoLiq = summarizeAutoLiq(
      await callWithPause(token, `/userAccountAutoLiq/deps?masterid=${accountId}`),
    );
    const positionLimitsProbe = await callWithPause(
      token,
      `/userAccountPositionLimit/deps?masterid=${accountId}`,
    );
    const positionLimits = summarize(positionLimitsProbe, POSITION_LIMIT_FIELDS);
    const riskParametersByPositionLimit: SafeHttpSummary[] = [];
    for (const positionLimit of list(positionLimitsProbe.value)) {
      const positionLimitId = positiveId((positionLimit as Record<string, unknown>).id);
      if (!positionLimitId) continue;
      riskParametersByPositionLimit.push(summarize(
        await callWithPause(token, `/userAccountRiskParameter/deps?masterid=${positionLimitId}`),
        RISK_PARAMETER_FIELDS,
      ));
    }
    accounts.push({ account, riskStatus, autoLiq, positionLimits, riskParametersByPositionLimit });
  }

  return {
    connection: `conn:${connectionId.slice(0, 8)}`,
    environment: 'demo',
    tokenIntrospection,
    accountsList,
    globalEntities,
    accounts,
  };
}

const parseArgs = (argv: string[]): { mode: 'dry-run' | 'confirm-read-only'; manifestPath: string } => {
  const dryRun = argv.includes('--dry-run');
  const confirmed = argv.includes('--confirm-read-only');
  if (dryRun === confirmed) {
    throw new Error('choose-exactly-one:--dry-run-or---confirm-read-only');
  }
  const manifestIndex = argv.indexOf('--manifest');
  const manifestPath = manifestIndex >= 0 ? argv[manifestIndex + 1] : DEFAULT_MANIFEST_PATH;
  if (manifestIndex >= 0 && (!manifestPath || manifestPath.startsWith('--'))) {
    throw new Error('missing---manifest-value');
  }
  const known = new Set([
    '--dry-run', '--confirm-read-only', '--manifest',
    ...(manifestIndex >= 0 && manifestPath ? [manifestPath] : []),
  ]);
  const unknown = argv.filter(value => !known.has(value));
  if (unknown.length > 0) throw new Error(`unknown-argument:${safeText(unknown[0], 80)}`);
  return { mode: dryRun ? 'dry-run' : 'confirm-read-only', manifestPath: resolve(manifestPath) };
};

const dryRunPlan = (manifest: Awaited<ReturnType<typeof loadMacCopierConnectionManifest>>) => ({
  mode: 'dry-run',
  requestsSent: 0,
  environment: 'demo',
  baseUrl: DEMO_API_BASE_URL,
  guard: 'GET-only exact allowlist; any other path/query is rejected before fetch',
  connections: manifest.connections.map((connection, index) => ({
    connection: `conn:${connection.connectionId.slice(0, 8)}`,
    order: index + 1,
    knownManifestAccountIds: connection.accountIds,
    globalGetPaths: [
      '/auth/me',
      '/account/list',
      '/accountRiskStatus/list',
      '/userAccountAutoLiq/list',
      '/userAccountPositionLimit/list',
      '/userAccountRiskParameter/list',
      '/permission/list',
      '/tradingPermission/list',
      '/userPlugin/list',
      '/user/list',
      '/marketDataSubscription/list',
    ],
    perReturnedAccountGetPaths: [
      '/accountRiskStatus/deps?masterid=<account-id>',
      '/userAccountAutoLiq/deps?masterid=<account-id>',
      '/userAccountPositionLimit/deps?masterid=<account-id>',
    ],
    perReturnedPositionLimitGetPath: '/userAccountRiskParameter/deps?masterid=<position-limit-id>',
  })),
});

export async function main(argv = process.argv.slice(2)): Promise<void> {
  const args = parseArgs(argv);
  const manifest = await loadMacCopierConnectionManifest(args.manifestPath);
  if (args.mode === 'dry-run') {
    console.log(JSON.stringify(dryRunPlan(manifest), null, 2));
    return;
  }

  const connections: ConnectionProbeResult[] = [];
  for (const connection of manifest.connections) {
    connections.push(await probeConnection(connection.connectionId, connection.deviceConfigPath));
  }
  console.log(JSON.stringify({
    generatedAt: new Date().toISOString(),
    mode: 'confirmed-read-only',
    environment: 'demo',
    requestMethod: 'GET',
    connections,
  }, null, 2));
}

const isDirectExecution = process.argv[1]
  ? fileURLToPath(import.meta.url) === resolve(process.argv[1])
  : false;

if (isDirectExecution) {
  void main().catch(error => {
    console.error(error instanceof Error ? safeText(error.message) : 'risk-limit-probe-failed');
    process.exitCode = 1;
  });
}
