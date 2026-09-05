/** Publish each successful connection immediately; settlement is only for
 * scheduling/backoff, never a barrier holding a fast firm's data hostage. */
export const consumeTradovateReads = <T>(
  ids: readonly string[],
  read: (id: string) => Promise<T>,
  accept: (id: string, value: T) => void,
): Promise<PromiseSettledResult<T>[]> => Promise.allSettled(ids.map(async id => {
  const value = await read(id);
  accept(id, value);
  return value;
}));
