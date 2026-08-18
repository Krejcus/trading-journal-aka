import { beforeEach, describe, expect, it } from 'vitest';
import {
  beginTradovateApiRequest,
  finishTradovateApiRequest,
  getTradovateApiTelemetrySnapshot,
  refreshTradovateApiTelemetry,
  resetTradovateApiTelemetryForTests,
} from '../lib/tradovateApiTelemetry';

describe('Tradovate API telemetry', () => {
  beforeEach(resetTradovateApiTelemetryForTests);

  it('counts rolling request, failure and rate-limit windows', () => {
    const start = Date.UTC(2026, 7, 16, 10, 0, 0);
    const first = beginTradovateApiRequest(start);
    finishTradovateApiRequest(first, 200, null, start + 20);
    const second = beginTradovateApiRequest(start + 30_000);
    finishTradovateApiRequest(second, 429, 60_000, start + 30_020);

    expect(getTradovateApiTelemetrySnapshot()).toMatchObject({
      minute: { requests: 2, failures: 1, rateLimited: 1 },
      hour: { requests: 2, failures: 1, rateLimited: 1 },
      day: { requests: 2, failures: 1, rateLimited: 1 },
      inFlight: 0,
      lastStatus: 429,
      rateLimitedUntil: start + 90_020,
    });
  });

  it('keeps only requests inside each rolling window', () => {
    const start = Date.UTC(2026, 7, 16, 10, 0, 0);
    const old = beginTradovateApiRequest(start);
    finishTradovateApiRequest(old, 200, null, start);
    const recent = beginTradovateApiRequest(start + 61_000);
    finishTradovateApiRequest(recent, 200, null, start + 61_000);

    expect(getTradovateApiTelemetrySnapshot().minute.requests).toBe(1);
    expect(getTradovateApiTelemetrySnapshot().hour.requests).toBe(2);
    refreshTradovateApiTelemetry(start + 62 * 60_000);
    expect(getTradovateApiTelemetrySnapshot().minute.requests).toBe(0);
    expect(getTradovateApiTelemetrySnapshot().hour.requests).toBe(0);
    expect(getTradovateApiTelemetrySnapshot().day.requests).toBe(2);
  });

  it('counts transport failures that have no HTTP status', () => {
    const start = Date.UTC(2026, 7, 16, 10, 0, 0);
    const request = beginTradovateApiRequest(start);
    finishTradovateApiRequest(request, 0, null, start + 50);
    expect(getTradovateApiTelemetrySnapshot().minute).toMatchObject({ requests: 1, failures: 1 });
  });
});
