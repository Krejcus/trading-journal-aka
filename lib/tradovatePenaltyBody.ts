/** A broker penalty body is optional evidence; a stalled body cannot hold inspection forever. */
export async function readTradovatePenaltyBody(response: Response, options: {
  timeoutMs?: number; setTimeoutImpl?: typeof setTimeout; clearTimeoutImpl?: typeof clearTimeout;
} = {}): Promise<unknown> {
  const schedule = options.setTimeoutImpl ?? setTimeout, clear = options.clearTimeoutImpl ?? clearTimeout;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const body = response.clone().json().catch(() => null);
    const expired = new Promise<null>(resolve => { timer = schedule(() => resolve(null), options.timeoutMs ?? 3_000); });
    return await Promise.race([body, expired]);
  } catch { return null; }
  finally { if (timer) clear(timer); }
}
