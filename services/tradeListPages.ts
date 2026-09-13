/** Advance by actual unique IDs and require the final empty page. Asking for a
 * larger range cannot override PostgREST's configured response row cap. */
export async function readTradeListPages<T extends { id: string; user_id: string }>(
  ownerId: string, readPage: (after: string | null, limit: number) => Promise<T[]>,
  stillCurrent: () => boolean | Promise<boolean>,
) {
  const rows: T[]=[];
  let after: string | null=null;
  for (;;) {
    if (!await stillCurrent()) throw new Error('trade-list-session-changed');
    const page=await readPage(after,250);
    if (!await stillCurrent()) throw new Error('trade-list-session-changed');
    if (!Array.isArray(page) || page.length>250) throw new Error('trade-list-incomplete');
    if (!page.length) return rows;
    for (const row of page) {
      if (!row || typeof row.id!=='string' || !row.id || row.user_id!==ownerId || (after!==null && row.id<=after)) throw new Error('trade-list-incomplete');
      after=row.id; rows.push(row);
    }
    if (rows.length>100_000) throw new Error('trade-list-too-large');
  }
}
