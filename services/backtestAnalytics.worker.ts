import { createBacktestAnalyticsWorkerRuntime } from './backtestAnalyticsWorkerRuntime';
import type { BacktestAnalyticsWorkerRequest, BacktestAnalyticsWorkerResponse } from './backtestAnalyticsWorkerProtocol';
const runtime = createBacktestAnalyticsWorkerRuntime();
const port = globalThis as unknown as {
  onmessage: ((event: MessageEvent<BacktestAnalyticsWorkerRequest>) => void) | null;
  postMessage(message: BacktestAnalyticsWorkerResponse): void;
};
port.onmessage = event => {
  const result = runtime.handle(event.data);
  if (result) port.postMessage(result);
};
