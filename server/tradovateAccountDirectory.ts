/** Routing identity only. This deliberately carries no balance, exposure or ARM authority. */
export async function loadTradovateAccountDirectory(options: {
  baseUrl: string; accessToken: string; fetchImpl: typeof fetch;
}): Promise<{ accounts: Array<{ id: number; name: string }> }> {
  const response = await options.fetchImpl(`${options.baseUrl.replace(/\/$/, '')}/account/list`, {
    headers: { Authorization: `Bearer ${options.accessToken}` }, redirect: 'error', signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`Tradovate account directory unavailable (${response.status})`);
  const rows: unknown = await response.json();
  if (!Array.isArray(rows) || rows.some(row => !row || !Number.isSafeInteger(row.id) || row.id <= 0
    || typeof row.name !== 'string' || !row.name.trim()) || new Set(rows.map(row => row.id)).size !== rows.length) {
    throw new Error('Tradovate account directory incomplete or ambiguous');
  }
  return { accounts: rows.map(row => ({ id: row.id, name: row.name })) };
}
