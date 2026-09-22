import type { Trade } from '../types';
import { journalReviewOnly } from '../lib/journalReviewPatch';
import { explicitTradeMaster, isCombinedTrade } from '../lib/tradeHistoryPresentation';
import { pickCopierThumbSnapshot, prefetchCopierThumbUrls, type CopierThumbCandidate } from './copierSnapshotThumbs';

// Verify a full rapid-navigation runway in one database snapshot, but download
// only four hero/detail images up front so large TradingView PNGs do not compete.
const MAX_THUMBS = 4;
const MAX_DETAIL_SELECTIONS = 12;
const MAX_DETAIL_ROWS = 96;
const MAX_DETAIL_MEDIA = 4;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface WarmupDependencies {
  signSnapshots: Parameters<typeof prefetchCopierThumbUrls>[2];
  decodeImage: (url: string) => Promise<void>;
  markImageLoaded: (tradeId: string) => void;
  loadJournalDetails: (ids: readonly string[], signal?: AbortSignal) => Promise<Trade[]>;
  loadJournalDetailSelections?: (
    selections: readonly (readonly string[])[],
    signal?: AbortSignal,
  ) => Promise<Map<string, Trade[]>>;
  signal?: AbortSignal;
  isCurrent?: () => boolean;
}

export interface JournalDetailWarmupDependencies {
  signSnapshots: WarmupDependencies['signSnapshots'];
  decodeImage: WarmupDependencies['decodeImage'];
  loadJournalDetails: WarmupDependencies['loadJournalDetails'];
  signal?: AbortSignal;
}

export interface PreparedJournalTradeDetail {
  tradeId: string;
  rows: Trade[];
  signedCopierSnapshots: Awaited<ReturnType<JournalDetailWarmupDependencies['signSnapshots']>>;
}

export interface TradeHistoryWarmupResult {
  thumbCandidates: number;
  decodedThumbs: number;
  detailSelections: number;
}

/**
 * Advances the user's intended History position independently of React's
 * render cadence. Repeated key events can therefore accumulate immediately
 * instead of all reading the same stale selectedTradeIndex.
 */
export function advanceTradeHistoryIndex(
  currentIndex: number,
  offset: -1 | 1,
  tradeCount: number,
): number | null {
  const targetIndex = currentIndex + offset;
  return targetIndex >= 0 && targetIndex < tradeCount ? targetIndex : null;
}

/**
 * The first modal render has no known navigation direction, so it warms four
 * steps on both sides. Once the user moves, spend the same network budget on
 * a longer runway in that direction while retaining two fast steps back.
 */
export function navigationWarmOffsets(direction: -1 | 1 | null): number[] {
  if (direction == null) return [-1, 1, -2, 2, -3, 3, -4, 4];
  return [
    direction,
    -direction,
    2 * direction,
    3 * direction,
    4 * direction,
    5 * direction,
    6 * direction,
    7 * direction,
    8 * direction,
    -2 * direction,
  ];
}

const journalSelections = (trades: readonly Trade[]): Array<{ trade: Trade; ids: string[] }> => {
  const result: Array<{ trade: Trade; ids: string[] }> = [];
  const seen = new Set<string>();
  let rowCount = 0;
  for (const trade of trades) {
    if (!journalReviewOnly(trade) || result.length >= MAX_DETAIL_SELECTIONS) continue;
    const ids = (isCombinedTrade(trade) ? trade.combinedTradeIds?.map(String) ?? [] : [String(trade.id)])
      .filter(id => UUID.test(id));
    if (ids.length === 0 || new Set(ids).size !== ids.length || rowCount + ids.length > MAX_DETAIL_ROWS) continue;
    const key = JSON.stringify(ids);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push({ trade, ids });
    rowCount += ids.length;
  }
  return result;
};

const journalDetailIds = (trade: Trade): string[] => (
  isCombinedTrade(trade) ? trade.combinedTradeIds?.map(String) ?? [] : [String(trade.id)]
);

/** Warms the complete next/previous journal detail before the modal switches:
 * verified rows, private signed media URLs and decoded pixels. */
export async function warmJournalTradeDetail(
  trade: Trade,
  deps: JournalDetailWarmupDependencies,
): Promise<PreparedJournalTradeDetail | null> {
  if (!journalReviewOnly(trade)) return null;
  const ids = journalDetailIds(trade);
  if (ids.length === 0 || deps.signal?.aborted) return null;
  const rows = await deps.loadJournalDetails(ids, deps.signal);
  if (deps.signal?.aborted || rows.length === 0) return null;

  const mediaTrade = isCombinedTrade(trade)
    ? explicitTradeMaster(rows) ?? rows[0]
    : rows.find(row => String(row.id) === String(trade.id)) ?? rows[0];
  const manualImages = mediaTrade.screenshots?.length
    ? mediaTrade.screenshots
    : mediaTrade.screenshot ? [mediaTrade.screenshot] : [];
  const signed = mediaTrade.copierSnapshots?.length
    ? await deps.signSnapshots(mediaTrade.copierSnapshots)
    : [];
  if (deps.signal?.aborted) return null;
  // Array.map would otherwise pass (url, index, array). preloadDecodedImage's
  // optional second argument is its loader, so the numeric index would replace
  // the browser decoder and make every adjacent warmup fail at runtime.
  const [primaryImage, ...remainingImages] = [...manualImages, ...signed.map(snapshot => snapshot.url)];
  // Navigace potřebuje před switchem jen první skutečně zobrazený snímek.
  // Další ENTRY/EXIT snímky se dekódují na pozadí a nesmí brzdit šipku.
  if (primaryImage) await deps.decodeImage(primaryImage);
  if (deps.signal?.aborted) return null;
  for (const url of remainingImages) void deps.decodeImage(url).catch(() => undefined);
  return { tradeId: String(trade.id), rows, signedCopierSnapshots: signed };
}

/** Bounded warmup for the first History interaction. It never downloads every
 * screenshot: only recent copier thumbnails and a few verified journal details. */
export async function warmTradeHistory(
  trades: readonly Trade[],
  scope: string,
  deps: WarmupDependencies,
): Promise<TradeHistoryWarmupResult> {
  const current = () => !deps.signal?.aborted && (deps.isCurrent?.() ?? true);
  const thumbCandidates: CopierThumbCandidate[] = trades
    .filter(trade => (trade.copierSnapshots?.length ?? 0) > 0
      && !trade.screenshot && !(trade.screenshots?.length))
    .slice(0, MAX_THUMBS)
    .map(trade => ({ tradeId: String(trade.id), snapshots: trade.copierSnapshots }));
  const selections = journalSelections(trades);
  const primarySnapshots = [...new Map(selections.slice(0, MAX_DETAIL_MEDIA).flatMap(({ trade }) => {
    const primary = trade.copierSnapshots?.[0];
    const thumb = pickCopierThumbSnapshot(trade.copierSnapshots);
    return primary && primary.path !== thumb?.path ? [[primary.path, primary] as const] : [];
  })).values()];
  let decodedThumbs = 0;

  const warmThumbs = prefetchCopierThumbUrls(scope, thumbCandidates, deps.signSnapshots)
    .then(urls => Promise.allSettled([...urls].map(async ([tradeId, url]) => {
      await deps.decodeImage(url);
      if (!current()) return;
      deps.markImageLoaded(tradeId);
      decodedThumbs += 1;
    })));
  // The card prefers EXIT, while the detail opens on the first (normally ENTRY)
  // snapshot. Warm that second bounded set only after thumbnails have priority.
  const warmPrimaryMedia = warmThumbs.then(async () => {
    if (!current() || primarySnapshots.length === 0) return;
    const signed = await deps.signSnapshots(primarySnapshots);
    if (!current()) return;
    await Promise.allSettled(signed.map(snapshot => deps.decodeImage(snapshot.url)));
  });
  const warmDetails = deps.loadJournalDetailSelections
    ? deps.loadJournalDetailSelections(selections.map(({ ids }) => ids), deps.signal)
    : Promise.allSettled(selections.map(({ ids }) => deps.loadJournalDetails(ids, deps.signal)));

  await Promise.allSettled([warmPrimaryMedia, warmDetails]);
  return { thumbCandidates: thumbCandidates.length, decodedThumbs, detailSelections: selections.length };
}
