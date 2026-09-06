export type SessionRequestContext = { userId: string | null; epoch: number };

/** Capture before starting async work. The epoch also rejects logout/login back
 * into the same account, while an ordinary token refresh keeps requests valid. */
export function createSessionRequestGuard(
  expectedUserId: string,
  readContext: () => SessionRequestContext,
): () => boolean {
  const initial = readContext();
  const validAtStart = Boolean(expectedUserId) && initial.userId === expectedUserId;
  return () => {
    const current = readContext();
    return validAtStart && current.userId === expectedUserId && current.epoch === initial.epoch;
  };
}
